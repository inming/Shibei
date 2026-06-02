import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ask } from "@tauri-apps/plugin-dialog";
import * as cmd from "@/lib/commands";
import type { QuestionLink, Resource } from "@/types";
import type { ResolvedLink, ResourceGroup } from "@/lib/questionLinks";
import { MarkdownContent } from "@/components/MarkdownContent";
import styles from "./ResourceLinkGroup.module.css";

interface Props {
  group: ResourceGroup;
  onOpenResource: (resource: Resource, highlightId?: string) => void;
}

/**
 * One resource card: header (title + counts) → the article's own link reason
 * (if directly linked) → each highlight/note nested underneath. Collapses the
 * duplication of the old flat, type-grouped list where one source could appear
 * in both the "资料" and "高亮" sections.
 */
export function ResourceLinkGroup({ group, onOpenResource }: Props) {
  const { t } = useTranslation("question");
  const { resource, resourceLink, evidence } = group;

  const openResource = useCallback(() => {
    if (resource) onOpenResource(resource);
  }, [resource, onOpenResource]);

  const highlightCount = evidence.filter((e) => e.kind === "highlight").length;
  const commentCount = evidence.filter((e) => e.kind === "comment").length;
  const badgeParts: string[] = [];
  if (highlightCount) badgeParts.push(`${highlightCount} ${t("linksByType.highlight")}`);
  if (commentCount) badgeParts.push(`${commentCount} ${t("linksByType.comment")}`);

  return (
    <div className={styles.group}>
      <div className={styles.head}>
        <div className={styles.titleWrap}>
          {resource ? (
            <span
              className={styles.title}
              onClick={openResource}
              role="link"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openResource();
                }
              }}
            >
              {resource.title}
            </span>
          ) : (
            <span className={`${styles.title} ${styles.titleMissing}`}>
              {t("unknownTarget")}
            </span>
          )}
          <div className={styles.metaRow}>
            {!resourceLink && resource && (
              <span className={styles.viaTag}>{t("linkedViaAnnotations")}</span>
            )}
            {resource?.domain && <span className={styles.domain}>{resource.domain}</span>}
            {badgeParts.length > 0 && (
              <span className={styles.badge}>{badgeParts.join(" · ")}</span>
            )}
          </div>
        </div>
      </div>

      {resourceLink && <LinkReasonBlock link={resourceLink.link} />}

      {evidence.length > 0 && (
        <div className={styles.evidenceList}>
          {evidence.map((e) => (
            <EvidenceRow key={e.link.id} resolved={e} onOpenResource={onOpenResource} />
          ))}
        </div>
      )}
    </div>
  );
}

interface EvidenceRowProps {
  resolved: ResolvedLink;
  onOpenResource: (resource: Resource, highlightId?: string) => void;
}

function EvidenceRow({ resolved, onOpenResource }: EvidenceRowProps) {
  const { t } = useTranslation("question");
  const open = useCallback(() => {
    if (resolved.resource) onOpenResource(resolved.resource, resolved.highlightId);
  }, [resolved, onOpenResource]);

  const isNote = resolved.kind === "comment";

  return (
    <div className={styles.evidence}>
      <div
        className={`${styles.evidenceMain} ${isNote ? styles.evidenceNote : styles.evidenceHighlight}`}
        onClick={open}
        role="link"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        // Let markdown links inside notes work without triggering navigation.
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest("a")) e.stopPropagation();
        }}
        style={
          !isNote && resolved.color ? { borderLeftColor: resolved.color } : undefined
        }
      >
        {resolved.snippet === null ? (
          <span className={styles.snippetMissing}>{t("unknownTarget")}</span>
        ) : isNote ? (
          <NoteSnippet content={resolved.snippet} />
        ) : (
          <div className={styles.highlightText}>{resolved.snippet}</div>
        )}
      </div>
      <LinkReasonBlock link={resolved.link} />
    </div>
  );
}

/** A note (resource-level comment): Markdown-rendered, collapsed past a few
 *  lines with a show-more/less toggle since notes tend to run long. */
function NoteSnippet({ content }: { content: string }) {
  const { t } = useTranslation("question");
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight - el.clientHeight > 4);
  }, [content, expanded]);

  return (
    <div className={styles.noteSnippet}>
      <div
        ref={ref}
        className={`${styles.noteBody} ${expanded ? "" : styles.noteCollapsed}`}
      >
        <MarkdownContent content={content} />
      </div>
      {(overflowing || expanded) && (
        <button
          className={styles.foldBtn}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? t("collapse") : t("expand")}
        </button>
      )}
    </div>
  );
}

/**
 * The per-link "why is this relevant" reason: inline view / textarea editor /
 * empty placeholder, plus edit (✎) and unlink (×) controls. Editing is entered
 * only via the ✎ button — clicking the reason text never flips it into an
 * editor, so the text stays selectable/readable. Self-contained so the same
 * block works for both a resource-level link and an evidence row.
 */
function LinkReasonBlock({ link }: { link: QuestionLink }) {
  const { t } = useTranslation("question");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(link.reason ?? "");
  const [submitting, setSubmitting] = useState(false);

  // Re-sync the draft if the reason changes elsewhere (sync apply, etc.).
  useEffect(() => {
    if (!editing) setDraft(link.reason ?? "");
  }, [link.reason, editing]);

  const handleSave = useCallback(async () => {
    setSubmitting(true);
    try {
      const trimmed = draft.trim();
      await cmd.updateLinkReason(link.id, trimmed.length === 0 ? null : draft);
      setEditing(false);
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [draft, link.id, t]);

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

  const cancel = useCallback(() => {
    setDraft(link.reason ?? "");
    setEditing(false);
  }, [link.reason]);

  return (
    <div className={styles.reasonBlock}>
      <div className={styles.reasonBody}>
        {editing ? (
          <div className={styles.reasonEdit} onClick={(e) => e.stopPropagation()}>
            <textarea
              className={styles.reasonTextarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancel();
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSave();
                }
              }}
            />
            <div className={styles.reasonActions}>
              <button className={styles.reasonBtn} onClick={cancel} disabled={submitting}>
                {t("cancel", { ns: "common" })}
              </button>
              <button
                className={styles.reasonBtnPrimary}
                onClick={handleSave}
                disabled={submitting}
              >
                {t("save", { ns: "common" })}
              </button>
            </div>
          </div>
        ) : link.reason ? (
          <div className={styles.reasonView}>
            <MarkdownContent content={link.reason} />
          </div>
        ) : (
          <div className={styles.reasonEmpty}>{t("reasonPlaceholder")}</div>
        )}
      </div>
      {!editing && (
        <div className={styles.reasonTools}>
          <button
            className={styles.actionBtn}
            onClick={() => setEditing(true)}
            title={t("editReason")}
          >
            ✎
          </button>
          <button className={styles.actionBtn} onClick={handleUnlink} title={t("removeLink")}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
