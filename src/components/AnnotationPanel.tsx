import { useState, useRef, useEffect } from "react";
import type { Highlight, Comment } from "@/types";
import styles from "./AnnotationPanel.module.css";

interface AnnotationPanelProps {
  highlights: Highlight[];
  getCommentsForHighlight: (highlightId: string) => Comment[];
  activeHighlightId: string | null;
  onClickHighlight: (id: string) => void;
  onDeleteHighlight: (id: string) => void;
  onAddComment: (highlightId: string | null, content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
  resourceNotes: Comment[];
}

export function AnnotationPanel({
  highlights,
  getCommentsForHighlight,
  activeHighlightId,
  onClickHighlight,
  onDeleteHighlight,
  onAddComment,
  onDeleteComment,
  onEditComment,
  resourceNotes,
}: AnnotationPanelProps) {
  const activeRef = useRef<HTMLDivElement>(null);

  // Scroll to active highlight when it changes
  useEffect(() => {
    if (activeHighlightId && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeHighlightId]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>标注 ({highlights.length})</div>
      <div className={styles.list}>
        {highlights.length === 0 && (
          <div className={styles.empty}>选中文字创建标注</div>
        )}
        {highlights.map((hl) => (
          <HighlightEntry
            key={hl.id}
            highlight={hl}
            comments={getCommentsForHighlight(hl.id)}
            isActive={activeHighlightId === hl.id}
            ref={activeHighlightId === hl.id ? activeRef : null}
            onClick={() => onClickHighlight(hl.id)}
            onDelete={() => onDeleteHighlight(hl.id)}
            onAddComment={(content) => onAddComment(hl.id, content)}
            onDeleteComment={onDeleteComment}
            onEditComment={onEditComment}
          />
        ))}
      </div>

      {/* Notes section */}
      <NotesSection
        notes={resourceNotes}
        onAdd={(content) => onAddComment(null, content)}
        onEdit={onEditComment}
        onDelete={onDeleteComment}
      />
    </div>
  );
}

interface HighlightEntryProps {
  highlight: Highlight;
  comments: Comment[];
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onAddComment: (content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
}

import { forwardRef } from "react";

const HighlightEntry = forwardRef<HTMLDivElement, HighlightEntryProps>(
  function HighlightEntry(
    { highlight, comments, isActive, onClick, onDelete, onAddComment, onDeleteComment, onEditComment },
    ref,
  ) {
    const [showInput, setShowInput] = useState(false);
    const [commentText, setCommentText] = useState("");
    const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");

    function handleSubmit() {
      if (!commentText.trim()) return;
      onAddComment(commentText.trim());
      setCommentText("");
      setShowInput(false);
    }

    return (
      <div
        ref={ref}
        className={`${styles.highlightItem} ${isActive ? styles.highlightItemActive : ""}`}
        style={{ borderLeftColor: highlight.color }}
        onClick={onClick}
      >
        <div className={styles.highlightText}>{highlight.text_content}</div>
        <div className={styles.highlightMeta}>
          <span>{new Date(highlight.created_at).toLocaleDateString()}</span>
          <button
            className={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            删除
          </button>
        </div>

        {/* Comments */}
        {comments.length > 0 && (
          <div className={styles.commentSection} onClick={(e) => e.stopPropagation()}>
            {comments.map((c) => (
              <div key={c.id} className={styles.commentItem}>
                {editingCommentId === c.id ? (
                  <div>
                    <textarea
                      className={styles.commentInput}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (editText.trim()) {
                            onEditComment(c.id, editText.trim());
                            setEditingCommentId(null);
                          }
                        }
                        if (e.key === "Escape") {
                          setEditingCommentId(null);
                        }
                      }}
                    />
                    <div className={styles.commentActions}>
                      <button
                        className={styles.submitBtn}
                        onClick={() => {
                          if (editText.trim()) {
                            onEditComment(c.id, editText.trim());
                            setEditingCommentId(null);
                          }
                        }}
                      >
                        保存
                      </button>
                      <button
                        className={styles.cancelBtn}
                        onClick={() => setEditingCommentId(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.commentContent}>{c.content}</div>
                    <div className={styles.commentMeta}>
                      <span>{new Date(c.created_at).toLocaleDateString()}</span>
                      <span>
                        <button
                          className={styles.editBtn}
                          onClick={() => {
                            setEditingCommentId(c.id);
                            setEditText(c.content);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className={styles.deleteBtn}
                          onClick={() => onDeleteComment(c.id)}
                        >
                          删除
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add comment */}
        <div onClick={(e) => e.stopPropagation()}>
          {showInput ? (
            <div style={{ marginTop: "4px" }}>
              <textarea
                className={styles.commentInput}
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="添加评论..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
              <div className={styles.commentActions}>
                <button className={styles.submitBtn} onClick={handleSubmit}>
                  保存
                </button>
                <button
                  className={styles.cancelBtn}
                  onClick={() => {
                    setShowInput(false);
                    setCommentText("");
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              className={styles.addCommentBtn}
              onClick={() => setShowInput(true)}
            >
              + 评论
            </button>
          )}
        </div>
      </div>
    );
  },
);

interface NotesSectionProps {
  notes: Comment[];
  onAdd: (content: string) => void;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
}

function NotesSection({ notes, onAdd, onEdit, onDelete }: NotesSectionProps) {
  const [noteText, setNoteText] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  function handleSubmit() {
    if (!noteText.trim()) return;
    onAdd(noteText.trim());
    setNoteText("");
  }

  return (
    <div className={styles.notesSection}>
      <div className={styles.notesHeader}>📝 笔记 ({notes.length})</div>

      {notes.map((note) => (
        <div key={note.id} className={styles.noteItem}>
          {editingNoteId === note.id ? (
            <div>
              <textarea
                className={styles.noteInput}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (editText.trim()) {
                      onEdit(note.id, editText.trim());
                      setEditingNoteId(null);
                    }
                  }
                  if (e.key === "Escape") setEditingNoteId(null);
                }}
              />
              <div className={styles.commentActions}>
                <button
                  className={styles.submitBtn}
                  onClick={() => {
                    if (editText.trim()) {
                      onEdit(note.id, editText.trim());
                      setEditingNoteId(null);
                    }
                  }}
                >
                  保存
                </button>
                <button className={styles.cancelBtn} onClick={() => setEditingNoteId(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={styles.noteContent}>{note.content}</div>
              <div className={styles.noteMeta}>
                <span>{new Date(note.created_at).toLocaleDateString()}</span>
                <span>
                  <button
                    className={styles.editBtn}
                    onClick={() => {
                      setEditingNoteId(note.id);
                      setEditText(note.content);
                    }}
                  >
                    编辑
                  </button>
                  <button className={styles.deleteBtn} onClick={() => onDelete(note.id)}>
                    删除
                  </button>
                </span>
              </div>
            </>
          )}
        </div>
      ))}

      {/* Add note input */}
      <div style={{ marginTop: notes.length > 0 ? "var(--spacing-xs)" : 0 }}>
        <textarea
          className={styles.noteInput}
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="添加笔记..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        {noteText.trim() && (
          <div className={styles.commentActions}>
            <button className={styles.submitBtn} onClick={handleSubmit}>
              保存
            </button>
            <button
              className={styles.cancelBtn}
              onClick={() => setNoteText("")}
            >
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
