import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ask } from "@tauri-apps/plugin-dialog";
import * as cmd from "@/lib/commands";
import type { QuestionLink, Resource, QuestionTargetType } from "@/types";
import { MarkdownContent } from "@/components/MarkdownContent";
import styles from "./QuestionLinkItem.module.css";

interface QuestionLinkItemProps {
  link: QuestionLink;
  onOpenResource: (resource: Resource, highlightId?: string) => void;
}

interface ResolvedTarget {
  resource: Resource | null;
  /** When the link targets a highlight, the highlight's text content. */
  highlightText?: string;
  /** When the link targets a comment, the comment's text content. */
  commentText?: string;
  /** highlight_id forwarded to openResource so the reader jumps to it. */
  highlightId?: string;
}

async function resolveTarget(link: QuestionLink): Promise<ResolvedTarget> {
  // The link's target_id refers to either a resource, a highlight, or a
  // comment. Resolve to a (resource, optional snippet) pair so the UI can
  // render a meaningful row regardless of target kind. Any backend error
  // (missing target, deleted, etc.) collapses to `{ resource: null }` so the
  // UI renders the "(source unavailable)" fallback instead of erroring out.
  try {
    switch (link.target_type as QuestionTargetType) {
      case "resource": {
        const resource = await cmd.getResource(link.target_id);
        return { resource };
      }
      case "highlight": {
        const hl = await cmd.getHighlight(link.target_id);
        const resource = await cmd.getResource(hl.resource_id);
        return { resource, highlightText: hl.text_content, highlightId: hl.id };
      }
      case "comment": {
        const cm = await cmd.getComment(link.target_id);
        const resource = await cmd.getResource(cm.resource_id);
        return {
          resource,
          commentText: cm.content,
          highlightId: cm.highlight_id ?? undefined,
        };
      }
      default:
        return { resource: null };
    }
  } catch {
    return { resource: null };
  }
}

export function QuestionLinkItem({ link, onOpenResource }: QuestionLinkItemProps) {
  const { t } = useTranslation("question");
  const [resolved, setResolved] = useState<ResolvedTarget | null>(null);
  const [editingReason, setEditingReason] = useState(false);
  const [draftReason, setDraftReason] = useState(link.reason ?? "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveTarget(link).then((r) => {
      if (!cancelled) setResolved(r);
    });
    return () => {
      cancelled = true;
    };
  }, [link]);

  // Reset draft if reason changes from elsewhere (sync apply, etc).
  useEffect(() => {
    if (!editingReason) setDraftReason(link.reason ?? "");
  }, [link.reason, editingReason]);

  const handleOpen = useCallback(() => {
    if (!resolved?.resource) return;
    onOpenResource(resolved.resource, resolved.highlightId);
  }, [resolved, onOpenResource]);

  const handleSaveReason = useCallback(async () => {
    setSubmitting(true);
    try {
      const trimmed = draftReason.trim();
      await cmd.updateLinkReason(link.id, trimmed.length === 0 ? null : draftReason);
      setEditingReason(false);
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [draftReason, link.id, t]);

  const handleUnlink = useCallback(async () => {
    const ok = await ask(t("unlinkConfirm"), { title: t("removeLink"), kind: "warning" });
    if (!ok) return;
    try {
      await cmd.unlinkQuestion(link.id);
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
    }
  }, [link.id, t]);

  const targetTitle = resolved?.resource?.title ?? null;
  const snippet =
    resolved?.highlightText ??
    resolved?.commentText ??
    null;

  return (
    <div className={styles.item}>
      <div className={styles.row}>
        <div
          className={styles.target}
          onClick={handleOpen}
          role="link"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleOpen();
            }
          }}
        >
          {targetTitle === null ? (
            <span className={`${styles.targetTitle} ${styles.targetMissing}`}>
              {t("unknownTarget")}
            </span>
          ) : (
            <span className={styles.targetTitle}>{targetTitle}</span>
          )}
          <span className={styles.targetMeta}>
            {t(`linksByType.${link.target_type}` as "linksByType.resource")}
          </span>
          {snippet && <div className={styles.targetSnippet}>{snippet}</div>}
        </div>
        <div className={styles.actions}>
          <button
            className={styles.actionBtn}
            onClick={() => setEditingReason(true)}
            title={t("editReason")}
            disabled={editingReason}
          >
            ✎
          </button>
          <button
            className={styles.actionBtn}
            onClick={handleUnlink}
            title={t("removeLink")}
          >
            ×
          </button>
        </div>
      </div>

      {editingReason ? (
        <div className={styles.reasonEdit} onClick={(e) => e.stopPropagation()}>
          <textarea
            className={styles.reasonTextarea}
            value={draftReason}
            onChange={(e) => setDraftReason(e.target.value)}
            placeholder={t("reasonPlaceholder")}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setDraftReason(link.reason ?? "");
                setEditingReason(false);
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSaveReason();
              }
            }}
          />
          <div className={styles.reasonActions}>
            <button
              className={styles.reasonBtn}
              onClick={() => {
                setDraftReason(link.reason ?? "");
                setEditingReason(false);
              }}
              disabled={submitting}
            >
              {t("cancel", { ns: "common" })}
            </button>
            <button
              className={styles.reasonBtnPrimary}
              onClick={handleSaveReason}
              disabled={submitting}
            >
              {t("save", { ns: "common" })}
            </button>
          </div>
        </div>
      ) : link.reason ? (
        <div className={styles.reasonView} onClick={() => setEditingReason(true)}>
          <MarkdownContent content={link.reason} />
        </div>
      ) : (
        <div className={styles.reasonEmpty} onClick={() => setEditingReason(true)}>
          {t("reasonPlaceholder")}
        </div>
      )}
    </div>
  );
}
