import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as cmd from "@/lib/commands";
import type { TagWithCount } from "@/types";
import { Modal } from "@/components/Modal";
import styles from "./FilterChips.module.css";

interface ManageDialogProps {
  onClose: () => void;
}

export function FilterManagePanel({ onClose }: ManageDialogProps) {
  const { t } = useTranslation("sidebar");
  const [tags, setTags] = useState<TagWithCount[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadTags = useCallback(async () => {
    try { setTags(await cmd.listTagsInFolder(null)); } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadTags(); }, [loadTags]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t("deleteTagConfirm", { name }))) return;
    try { await cmd.deleteTag(id); loadTags(); } catch { /* ignore */ }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try { await cmd.createTag(name, "#888888"); setNewName(""); setCreating(false); loadTags(); } catch { /* ignore */ }
  };

  return (
    <Modal title={t("manageTags")} onClose={onClose}>
      <div className={styles.manageDialog}>
        <div className={styles.manageList}>
          {tags.length === 0 && (
            <div className={styles.manageEmpty}>{t("noTags")}</div>
          )}
          {tags.map((tag) => (
            <div key={tag.id} className={styles.manageItem}>
              <span className={styles.manageDot} style={{ backgroundColor: tag.color }} />
              <span className={styles.manageName}>{tag.name}</span>
              <span className={styles.manageCount}>{tag.count}</span>
              <button
                className={styles.manageDeleteBtn}
                onClick={() => handleDelete(tag.id, tag.name)}
                title={t("deleteTag")}
              >
                &#10005;
              </button>
            </div>
          ))}
        </div>
        <div className={styles.manageFooter}>
          {creating ? (
            <div className={styles.manageCreateRow}>
              <input
                className={styles.manageNameInput}
                placeholder={t("tagNamePlaceholder")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
                autoFocus
              />
              <button className={styles.manageSaveBtn} onClick={handleCreate}>{t("tagSave")}</button>
              <button className={styles.manageCancelBtn} onClick={() => setCreating(false)}>{t("tagCancel")}</button>
            </div>
          ) : (
            <button className={styles.manageCreateBtn} onClick={() => setCreating(true)}>
              + {t("newTag")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
