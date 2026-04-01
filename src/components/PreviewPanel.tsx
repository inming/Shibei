import { useState } from "react";
import type { Resource } from "@/types";
import { useAnnotations } from "@/hooks/useAnnotations";
import styles from "./PreviewPanel.module.css";

interface PreviewPanelProps {
  resource: Resource;
  onOpenInReader: (highlightId?: string) => void;
}

export function PreviewPanel({ resource, onOpenInReader }: PreviewPanelProps) {
  const { highlights, getCommentsForHighlight, resourceNotes, loading } = useAnnotations(resource.id);
  const [expandedHighlightId, setExpandedHighlightId] = useState<string | null>(null);

  const domain = resource.domain ?? (() => {
    try { return new URL(resource.url).hostname; } catch { return resource.url; }
  })();

  return (
    <div className={styles.panel}>
      {/* Meta section */}
      <div className={styles.metaSection}>
        <div className={styles.metaTitle}>{resource.title}</div>
        <div className={styles.metaDomain}>
          {domain} · {new Date(resource.created_at).toLocaleDateString()}
        </div>
      </div>

      <hr className={styles.divider} />

      {/* Highlights section */}
      <div className={styles.sectionLabel}>
        标注 ({loading ? "..." : highlights.length})
      </div>

      {!loading && highlights.length === 0 && (
        <div className={styles.empty}>暂无标注</div>
      )}

      {highlights.map((hl) => {
        const comments = getCommentsForHighlight(hl.id);
        const isExpanded = expandedHighlightId === hl.id;

        return (
          <div
            key={hl.id}
            className={styles.highlightItem}
            style={{ borderLeftColor: hl.color }}
            onClick={() => onOpenInReader(hl.id)}
          >
            <div className={styles.highlightText}>{hl.text_content}</div>
            <div className={styles.highlightMeta}>
              <span>{new Date(hl.created_at).toLocaleDateString()}</span>
            </div>

            {comments.length > 0 && (
              <div className={styles.commentList} onClick={(e) => e.stopPropagation()}>
                <div className={styles.commentItem}>{comments[0].content}</div>
                {comments.length > 1 && !isExpanded && (
                  <span
                    className={styles.commentToggle}
                    onClick={() => setExpandedHighlightId(hl.id)}
                  >
                    查看全部 {comments.length} 条评论
                  </span>
                )}
                {isExpanded && comments.slice(1).map((c) => (
                  <div key={c.id} className={styles.commentItem}>{c.content}</div>
                ))}
                {isExpanded && (
                  <span
                    className={styles.commentToggle}
                    onClick={() => setExpandedHighlightId(null)}
                  >
                    收起
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Notes section */}
      {!loading && resourceNotes.length > 0 && (
        <>
          <hr className={styles.divider} />
          <div className={styles.sectionLabel}>
            笔记 ({resourceNotes.length})
          </div>
          {resourceNotes.map((note) => (
            <div key={note.id} className={styles.noteItem}>
              <div className={styles.noteContent}>{note.content}</div>
              <div className={styles.noteMeta}>
                {new Date(note.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
