import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Question } from "@/types";
import * as cmd from "@/lib/commands";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { buildQuestionDeepLink } from "@/lib/deepLink";
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
}: QuestionListItemProps) {
  const { t } = useTranslation("question");
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
        <span className={`${styles.dot} ${archived ? styles.dotArchived : ""}`} />
        <span className={`${styles.title} ${archived ? styles.titleArchived : ""}`}>
          {question.title}
        </span>
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
