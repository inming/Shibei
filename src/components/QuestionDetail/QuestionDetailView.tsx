import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Question, QuestionLink, Resource, QuestionTargetType } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents, type QuestionChangedPayload } from "@/lib/events";
import { MarkdownContent } from "@/components/MarkdownContent";
import { QuestionEditDialog } from "@/components/Sidebar/QuestionEditDialog";
import { useQuestionLinks } from "@/hooks/useQuestionLinks";
import { buildQuestionDeepLink } from "@/lib/deepLink";
import { QuestionLinkItem } from "./QuestionLinkItem";
import styles from "./QuestionDetailView.module.css";

interface QuestionDetailViewProps {
  /** Initial snapshot — refreshed in-place when QUESTION_CHANGED fires. */
  question: Question;
  onOpenResource: (resource: Resource, highlightId?: string) => void;
  onClose: () => void;
}

const GROUP_ORDER: QuestionTargetType[] = ["resource", "highlight", "comment"];

export function QuestionDetailView({
  question: initialQuestion,
  onOpenResource,
  onClose,
}: QuestionDetailViewProps) {
  const { t } = useTranslation("question");
  const [question, setQuestion] = useState<Question>(initialQuestion);
  const { links, loading } = useQuestionLinks(question.id);
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

  const grouped = useMemo(() => {
    const map = new Map<QuestionTargetType, QuestionLink[]>();
    for (const target of GROUP_ORDER) map.set(target, []);
    for (const link of links) {
      const arr = map.get(link.target_type as QuestionTargetType);
      if (arr) arr.push(link);
    }
    return map;
  }, [links]);

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
      links.length === 0
        ? t("deleteConfirmNoLinks", { title: question.title })
        : t("deleteConfirm", { title: question.title, count: links.length });
    const ok = await ask(message, { title: t("deleteQuestion"), kind: "warning" });
    if (!ok) return;
    try {
      await cmd.deleteQuestion(question.id);
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
    }
  }, [question, links.length, onClose, t]);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(buildQuestionDeepLink(question.id));
    toast.success(t("linkCopied"));
  }, [question.id, t]);

  const totalLinks = links.length;
  const archived = question.status === "archived";

  return (
    <div className={styles.view}>
      <div className={styles.scrollArea}>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <h1 className={`${styles.title} ${archived ? styles.titleArchived : ""}`}>
              {question.title}
            </h1>
            <div className={styles.actions}>
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
            {t("linksHeader")} ({totalLinks})
          </div>
          {totalLinks === 0 ? (
            <div className={styles.empty}>{loading ? "" : t("emptyLinks")}</div>
          ) : (
            GROUP_ORDER.map((targetType) => {
              const groupLinks = grouped.get(targetType) ?? [];
              if (groupLinks.length === 0) return null;
              return (
                <div key={targetType} className={styles.linksGroup}>
                  <div className={styles.groupHeader}>
                    {t(`linksByType.${targetType}` as "linksByType.resource")} ({groupLinks.length})
                  </div>
                  {groupLinks.map((link) => (
                    <QuestionLinkItem
                      key={link.id}
                      link={link}
                      onOpenResource={onOpenResource}
                    />
                  ))}
                </div>
              );
            })
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
