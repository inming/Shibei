import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import type { Highlight, Comment, Resource } from "@/types";
import styles from "./AnnotationPanel.module.css";
import { Modal } from "@/components/Modal";
import { ResourceMeta } from "@/components/ResourceMeta";
import { MarkdownContent } from "@/components/MarkdownContent";
import { LIGHT_COLORS, DARK_COLORS } from "@/components/SelectionToolbar";
import { useFlipPosition } from "@/hooks/useFlipPosition";
import * as cmd from "@/lib/commands";

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
  onChangeHighlightColor: (id: string, color: string) => void;
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
  onChangeHighlightColor,
  onAddComment,
  onDeleteComment,
  onEditComment,
  resourceNotes,
  style,
}: AnnotationPanelProps) {
  const { t } = useTranslation('annotation');
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
          ? t('deleteHighlightWithCommentsConfirm', { count: confirm.commentCount })
          : t('deleteHighlightConfirm');
      case "comment":
        return t('deleteCommentConfirm');
      case "note":
        return t('deleteNoteConfirm');
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
  const annotationsHeaderRef = useRef<HTMLDivElement>(null);
  const [notesHeaderHidden, setNotesHeaderHidden] = useState(false);
  const [annotationsHeaderHidden, setAnnotationsHeaderHidden] = useState(false);

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

  // Watch whether annotations header is scrolled ABOVE viewport
  // (not "below viewport" — that case means user hasn't reached it yet, don't show sticky)
  useEffect(() => {
    const header = annotationsHeaderRef.current;
    const root = scrollAreaRef.current;
    if (!header || !root) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const scrolledAbove =
          !entry.isIntersecting &&
          entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);
        setAnnotationsHeaderHidden(scrolledAbove);
      },
      { root, threshold: 0 },
    );
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.panel} style={style}>
      <ResourceMeta resource={resource} />
      {annotationsHeaderHidden && (
        <div
          className={styles.stickyAnnotationsHeader}
          onClick={() =>
            annotationsHeaderRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            })
          }
        >
          {t('annotationsCount', { count: highlights.length })}
        </div>
      )}
      <div ref={scrollAreaRef} className={styles.scrollArea}>
        <SummarySection resource={resource} />
        <div ref={annotationsHeaderRef} className={styles.sectionHeader}>
          {t('annotationsCount', { count: highlights.length })}
        </div>
        <div className={styles.list}>
          {highlights.length === 0 && (
            <div className={styles.empty}>{t('emptyAnnotationsHint')}</div>
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
              onChangeColor={(color) => onChangeHighlightColor(hl.id, color)}
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
          {t('notesCount', { count: resourceNotes.length })}
        </div>
      )}

      {/* Fixed note input at bottom */}
      <NoteInput onAdd={(content) => onAddComment(null, content)} />

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <Modal title={t('confirmDelete')} onClose={() => setDeleteConfirm(null)}>
          <p className={styles.modalMessage}>
            {getDeleteMessage(deleteConfirm)}
          </p>
          <div className={styles.modalActions}>
            <button className={styles.modalCancelBtn} onClick={() => setDeleteConfirm(null)}>
              {t('cancel')}
            </button>
            <button className={styles.modalDangerBtn} onClick={handleConfirmDelete}>
              {t('delete')}
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
  onChangeColor: (color: string) => void;
  onAddComment: (content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
}

import { forwardRef } from "react";

const HighlightEntry = forwardRef<HTMLDivElement, HighlightEntryProps>(
  function HighlightEntry(
    { highlight, comments, isActive, isFailed, onClick, onDelete, onChangeColor, onAddComment, onDeleteComment, onEditComment },
    ref,
  ) {
    const { t } = useTranslation('annotation');
    const [showInput, setShowInput] = useState(false);
    const [commentText, setCommentText] = useState("");
    const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [previewingEdit, setPreviewingEdit] = useState(false);
    const [previewingNew, setPreviewingNew] = useState(false);
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
    const ctxRef = useRef<HTMLDivElement>(null);
    const ctxAdjustedPos = useFlipPosition(ctxRef, ctxMenu?.x ?? 0, ctxMenu?.y ?? 0);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Clear any text selection caused by right-click
      window.getSelection()?.removeAllRanges();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    }, []);

    // Close context menu on outside click or escape
    useEffect(() => {
      if (!ctxMenu) return;
      function handleClick(e: MouseEvent) {
        if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null);
      }
      function handleKey(e: KeyboardEvent) {
        if (e.key === "Escape") setCtxMenu(null);
      }
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
      return () => {
        document.removeEventListener("mousedown", handleClick);
        document.removeEventListener("keydown", handleKey);
      };
    }, [ctxMenu]);

    function handleSubmit() {
      if (!commentText.trim()) return;
      onAddComment(commentText.trim());
      setCommentText("");
      setShowInput(false);
      setPreviewingNew(false);
    }

    return (
      <div
        ref={ref}
        className={`${styles.highlightItem} ${isActive ? styles.highlightItemActive : ""} ${isFailed ? styles.highlightItemFailed : ""}`}
        style={{ borderLeftColor: isFailed ? "var(--color-text-muted)" : highlight.color }}
        onClick={onClick}
        onContextMenu={handleContextMenu}
      >
        <div className={styles.highlightText}>{highlight.text_content}</div>
        <div className={styles.highlightMeta}>
          {isFailed && <span className={styles.failedBadge}>{t('locationFailed')}</span>}
          <span
            className={styles.colorDot}
            style={{ background: highlight.color }}
          />
          <span>{new Date(highlight.created_at).toLocaleDateString()}</span>
        </div>

        {/* Right-click context menu */}
        {ctxMenu && (
          <div
            ref={ctxRef}
            className={styles.hlContextMenu}
            style={{ top: ctxAdjustedPos.top, left: ctxAdjustedPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.hlColorSection}>
              <div className={styles.hlColorRow}>
                <span className={styles.hlColorLabel} title={t('lightPage')}>☀︎</span>
                {LIGHT_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`${styles.hlColorBtn} ${c === highlight.color ? styles.hlColorBtnActive : ""}`}
                    style={{ background: c }}
                    onClick={() => { onChangeColor(c); setCtxMenu(null); }}
                  />
                ))}
              </div>
              <div className={styles.hlColorRow}>
                <span className={styles.hlColorLabel} title={t('darkPage')}>☾</span>
                {DARK_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`${styles.hlColorBtn} ${c === highlight.color ? styles.hlColorBtnActive : ""}`}
                    style={{ background: c }}
                    onClick={() => { onChangeColor(c); setCtxMenu(null); }}
                  />
                ))}
              </div>
            </div>
            <div className={styles.hlContextSeparator} />
            <button
              className={styles.hlContextItem}
              onClick={() => {
                navigator.clipboard.writeText(
                  `shibei://open/resource/${highlight.resource_id}?highlight=${highlight.id}`
                );
                toast.success(t('linkCopied'));
                setCtxMenu(null);
              }}
            >
              {t('copyLink')}
            </button>
            <button
              className={`${styles.hlContextItem} ${styles.danger}`}
              onClick={() => { onDelete(); setCtxMenu(null); }}
            >
              {t('deleteAnnotation')}
            </button>
          </div>
        )}

        {/* Comments */}
        {comments.length > 0 && (
          <div className={styles.commentSection} onClick={(e) => e.stopPropagation()}>
            {comments.map((c) => (
              <div key={c.id} className={styles.commentItem}>
                {editingCommentId === c.id ? (
                  <div>
                    <div className={styles.editContainer}>
                      <button className={styles.previewToggle} onClick={() => setPreviewingEdit(!previewingEdit)}>
                        {previewingEdit ? t('edit') : t('preview')}
                      </button>
                      {previewingEdit ? (
                        <div className={styles.previewArea}><MarkdownContent content={editText} /></div>
                      ) : (
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
                                setPreviewingEdit(false);
                              }
                            }
                            if (e.key === "Escape") {
                              setEditingCommentId(null);
                              setPreviewingEdit(false);
                            }
                          }}
                        />
                      )}
                    </div>
                    <div className={styles.commentActions}>
                      <button
                        className={styles.submitBtn}
                        onClick={() => {
                          if (editText.trim()) {
                            onEditComment(c.id, editText.trim());
                            setEditingCommentId(null);
                            setPreviewingEdit(false);
                          }
                        }}
                      >
                        {t('save')}
                      </button>
                      <button
                        className={styles.cancelBtn}
                        onClick={() => { setEditingCommentId(null); setPreviewingEdit(false); }}
                      >
                        {t('cancel')}
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
                          {t('edit')}
                        </button>
                        <button
                          className={styles.deleteBtn}
                          onClick={() => onDeleteComment(c.id)}
                        >
                          {t('delete')}
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
              <div className={styles.editContainer}>
                {commentText.trim() && (
                  <button className={styles.previewToggle} onClick={() => setPreviewingNew(!previewingNew)}>
                    {previewingNew ? t('edit') : t('preview')}
                  </button>
                )}
                {previewingNew ? (
                  <div className={styles.previewArea}><MarkdownContent content={commentText} /></div>
                ) : (
                  <textarea
                    ref={autoResize}
                    className={styles.commentInput}
                    value={commentText}
                    onChange={(e) => { setCommentText(e.target.value); autoResize(e.target); }}
                    placeholder={t('addCommentPlaceholder')}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmit();
                      }
                    }}
                  />
                )}
              </div>
              <div className={styles.commentActions}>
                <button className={styles.submitBtn} onClick={handleSubmit}>
                  {t('save')}
                </button>
                <button
                  className={styles.cancelBtn}
                  onClick={() => {
                    setShowInput(false);
                    setCommentText("");
                    setPreviewingNew(false);
                  }}
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              className={styles.addCommentBtn}
              onClick={() => setShowInput(true)}
            >
              {t('addComment')}
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
  const { t } = useTranslation('annotation');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [previewingNoteEdit, setPreviewingNoteEdit] = useState(false);

  return (
    <div className={styles.notesSection}>
      <div ref={ref} className={styles.notesHeader}>{t('notesCount', { count: notes.length })}</div>

      {notes.map((note) => (
        <div key={note.id} className={styles.noteItem}>
          {editingNoteId === note.id ? (
            <div>
              <div className={styles.editContainer}>
                <button className={styles.previewToggle} onClick={() => setPreviewingNoteEdit(!previewingNoteEdit)}>
                  {previewingNoteEdit ? t('edit') : t('preview')}
                </button>
                {previewingNoteEdit ? (
                  <div className={styles.previewArea}><MarkdownContent content={editText} /></div>
                ) : (
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
                          setPreviewingNoteEdit(false);
                        }
                      }
                      if (e.key === "Escape") { setEditingNoteId(null); setPreviewingNoteEdit(false); }
                    }}
                  />
                )}
              </div>
              <div className={styles.commentActions}>
                <button
                  className={styles.submitBtn}
                  onClick={() => {
                    if (editText.trim()) {
                      onEdit(note.id, editText.trim());
                      setEditingNoteId(null);
                      setPreviewingNoteEdit(false);
                    }
                  }}
                >
                  {t('save')}
                </button>
                <button className={styles.cancelBtn} onClick={() => { setEditingNoteId(null); setPreviewingNoteEdit(false); }}>
                  {t('cancel')}
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
                    {t('edit')}
                  </button>
                  <button className={styles.deleteBtn} onClick={() => onDelete(note.id)}>
                    {t('delete')}
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

function SummarySection({ resource }: { resource: Resource }) {
  const { t } = useTranslation("annotation");
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const desc = resource.description?.trim();
    if (desc) {
      setSummary(desc);
      return () => { cancelled = true; };
    }
    setSummary(null);
    cmd.getResourceSummary(resource.id)
      .then((s) => {
        if (cancelled) return;
        setSummary(s?.trim() || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [resource.id, resource.description]);

  if (!summary) return null;

  return (
    <section className={styles.summarySection}>
      <div className={styles.sectionHeader}>{t("summary")}</div>
      <div className={styles.summaryText}>{summary}</div>
    </section>
  );
}

function NoteInput({ onAdd }: { onAdd: (content: string) => void }) {
  const { t } = useTranslation('annotation');
  const [noteText, setNoteText] = useState("");
  const [previewing, setPreviewing] = useState(false);

  function handleSubmit() {
    if (!noteText.trim()) return;
    onAdd(noteText.trim());
    setNoteText("");
    setPreviewing(false);
  }

  return (
    <div className={styles.noteInputFixed}>
      <div className={styles.editContainer}>
        {noteText.trim() && (
          <button className={styles.previewToggle} onClick={() => setPreviewing(!previewing)}>
            {previewing ? t('edit') : t('preview')}
          </button>
        )}
        {previewing ? (
          <div className={styles.previewArea}><MarkdownContent content={noteText} /></div>
        ) : (
          <textarea
            ref={autoResize}
            className={styles.noteInput}
            value={noteText}
            onChange={(e) => { setNoteText(e.target.value); autoResize(e.target); }}
            placeholder={t('addNotePlaceholder')}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        )}
      </div>
      {noteText.trim() && (
        <div className={styles.commentActions}>
          <button className={styles.submitBtn} onClick={handleSubmit}>
            {t('save')}
          </button>
          <button className={styles.cancelBtn} onClick={() => { setNoteText(""); setPreviewing(false); }}>
            {t('cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
