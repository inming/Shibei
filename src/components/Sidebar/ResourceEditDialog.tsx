import { useState } from "react";
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
      toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="编辑资料" onClose={onClose}>
      <div className={styles.form}>
        <label className={styles.label}>
          标题
          <input
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <label className={styles.label}>
          描述
          <textarea
            className={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </label>
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>
            取消
          </button>
          <button
            className={styles.saveBtn}
            onClick={handleSave}
            disabled={saving || !title.trim()}
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
