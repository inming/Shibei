import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTags } from "@/hooks/useTags";
import { ContextMenu } from "@/components/ContextMenu";
import { Modal } from "@/components/Modal";
import { TagPopover } from "./TagPopover";
import toast from "react-hot-toast";
import styles from "./TagFilter.module.css";
import type { Tag } from "@/types";

interface TagFilterProps {
  selectedTagIds: Set<string>;
  onToggleTag: (tagId: string) => void;
}

export function TagFilter({ selectedTagIds, onToggleTag }: TagFilterProps) {
  const { t } = useTranslation('sidebar');
  const [collapsed, setCollapsed] = useState(false);
  const { tags, createTag, updateTag, deleteTag } = useTags();

  // Popover state
  const [popover, setPopover] = useState<{
    mode: "create" | "edit";
    tag?: Tag;
    position: { x: number; y: number };
  } | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tag: Tag;
  } | null>(null);

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<Tag | null>(null);

  const handleAddClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setPopover({
        mode: "create",
        position: { x: rect.left, y: rect.bottom + 4 },
      });
    },
    [],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, tag: Tag) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, tag });
    },
    [],
  );

  const handleSavePopover = useCallback(
    async (name: string, color: string) => {
      try {
        if (popover?.mode === "create") {
          await createTag(name, color);
        } else if (popover?.mode === "edit" && popover.tag) {
          await updateTag(popover.tag.id, name, color);
        }
        setPopover(null);
      } catch (err) {
        toast.error(
          popover?.mode === "create" ? t('createTagFailed') : t('updateTagFailed'),
        );
        console.error("Tag save failed:", err);
      }
    },
    [popover, createTag, updateTag],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    try {
      await deleteTag(deleteConfirm.id);
      setDeleteConfirm(null);
    } catch (err) {
      toast.error(t('deleteTagFailed'));
      console.error("Tag delete failed:", err);
    }
  }, [deleteConfirm, deleteTag]);

  return (
    <div className={styles.section}>
      <div
        className={styles.sectionHeader}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={styles.sectionHeaderIcon}>🏷️</span>
        <span className={styles.sectionHeaderLabel}>{t('tags')}</span>
        <span className={styles.sectionSubtitle}>{t('tagsSubtitle')}</span>
        <button
          className={styles.addBtn}
          onClick={(e) => { e.stopPropagation(); handleAddClick(e); }}
        >
          +
        </button>
      </div>
      {!collapsed && (
        <>
          {tags.length === 0 ? (
            <div className={styles.empty}>{t('noTags')}</div>
          ) : (
            <div className={styles.tagList}>
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  className={`${styles.tag} ${selectedTagIds.has(tag.id) ? styles.selected : ""}`}
                  onClick={() => onToggleTag(tag.id)}
                  onContextMenu={(e) => handleContextMenu(e, tag)}
                >
                  <span
                    className={styles.dot}
                    style={{ background: tag.color }}
                  />
                  {tag.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {popover && (
        <TagPopover
          initialName={popover.mode === "edit" ? popover.tag?.name : undefined}
          initialColor={
            popover.mode === "edit" ? popover.tag?.color : undefined
          }
          position={popover.position}
          onSave={handleSavePopover}
          onClose={() => setPopover(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              label: t('edit', { ns: 'common' }),
              onClick: () => {
                setPopover({
                  mode: "edit",
                  tag: contextMenu.tag,
                  position: { x: contextMenu.x, y: contextMenu.y },
                });
              },
            },
            {
              label: t('delete', { ns: 'common' }),
              danger: true,
              onClick: () => {
                setDeleteConfirm(contextMenu.tag);
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}

      {deleteConfirm && (
        <Modal title={t('deleteTag')} onClose={() => setDeleteConfirm(null)}>
          <p>
            {t('deleteTagConfirm', { name: deleteConfirm.name })}
          </p>
          <div className={styles.modalActions}>
            <button
              className={styles.modalCancelBtn}
              onClick={() => setDeleteConfirm(null)}
            >
              {t('cancel', { ns: 'common' })}
            </button>
            <button
              className={styles.modalDeleteBtn}
              onClick={handleConfirmDelete}
            >
              {t('delete', { ns: 'common' })}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
