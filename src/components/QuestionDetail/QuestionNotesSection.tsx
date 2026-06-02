import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ask } from "@tauri-apps/plugin-dialog";
import type { QuestionNote } from "@/types";
import * as cmd from "@/lib/commands";
import { MarkdownContent } from "@/components/MarkdownContent";
import { useQuestionNotes } from "@/hooks/useQuestionNotes";
import { useCollapsible } from "@/hooks/useCollapsible";
import styles from "./QuestionNotesSection.module.css";

interface QuestionNotesSectionProps {
  questionId: string;
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * The "research notes" section of a question's detail view: a newest-first list
 * of markdown notes where the user (or an MCP-delegated AI agent) deposits
 * synthesized thinking and stage summaries. Each note edits inline (textarea +
 * preview toggle); a new note opens an empty editor at the top of the list.
 */
export function QuestionNotesSection({ questionId }: QuestionNotesSectionProps) {
  const { t } = useTranslation("question");
  const { notes, loading } = useQuestionNotes(questionId);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useCollapsible("question-notes");

  const handleCreate = useCallback(
    async (content: string) => {
      await cmd.createQuestionNote(questionId, content);
      setCreating(false);
    },
    [questionId],
  );

  return (
    <section className={styles.section} data-testid="question-notes-section">
      <div
        className={styles.header}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            setCollapsed(!collapsed);
          }
        }}
      >
        <span className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ""}`}>▾</span>
        <span className={styles.headerTitle}>
          {t("notesHeader")}
          {notes.length > 0 && <span className={styles.count}> ({notes.length})</span>}
        </span>
        <button
          className={styles.addBtn}
          onClick={(e) => {
            // Adding from a collapsed section expands it and opens the editor.
            e.stopPropagation();
            setCollapsed(false);
            setCreating(true);
          }}
          disabled={creating}
        >
          {t("addNote")}
        </button>
      </div>

      {!collapsed && (
        <>
          {creating && (
            <NoteEditor initial="" onSave={handleCreate} onCancel={() => setCreating(false)} />
          )}

          {notes.length === 0 && !creating ? (
            <div className={styles.empty}>{loading ? "" : t("emptyNotes")}</div>
          ) : (
            <div className={styles.list}>
              {notes.map((n) => (
                <NoteCard key={n.id} note={n} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function NoteCard({ note }: { note: QuestionNote }) {
  const { t } = useTranslation("question");
  const [editing, setEditing] = useState(false);

  const handleSave = useCallback(
    async (content: string) => {
      await cmd.updateQuestionNote(note.id, content);
      setEditing(false);
    },
    [note.id],
  );

  const handleDelete = useCallback(async () => {
    const ok = await ask(t("deleteNoteConfirm"), { title: t("deleteNote"), kind: "warning" });
    if (!ok) return;
    try {
      await cmd.deleteQuestionNote(note.id);
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
    }
  }, [note.id, t]);

  if (editing) {
    return <NoteEditor initial={note.content} onSave={handleSave} onCancel={() => setEditing(false)} />;
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.timestamp}>{formatTs(note.created_at)}</span>
        <div className={styles.cardActions}>
          <button className={styles.cardBtn} onClick={() => setEditing(true)}>
            {t("editNote")}
          </button>
          <button
            className={`${styles.cardBtn} ${styles.cardBtnDanger}`}
            onClick={handleDelete}
          >
            {t("deleteNote")}
          </button>
        </div>
      </div>
      <div className={styles.cardBody}>
        <MarkdownContent content={note.content} />
      </div>
    </div>
  );
}

interface NoteEditorProps {
  initial: string;
  onSave: (content: string) => Promise<void>;
  onCancel: () => void;
}

function NoteEditor({ initial, onSave, onCancel }: NoteEditorProps) {
  const { t } = useTranslation("question");
  const [content, setContent] = useState(initial);
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSave = useCallback(async () => {
    if (content.trim().length === 0) {
      // Empty note → treat as cancel rather than persisting a blank card.
      onCancel();
      return;
    }
    setSubmitting(true);
    try {
      await onSave(content);
    } catch (err) {
      console.error(err);
      toast.error(t("operationFailed"));
      setSubmitting(false);
    }
  }, [content, onSave, onCancel, t]);

  return (
    <div className={styles.editor}>
      <div className={styles.editorToolbar}>
        <button className={styles.toggleBtn} onClick={() => setPreview((p) => !p)}>
          {preview ? t("noteEditToggle") : t("notePreviewToggle")}
        </button>
      </div>
      {preview ? (
        <div className={styles.previewBox}>
          <MarkdownContent content={content} />
        </div>
      ) : (
        <textarea
          className={styles.textarea}
          value={content}
          placeholder={t("notePlaceholder")}
          autoFocus
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSave();
            if (e.key === "Escape") onCancel();
          }}
        />
      )}
      <div className={styles.editorActions}>
        <button className={styles.btn} onClick={onCancel} disabled={submitting}>
          {t("cancel", { ns: "common" })}
        </button>
        <button
          className={styles.btnPrimary}
          onClick={handleSave}
          disabled={submitting || content.trim().length === 0}
        >
          {t("save", { ns: "common" })}
        </button>
      </div>
    </div>
  );
}
