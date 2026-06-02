import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Question, Resource } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents, type QuestionChangedPayload } from "@/lib/events";
import { MarkdownContent } from "@/components/MarkdownContent";
import { QuestionEditDialog } from "@/components/Sidebar/QuestionEditDialog";
import { useResolvedQuestionLinks } from "@/hooks/useResolvedQuestionLinks";
import { buildQuestionDeepLink } from "@/lib/deepLink";
import { ResourceLinkGroup } from "./ResourceLinkGroup";
import styles from "./QuestionDetailView.module.css";

interface QuestionDetailViewProps {
  /** Initial snapshot — refreshed in-place when QUESTION_CHANGED fires. */
  question: Question;
  onOpenResource: (resource: Resource, highlightId?: string) => void;
  /**
   * Called when the question is deleted from this view. The host decides what
   * "close" means:
   *   - tab variant: close the QuestionDetail tab
   *   - preview variant: clear selectedQuestionId
   */
  onClose: () => void;
  /**
   * Visual + behavioral variant.
   *   - "tab" (default): full layout, used in dedicated QuestionDetail tabs
   *   - "preview": tighter horizontal padding, shows an "Open in Tab" affordance
   */
  variant?: "tab" | "preview";
  /**
   * Only meaningful when variant === "preview". Wired to the "Open in Tab"
   * button so the user has a discoverable alternative to double-clicking the
   * source list row.
   */
  onOpenInTab?: (question: Question) => void;
}

export function QuestionDetailView({
  question: initialQuestion,
  onOpenResource,
  onClose,
  variant = "tab",
  onOpenInTab,
}: QuestionDetailViewProps) {
  const { t } = useTranslation("question");
  const [question, setQuestion] = useState<Question>(initialQuestion);
  const { groups, totalLinks, evidenceCount, loading } = useResolvedQuestionLinks(
    question.id,
  );
  const [editorOpen, setEditorOpen] = useState(false);

  // The initialQuestion prop changes only when the parent receives a fresher
  // snapshot (sidebar re-fetch on QUESTION_CHANGED, etc). Mirror it.
  useEffect(() => {
    setQuestion(initialQuestion);
  }, [initialQuestion]);

  // Refresh local question snapshot when QUESTION_CHANGED fires for our id
  // (title/description/archive toggles done from another surface).
  useEffect(() => {
    const u = listen<QuestionChangedPayload>(DataEvents.QUESTION_CHANGED, async (event) => {
      if (event.payload.question_id !== question.id) return;
      if (event.payload.action === "deleted") return; // App.tsx handles tab close
      try {
        const fresh = await cmd.getQuestion(question.id);
        setQuestion(fresh);
      } catch {
        // Question may have been deleted between event and refetch; ignore.
      }
    });
    return () => { u.then((f) => f()); };
  }, [question.id]);

  const handleArchiveToggle = useCallback(async () => {
    try {
      if (question.status === "archived") {
        await cmd.unarchiveQuestion(question.id);
      } else {
        await cmd.archiveQuestion(question.id);
      }
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
    }
  }, [question, t]);

  const handleDelete = useCallback(async () => {
    const message =
      totalLinks === 0
        ? t("deleteConfirmNoLinks", { title: question.title })
        : t("deleteConfirm", { title: question.title, count: totalLinks });
    const ok = await ask(message, { title: t("deleteQuestion"), kind: "warning" });
    if (!ok) return;
    try {
      await cmd.deleteQuestion(question.id);
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
    }
  }, [question, totalLinks, onClose, t]);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(buildQuestionDeepLink(question.id));
    toast.success(t("linkCopied"));
  }, [question.id, t]);

  const summaryParts = [t("summaryResources", { count: groups.length })];
  if (evidenceCount > 0) {
    summaryParts.push(t("summaryAnnotations", { count: evidenceCount }));
  }
  const archived = question.status === "archived";

  return (
    <div className={styles.view}>
      <div className={`${styles.scrollArea} ${variant === "preview" ? styles.scrollAreaCompact : ""}`}>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <h1 className={`${styles.title} ${archived ? styles.titleArchived : ""}`}>
              {question.title}
            </h1>
            <div className={styles.actions}>
              {variant === "preview" && onOpenInTab && (
                <button
                  className={styles.iconBtn}
                  onClick={() => onOpenInTab(question)}
                  title={t("preview.openInTab")}
                >
                  {t("preview.openInTab")}
                </button>
              )}
              <button
                className={styles.iconBtn}
                onClick={() => setEditorOpen(true)}
                title={t("editQuestion")}
              >
                {t("editQuestion")}
              </button>
              <button
                className={styles.iconBtn}
                onClick={handleArchiveToggle}
                title={archived ? t("unarchiveQuestion") : t("archiveQuestion")}
              >
                {archived ? t("unarchiveQuestion") : t("archiveQuestion")}
              </button>
              <button
                className={styles.iconBtn}
                onClick={handleCopyLink}
                title={t("copyLink")}
              >
                {t("copyLink")}
              </button>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                onClick={handleDelete}
                title={t("deleteQuestion")}
              >
                {t("deleteQuestion")}
              </button>
            </div>
          </div>
          <div>
            <span
              className={`${styles.statusBadge} ${
                archived ? "" : styles.statusBadgeActive
              }`}
            >
              {archived ? t("archived") : t("active")}
            </span>
          </div>
          {question.description ? (
            <div className={styles.description}>
              <MarkdownContent content={question.description} />
            </div>
          ) : (
            <div className={styles.descriptionEmpty}>{t("noDescription")}</div>
          )}
        </div>

        <div className={styles.linksSection}>
          <div className={styles.linksHeader}>
            {t("linksHeader")}
            {totalLinks > 0 && <span className={styles.linksSummary}> ({summaryParts.join(" · ")})</span>}
          </div>
          {totalLinks === 0 ? (
            <div className={styles.empty}>{loading ? "" : t("emptyLinks")}</div>
          ) : (
            <div className={styles.groupList}>
              {groups.map((group) => (
                <ResourceLinkGroup
                  key={group.key}
                  group={group}
                  onOpenResource={onOpenResource}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {editorOpen && (
        <QuestionEditDialog
          question={question}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}
