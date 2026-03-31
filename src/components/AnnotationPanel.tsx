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
}

export function AnnotationPanel({
  highlights,
  getCommentsForHighlight,
  activeHighlightId,
  onClickHighlight,
  onDeleteHighlight,
  onAddComment,
  onDeleteComment,
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
          />
        ))}
      </div>
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
}

import { forwardRef } from "react";

const HighlightEntry = forwardRef<HTMLDivElement, HighlightEntryProps>(
  function HighlightEntry(
    { highlight, comments, isActive, onClick, onDelete, onAddComment, onDeleteComment },
    ref,
  ) {
    const [showInput, setShowInput] = useState(false);
    const [commentText, setCommentText] = useState("");

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
                <div className={styles.commentContent}>{c.content}</div>
                <div className={styles.commentMeta}>
                  <span>{new Date(c.created_at).toLocaleDateString()}</span>
                  <button
                    className={styles.deleteBtn}
                    onClick={() => onDeleteComment(c.id)}
                  >
                    删除
                  </button>
                </div>
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
