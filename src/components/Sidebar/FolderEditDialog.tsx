import { useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { Modal } from "@/components/Modal";
import * as cmd from "@/lib/commands";

interface FolderEditDialogProps {
  folderId: string;
  currentName: string;
  onClose: () => void;
  onSaved: () => void;
}

export function FolderEditDialog({
  folderId,
  currentName,
  onClose,
  onSaved,
}: FolderEditDialogProps) {
  const { t } = useTranslation('sidebar');
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await cmd.renameFolder(folderId, trimmed);
      onSaved();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        toast.error(t('folderNameExists'));
      } else {
        toast.error(t('renameFailed', { message: msg }));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={t('editFolder')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <label
          style={{
            display: "block",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
            marginBottom: "var(--spacing-xs)",
          }}
        >
          {t('folderNameLabel')}
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          style={{
            width: "100%",
            padding: "var(--spacing-sm)",
            border: "1px solid var(--color-border)",
            borderRadius: "4px",
            fontSize: "var(--font-size-base)",
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--spacing-sm)",
            marginTop: "var(--spacing-lg)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "var(--spacing-xs) var(--spacing-md)",
              borderRadius: "4px",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-primary)",
              cursor: "pointer",
              fontSize: "var(--font-size-base)",
            }}
          >
            {t('cancel', { ns: 'common' })}
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            style={{
              padding: "var(--spacing-xs) var(--spacing-md)",
              borderRadius: "4px",
              border: "none",
              background: "var(--color-accent)",
              color: "white",
              cursor: "pointer",
              fontSize: "var(--font-size-base)",
            }}
          >
            {t('confirm', { ns: 'common' })}
          </button>
        </div>
      </form>
    </Modal>
  );
}
