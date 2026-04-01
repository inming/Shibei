import { useState } from "react";
import type { Resource } from "@/types";
import { useAnnotations } from "@/hooks/useAnnotations";
import styles from "./PreviewPanel.module.css";

interface PreviewPanelProps {
  resource: Resource;
  onOpenInReader: (highlightId?: string) => void;
}

export function PreviewPanel({ resource, onOpenInReader }: PreviewPanelProps) {
  const { highlights, getCommentsForHighlight, loading } = useAnnotations(resource.id);
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
        高亮 ({loading ? "..." : highlights.length})
      </div>

      {!loading && highlights.length === 0 && (
        <div className={styles.empty}>暂无高亮标注</div>
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
              {comments.length > 0 && (
                <span
                  className={styles.commentToggle}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedHighlightId(isExpanded ? null : hl.id);
                  }}
                >
                  💬 {comments.length} 条评论 {isExpanded ? "▲" : "▼"}
                </span>
              )}
            </div>

            {isExpanded && comments.length > 0 && (
              <div className={styles.commentList} onClick={(e) => e.stopPropagation()}>
                {comments.map((c) => (
                  <div key={c.id} className={styles.commentItem}>
                    {c.content}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
