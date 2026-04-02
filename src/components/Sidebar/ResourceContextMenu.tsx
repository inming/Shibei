import { useState, useEffect, useRef, useCallback } from "react";
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
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: x,
    top: y,
    zIndex: 1000,
  };

  return (
    <div ref={menuRef} className={styles.menu} style={menuStyle}>
      {isSingleSelect && (
        <button className={styles.item} onClick={onEdit}>
          编辑
        </button>
      )}
      <div
        className={`${styles.item} ${styles.hasSubmenu}`}
        onMouseEnter={() => setOpenSub("tags")}
      >
        <span>标签</span>
        <span className={styles.arrow}>&rsaquo;</span>
        {openSub === "tags" && (
          <div className={styles.submenuPanel}>
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
        <span>移动到</span>
        <span className={styles.arrow}>&rsaquo;</span>
        {openSub === "move" && (
          <div className={styles.submenuPanel}>
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
        {isSingleSelect ? "删除" : `删除 (${resourceIds.length} 项)`}
      </button>
    </div>
  );
}
