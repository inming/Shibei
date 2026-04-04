import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Resource } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import { useAnnotations } from "@/hooks/useAnnotations";
import { PreviewPanelSkeleton } from "@/components/Skeleton";
import { ResourceMeta } from "@/components/ResourceMeta";
import styles from "./PreviewPanel.module.css";

interface PreviewPanelProps {
  resource: Resource;
  onOpenInReader: (highlightId?: string) => void;
  onNavigateToFolder?: (folderId: string) => void;
}

export function PreviewPanel({ resource: initialResource, onOpenInReader, onNavigateToFolder }: PreviewPanelProps) {
  const [resource, setResource] = useState<Resource>(initialResource);
  const { highlights, getCommentsForHighlight, resourceNotes, loading } = useAnnotations(resource.id);
  const [expandedHighlightId, setExpandedHighlightId] = useState<string | null>(null);

  useEffect(() => {
    setResource(initialResource);
  }, [initialResource]);

  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, () => {
      cmd.getResource(resource.id).then(setResource).catch(() => {});
    });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => {
      cmd.getResource(resource.id).then(setResource).catch(() => {});
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [resource.id]);

  return (
    <div className={styles.panel}>
      <ResourceMeta resource={resource} onNavigateToFolder={onNavigateToFolder} />

      <div className={styles.body}>
        {/* Highlights section */}
        <div className={styles.sectionLabel}>
          标注 ({loading ? "..." : highlights.length})
        </div>

        {loading && <PreviewPanelSkeleton />}

        {!loading && highlights.length === 0 && (
          <div className={styles.empty}>暂无标注</div>
        )}

        {!loading && highlights.map((hl) => {
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
    </div>
  );
}
