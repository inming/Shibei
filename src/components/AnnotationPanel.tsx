import { useState, useRef, useEffect } from "react";
import type { Highlight, Comment, Resource } from "@/types";
import styles from "./AnnotationPanel.module.css";
import { Modal } from "@/components/Modal";
import { ResourceMeta } from "@/components/ResourceMeta";
import { MarkdownContent } from "@/components/MarkdownContent";

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

interface AnnotationPanelProps {
  resource: Resource;
  highlights: Highlight[];
  failedHighlightIds: Set<string>;
  getCommentsForHighlight: (highlightId: string) => Comment[];
  activeHighlightId: string | null;
  onClickHighlight: (id: string) => void;
  onDeleteHighlight: (id: string) => void;
  onAddComment: (highlightId: string | null, content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
  resourceNotes: Comment[];
  style?: React.CSSProperties;
}

export function AnnotationPanel({
  resource,
  highlights,
  failedHighlightIds,
  getCommentsForHighlight,
  activeHighlightId,
  onClickHighlight,
  onDeleteHighlight,
  onAddComment,
  onDeleteComment,
  onEditComment,
  resourceNotes,
  style,
}: AnnotationPanelProps) {
  type DeleteConfirm = {
    type: "highlight" | "comment" | "note";
    id: string;
    commentCount?: number;
  };
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null);

  const activeRef = useRef<HTMLDivElement>(null);

  function getDeleteMessage(confirm: DeleteConfirm): string {
    switch (confirm.type) {
      case "highlight":
        return confirm.commentCount
          ? `确定删除此高亮标注？关联的 ${confirm.commentCount} 条评论也会一并删除。`
          : "确定删除此高亮标注？";
      case "comment":
        return "确定删除此评论？";
      case "note":
        return "确定删除此笔记？";
    }
  }

  function handleConfirmDelete() {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === "highlight") {
      onDeleteHighlight(deleteConfirm.id);
    } else {
      onDeleteComment(deleteConfirm.id);
    }
    setDeleteConfirm(null);
  }

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const notesHeaderRef = useRef<HTMLDivElement>(null);
  const [notesHeaderHidden, setNotesHeaderHidden] = useState(false);

  // Scroll to active highlight when it changes
  useEffect(() => {
    if (activeHighlightId && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeHighlightId]);

  // Watch whether notes header is scrolled out of view
  useEffect(() => {
    const header = notesHeaderRef.current;
    const root = scrollAreaRef.current;
    if (!header || !root) return;

    const observer = new IntersectionObserver(
      ([entry]) => setNotesHeaderHidden(!entry.isIntersecting),
      { root, threshold: 0 },
    );
    observer.observe(header);
    return () => observer.disconnect();
  }, [resourceNotes.length]);

  return (
    <div className={styles.panel} style={style}>
      <ResourceMeta resource={resource} />
      <div className={styles.header}>标注 ({highlights.length})</div>
      <div ref={scrollAreaRef} className={styles.scrollArea}>
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
              isFailed={failedHighlightIds.has(hl.id)}
              ref={activeHighlightId === hl.id ? activeRef : null}
              onClick={() => onClickHighlight(hl.id)}
              onDelete={() =>
                setDeleteConfirm({
                  type: "highlight",
                  id: hl.id,
                  commentCount: getCommentsForHighlight(hl.id).length,
                })
              }
              onAddComment={(content) => onAddComment(hl.id, content)}
              onDeleteComment={(id) => setDeleteConfirm({ type: "comment", id })}
              onEditComment={onEditComment}
            />
          ))}
        </div>

        {/* Notes list (scrolls together with highlights) */}
        {resourceNotes.length > 0 && (
          <NotesList
            ref={notesHeaderRef}
            notes={resourceNotes}
            onEdit={onEditComment}
            onDelete={(id) => setDeleteConfirm({ type: "note", id })}
          />
        )}
      </div>

      {/* Sticky notes header — shows when notes section scrolled out */}
      {resourceNotes.length > 0 && notesHeaderHidden && (
        <div
          className={styles.stickyNotesHeader}
          onClick={() => notesHeaderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          📝 笔记 ({resourceNotes.length})
        </div>
      )}

      {/* Fixed note input at bottom */}
      <NoteInput onAdd={(content) => onAddComment(null, content)} />

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <Modal title="确认删除" onClose={() => setDeleteConfirm(null)}>
          <p className={styles.modalMessage}>
            {getDeleteMessage(deleteConfirm)}
          </p>
          <div className={styles.modalActions}>
            <button className={styles.modalCancelBtn} onClick={() => setDeleteConfirm(null)}>
              取消
            </button>
            <button className={styles.modalDangerBtn} onClick={handleConfirmDelete}>
              删除
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface HighlightEntryProps {
  highlight: Highlight;
  comments: Comment[];
  isActive: boolean;
  isFailed: boolean;
  onClick: () => void;
  onDelete: () => void;
  onAddComment: (content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
}

import { forwardRef } from "react";

const HighlightEntry = forwardRef<HTMLDivElement, HighlightEntryProps>(
  function HighlightEntry(
    { highlight, comments, isActive, isFailed, onClick, onDelete, onAddComment, onDeleteComment, onEditComment },
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
        className={`${styles.highlightItem} ${isActive ? styles.highlightItemActive : ""} ${isFailed ? styles.highlightItemFailed : ""}`}
        style={{ borderLeftColor: isFailed ? "var(--color-text-muted)" : highlight.color }}
        onClick={onClick}
      >
        <div className={styles.highlightText}>{highlight.text_content}</div>
        <div className={styles.highlightMeta}>
          {isFailed && <span className={styles.failedBadge}>定位失败</span>}
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
                      ref={autoResize}
                      className={styles.commentInput}
                      value={editText}
                      onChange={(e) => { setEditText(e.target.value); autoResize(e.target); }}
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
                    <div className={styles.commentContent}><MarkdownContent content={c.content} /></div>
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
            <div className={styles.addCommentWrap}>
              <textarea
                ref={autoResize}
                className={styles.commentInput}
                value={commentText}
                onChange={(e) => { setCommentText(e.target.value); autoResize(e.target); }}
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

interface NotesListProps {
  notes: Comment[];
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
}

const NotesList = forwardRef<HTMLDivElement, NotesListProps>(
  function NotesList({ notes, onEdit, onDelete }, ref) {
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  return (
    <div className={styles.notesSection}>
      <div ref={ref} className={styles.notesHeader}>📝 笔记 ({notes.length})</div>

      {notes.map((note) => (
        <div key={note.id} className={styles.noteItem}>
          {editingNoteId === note.id ? (
            <div>
              <textarea
                ref={autoResize}
                className={styles.noteInput}
                value={editText}
                onChange={(e) => { setEditText(e.target.value); autoResize(e.target); }}
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
              <div className={styles.noteContent}><MarkdownContent content={note.content} /></div>
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
    </div>
  );
});

function NoteInput({ onAdd }: { onAdd: (content: string) => void }) {
  const [noteText, setNoteText] = useState("");

  function handleSubmit() {
    if (!noteText.trim()) return;
    onAdd(noteText.trim());
    setNoteText("");
  }

  return (
    <div className={styles.noteInputFixed}>
      <textarea
        ref={autoResize}
        className={styles.noteInput}
        value={noteText}
        onChange={(e) => { setNoteText(e.target.value); autoResize(e.target); }}
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
          <button className={styles.cancelBtn} onClick={() => setNoteText("")}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
