import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { TagSubMenu } from "@/components/Sidebar/TagSubMenu";
import { FolderPickerMenu } from "@/components/Sidebar/FolderPickerMenu";
import { LinkToQuestionSubMenu } from "@/components/Sidebar/LinkToQuestionSubMenu";
import { useFlipPosition, useSubmenuPosition } from "@/hooks/useFlipPosition";
import styles from "./ResourceContextMenu.module.css";

interface ResourceContextMenuProps {
  x: number;
  y: number;
  resourceIds: string[];
  currentFolderId: string;
  isSingleSelect: boolean;
  onEdit: () => void;
  /** Delete handler. Omit together with showDelete=false to hide the action
   *  (e.g. the tab context menu, which should not expose destructive ops). */
  onDelete?: () => void;
  onMove: (folderId: string) => void;
  onTagsChanged: () => void;
  onClose: () => void;
  /** Whether to render the Delete action. Defaults to true. */
  showDelete?: boolean;
}

export function ResourceContextMenu({
  x,
  y,
  resourceIds,
  currentFolderId,
  isSingleSelect,
  onEdit,
  onDelete,
  onMove,
  onTagsChanged,
  onClose,
  showDelete = true,
}: ResourceContextMenuProps) {
  const { t } = useTranslation('sidebar');
  const { t: tq } = useTranslation('question');
  const [openSub, setOpenSub] = useState<"tags" | "move" | "questions" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tagsAnchorRef = useRef<HTMLDivElement>(null);
  const tagsSubmenuRef = useRef<HTMLDivElement>(null);
  const moveAnchorRef = useRef<HTMLDivElement>(null);
  const moveSubmenuRef = useRef<HTMLDivElement>(null);
  const questionsAnchorRef = useRef<HTMLDivElement>(null);
  const questionsSubmenuRef = useRef<HTMLDivElement>(null);

  const handleOutsideClick = useCallback(
    (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleOutsideClick, handleKeyDown]);

  const adjustedPos = useFlipPosition(menuRef, x, y);
  const tagsSubStyle = useSubmenuPosition(tagsAnchorRef, tagsSubmenuRef, openSub === "tags");
  const moveSubStyle = useSubmenuPosition(moveAnchorRef, moveSubmenuRef, openSub === "move");
  const questionsSubStyle = useSubmenuPosition(
    questionsAnchorRef,
    questionsSubmenuRef,
    openSub === "questions",
  );

  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: adjustedPos.left,
    top: adjustedPos.top,
    zIndex: 1000,
  };

  return (
    <div ref={menuRef} className={styles.menu} style={menuStyle}>
      {isSingleSelect && (
        <button className={styles.item} onClick={onEdit}>
          {t('contextEdit')}
        </button>
      )}
      {isSingleSelect && (
        <button
          className={styles.item}
          onClick={() => {
            navigator.clipboard.writeText(`shibei://open/resource/${resourceIds[0]}`);
            toast.success(t('contextLinkCopied'));
            onClose();
          }}
        >
          {t('contextCopyLink')}
        </button>
      )}
      <div
        ref={tagsAnchorRef}
        className={`${styles.item} ${styles.hasSubmenu}`}
        onMouseEnter={() => setOpenSub("tags")}
      >
        <span>{t('contextTags')}</span>
        <span className={styles.arrow}>&rsaquo;</span>
        {openSub === "tags" && (
          <div ref={tagsSubmenuRef} className={styles.submenuPanel} style={tagsSubStyle}>
            <TagSubMenu
              resourceIds={resourceIds}
              onClose={onClose}
              onTagsChanged={onTagsChanged}
            />
          </div>
        )}
      </div>
      <div
        ref={moveAnchorRef}
        className={`${styles.item} ${styles.hasSubmenu}`}
        onMouseEnter={() => setOpenSub("move")}
      >
        <span>{t('contextMoveTo')}</span>
        <span className={styles.arrow}>&rsaquo;</span>
        {openSub === "move" && (
          <div ref={moveSubmenuRef} className={styles.submenuPanel} style={moveSubStyle}>
            <FolderPickerMenu
              currentFolderId={currentFolderId}
              onSelect={(folderId) => {
                onMove(folderId);
                onClose();
              }}
            />
          </div>
        )}
      </div>
      <div
        ref={questionsAnchorRef}
        className={`${styles.item} ${styles.hasSubmenu}`}
        onMouseEnter={() => setOpenSub("questions")}
      >
        <span>{tq('linkToQuestion')}</span>
        <span className={styles.arrow}>&rsaquo;</span>
        {openSub === "questions" && (
          <div
            ref={questionsSubmenuRef}
            className={styles.submenuPanel}
            style={questionsSubStyle}
          >
            <LinkToQuestionSubMenu
              targetType="resource"
              targetIds={resourceIds}
              onClose={onClose}
            />
          </div>
        )}
      </div>
      {showDelete && onDelete && (
        <>
          <div className={styles.separator} />
          <button className={`${styles.item} ${styles.danger}`} onClick={onDelete}>
            {isSingleSelect ? t('contextDelete') : t('contextDeleteMultiple', { count: resourceIds.length })}
          </button>
        </>
      )}
    </div>
  );
}
