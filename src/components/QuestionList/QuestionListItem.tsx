import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Question } from "@/types";
import * as cmd from "@/lib/commands";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { buildQuestionDeepLink } from "@/lib/deepLink";
import { highlightMatch } from "@/lib/highlightMatch";
import styles from "./QuestionListItem.module.css";

interface QuestionListItemProps {
  question: Question;
  selected: boolean;
  /** Single click — used to surface the question in the third-column preview. */
  onClick: (question: Question) => void;
  /** Double click — used to open a dedicated Tab. */
  onDoubleClick: (question: Question) => void;
  /** Right-click "Open in tab" menu item delegates here, mirroring double-click. */
  onOpenInTab: (question: Question) => void;
  /** Right-click "Edit" surfaces the edit dialog from a higher level. */
  onEdit: (question: Question) => void;
  /** Active search query — drives title highlight + snippet display. Empty when not searching. */
  searchQuery?: string;
  /** Which fields matched (title/description/notes); used to label why the row surfaced. */
  matchFields?: string[];
  /** Context snippet from the matched notes/description (null for title-only matches). */
  snippet?: string | null;
}

/**
 * Middle-column row for a question in the new QuestionList view.
 *
 * Ported from `src/components/Sidebar/QuestionItem.tsx` (Phase 1). Key
 * differences: `selected` highlight, separate `onClick` / `onDoubleClick`
 * handlers, "Open in tab" promoted to its own menu item.
 */
export function QuestionListItem({
  question,
  selected,
  onClick,
  onDoubleClick,
  onOpenInTab,
  onEdit,
  searchQuery = "",
  matchFields,
  snippet,
}: QuestionListItemProps) {
  const { t } = useTranslation("question");
  const { t: tSearch } = useTranslation("search");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const itemRef = useRef<HTMLButtonElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(buildQuestionDeepLink(question.id));
    toast.success(t("linkCopied"));
  }, [question.id, t]);

  const handleArchive = useCallback(async () => {
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
  }, [question.id, question.status, t]);

  const handleDelete = useCallback(async () => {
    let linkCount = 0;
    try {
      const links = await cmd.listQuestionLinks(question.id);
      linkCount = links.length;
    } catch {
      // best effort — we still ask
    }
    const message =
      linkCount === 0
        ? t("deleteConfirmNoLinks", { title: question.title })
        : t("deleteConfirm", { title: question.title, count: linkCount });
    const ok = await ask(message, { title: t("deleteQuestion"), kind: "warning" });
    if (!ok) return;
    try {
      await cmd.deleteQuestion(question.id);
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
    }
  }, [question.id, question.title, t]);

  const menuItems: MenuItem[] = [
    { label: t("openQuestion"), onClick: () => onOpenInTab(question) },
    { label: t("copyLink"), onClick: handleCopyLink },
    { label: t("editQuestion"), onClick: () => onEdit(question) },
    {
      label: question.status === "archived" ? t("unarchiveQuestion") : t("archiveQuestion"),
      onClick: handleArchive,
    },
    { label: t("deleteQuestion"), onClick: handleDelete, danger: true },
  ];

  const archived = question.status === "archived";
  // Show *why* the row surfaced when the match is outside the visible title —
  // notes take priority over description.
  const fieldTag = matchFields?.includes("notes")
    ? tSearch("notesMatch")
    : matchFields?.includes("description")
      ? tSearch("descriptionMatch")
      : null;

  return (
    <>
      <button
        ref={itemRef}
        className={`${styles.item} ${selected ? styles.itemSelected : ""}`}
        onClick={() => onClick(question)}
        onDoubleClick={() => onDoubleClick(question)}
        onContextMenu={handleContextMenu}
        title={question.description ?? undefined}
      >
        <span className={styles.titleRow}>
          <span className={`${styles.dot} ${archived ? styles.dotArchived : ""}`} />
          <span className={`${styles.title} ${archived ? styles.titleArchived : ""}`}>
            {searchQuery ? highlightMatch(question.title, searchQuery, styles.highlight) : question.title}
          </span>
          {fieldTag && <span className={styles.matchTag}>{fieldTag}</span>}
        </span>
        {snippet && (
          <span className={styles.snippet}>
            {highlightMatch(snippet, searchQuery, styles.highlight)}
          </span>
        )}
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
