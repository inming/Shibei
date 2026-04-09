import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { TagSubMenu } from "@/components/Sidebar/TagSubMenu";
import { FolderPickerMenu } from "@/components/Sidebar/FolderPickerMenu";
import styles from "./ResourceContextMenu.module.css";

interface ResourceContextMenuProps {
  x: number;
  y: number;
  resourceIds: string[];
  currentFolderId: string;
  isSingleSelect: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (folderId: string) => void;
  onTagsChanged: () => void;
  onClose: () => void;
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
}: ResourceContextMenuProps) {
  const { t } = useTranslation('sidebar');
  const [openSub, setOpenSub] = useState<"tags" | "move" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Adjust position so menu doesn't overflow viewport
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const MARGIN = 4;
    let left = x;
    let top = y;
    if (top + rect.height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
    }
    if (left + rect.width > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
    }
    setAdjustedPos({ left, top });
  }, [x, y]);

  // Determine if submenus should flip horizontally
  const flipSub = adjustedPos.left + 320 > window.innerWidth;

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
        className={`${styles.item} ${styles.hasSubmenu}`}
        onMouseEnter={() => setOpenSub("tags")}
      >
        <span>{t('contextTags')}</span>
        <span className={styles.arrow}>&rsaquo;</span>
        {openSub === "tags" && (
          <div className={`${styles.submenuPanel} ${flipSub ? styles.submenuFlip : ""}`}>
            <TagSubMenu
              resourceIds={resourceIds}
              onClose={onClose}
              onTagsChanged={onTagsChanged}
            />
          </div>
        )}
      </div>
      <div
        className={`${styles.item} ${styles.hasSubmenu}`}
        onMouseEnter={() => setOpenSub("move")}
      >
        <span>{t('contextMoveTo')}</span>
        <span className={styles.arrow}>&rsaquo;</span>
        {openSub === "move" && (
          <div className={`${styles.submenuPanel} ${flipSub ? styles.submenuFlip : ""}`}>
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
      <div className={styles.separator} />
      <button className={`${styles.item} ${styles.danger}`} onClick={onDelete}>
        {isSingleSelect ? t('contextDelete') : t('contextDeleteMultiple', { count: resourceIds.length })}
      </button>
    </div>
  );
}
