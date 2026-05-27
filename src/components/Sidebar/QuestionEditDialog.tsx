import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { Modal } from "@/components/Modal";
import * as cmd from "@/lib/commands";
import type { Question } from "@/types";
import styles from "./QuestionEditDialog.module.css";

interface QuestionEditDialogProps {
  /** When `null`, the dialog creates a new question; otherwise it edits this one. */
  question: Question | null;
  onClose: () => void;
  /** Called with the created question on first save; not called when editing. */
  onCreated?: (question: Question) => void;
}

export function QuestionEditDialog({ question, onClose, onCreated }: QuestionEditDialogProps) {
  const { t } = useTranslation("question");
  const [title, setTitle] = useState(question?.title ?? "");
  const [description, setDescription] = useState(question?.description ?? "");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSubmitting(true);
    try {
      const desc = description.trim().length === 0 ? null : description;
      if (question) {
        await cmd.updateQuestion(question.id, trimmedTitle, desc);
      } else {
        const created = await cmd.createQuestion(trimmedTitle, desc);
        toast.success(t("createSuccess"));
        onCreated?.(created);
      }
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
      setSubmitting(false);
    }
  }, [title, description, question, onClose, onCreated, t]);

  return (
    <Modal title={question ? t("editQuestion") : t("createQuestion")} onClose={onClose}>
      <div className={styles.form}>
        <label className={styles.label}>
          {t("titlePlaceholder")}
          <input
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
            }}
          />
        </label>
        <label className={styles.label}>
          {t("descriptionPlaceholder")}
          <textarea
            className={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
            }}
          />
        </label>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={onClose} disabled={submitting}>
            {t("cancel", { ns: "common" })}
          </button>
          <button
            className={styles.btnPrimary}
            onClick={handleSubmit}
            disabled={submitting || title.trim().length === 0}
          >
            {t("save", { ns: "common" })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
