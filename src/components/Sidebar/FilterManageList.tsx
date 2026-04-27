import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as cmd from "@/lib/commands";
import type { Tag } from "@/types";
import { TagPopover } from "@/components/Sidebar/TagPopover";
import { useFlipPosition } from "@/hooks/useFlipPosition";
import styles from "./FilterChips.module.css";

interface ManageListProps {
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function FilterManageList({ onClose, anchorRef }: ManageListProps) {
  const { t } = useTranslation("sidebar");
  const [tags, setTags] = useState<Tag[]>([]);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useFlipPosition(ref, 0, 0);

  const loadTags = useCallback(async () => {
    try { setTags(await cmd.listTags()); } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadTags(); }, [loadTags]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleDelete = async (tag: Tag) => {
    if (!confirm(t("deleteTagConfirm", { name: tag.name }))) return;
    try { await cmd.deleteTag(tag.id); loadTags(); } catch { /* ignore */ }
  };

  const handleSaveEdit = async (name: string, color: string) => {
    if (!editingTag) return;
    try { await cmd.updateTag(editingTag.id, name, color); }
    catch { /* ignore */ }
    setEditingTag(null);
    loadTags();
  };

  const handleSaveCreate = async (name: string, color: string) => {
    try { await cmd.createTag(name, color); } catch { /* ignore */ }
    setCreating(false);
    loadTags();
  };

  return (
    <>
      <div
        ref={ref}
        className={styles.managePanel}
        style={{
          position: "fixed",
          top: (anchorRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
          right: (anchorRef.current?.getBoundingClientRect().right ?? 0),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.manageList}>
          {tags.map((tag) => (
            <div key={tag.id} className={styles.manageItem}>
              <span className={styles.manageDot} style={{ backgroundColor: tag.color }} />
              <span className={styles.manageName}>{tag.name}</span>
              <div className={styles.manageActions}>
                <button className={styles.manageActionBtn} title={t("updateTagFailed")} onClick={() => setEditingTag(tag)}>&#9998;</button>
                <button className={styles.manageActionBtn} title={t("deleteTag")} onClick={() => handleDelete(tag)}>&#128465;</button>
              </div>
            </div>
          ))}
        </div>
        <button className={styles.manageCreateBtn} onClick={() => setCreating(true)}>+ {t("newTag")}</button>
      </div>
      {editingTag && (
        <TagPopover
          initialName={editingTag.name}
          initialColor={editingTag.color}
          position={{ x: 0, y: 0 }}
          onSave={handleSaveEdit}
          onClose={() => setEditingTag(null)}
        />
      )}
      {creating && (
        <TagPopover
          position={{ x: 0, y: 0 }}
          onSave={handleSaveCreate}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
