import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/Modal";
import * as cmd from "@/lib/commands";
import toast from "react-hot-toast";
import type { Resource } from "@/types";
import styles from "./ResourceEditDialog.module.css";

interface ResourceEditDialogProps {
  resource: Resource;
  onSave: () => void;
  onClose: () => void;
}

export function ResourceEditDialog({ resource, onSave, onClose }: ResourceEditDialogProps) {
  const { t } = useTranslation('sidebar');
  const [title, setTitle] = useState(resource.title);
  const [description, setDescription] = useState(resource.description ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await cmd.updateResource(resource.id, trimmed, description.trim() || null);
      onSave();
      onClose();
    } catch (err: unknown) {
      toast.error(t('saveFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={t('editResource')} onClose={onClose}>
      <div className={styles.form}>
        <label className={styles.label}>
          {t('editTitle')}
          <input
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <label className={styles.label}>
          {t('editDescription')}
          <textarea
            className={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </label>
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>
            {t('editCancel')}
          </button>
          <button
            className={styles.saveBtn}
            onClick={handleSave}
            disabled={saving || !title.trim()}
          >
            {saving ? t('editSaving') : t('editSave')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
