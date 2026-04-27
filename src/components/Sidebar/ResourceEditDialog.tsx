import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/Modal";
import { useTags } from "@/hooks/useTags";
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
  const { tags } = useTags();
  const [title, setTitle] = useState(resource.title);
  const [description, setDescription] = useState(resource.description ?? "");
  // Currently-assigned tag ids. Loaded once on open and mutated locally
  // until Save — we diff against the original on commit so users can cancel
  // tag edits by closing the dialog.
  const [originalTagIds, setOriginalTagIds] = useState<Set<string>>(new Set());
  const [tagIds, setTagIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    cmd.getTagsForResource(resource.id)
      .then((assigned) => {
        if (cancelled) return;
        const ids = new Set(assigned.map((tag) => tag.id));
        setOriginalTagIds(ids);
        setTagIds(new Set(ids));
      })
      .catch(() => { /* fall through with empty set */ });
    return () => { cancelled = true; };
  }, [resource.id]);

  function toggleTag(id: string) {
    setTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await cmd.updateResource(resource.id, trimmed, description.trim() || null);
      // Diff against the snapshot we loaded on open, not the live useTags
      // list — fewer round trips and avoids stale-write races if a remote
      // sync added a tag while the dialog was open.
      const toAdd = [...tagIds].filter((id) => !originalTagIds.has(id));
      const toRemove = [...originalTagIds].filter((id) => !tagIds.has(id));
      for (const id of toAdd) {
        await cmd.addTagToResource(resource.id, id);
      }
      for (const id of toRemove) {
        await cmd.removeTagFromResource(resource.id, id);
      }
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
        <div className={styles.label}>
          {t('editTags')}
          {tags.length === 0 ? (
            <div className={styles.tagEmpty}>{t('noTags')}</div>
          ) : (
            <div className={styles.tagList} role="group" aria-label={t('editTags')}>
              {tags.map((tag) => {
                const selected = tagIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    aria-pressed={selected}
                    className={`${styles.tagChip} ${selected ? styles.tagChipSelected : ""}`}
                    onClick={() => toggleTag(tag.id)}
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        toggleTag(tag.id);
                      }
                    }}
                  >
                    <span className={styles.tagDot} style={{ background: tag.color }} />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
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
