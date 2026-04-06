import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Resource } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import { useAnnotations } from "@/hooks/useAnnotations";
import { PreviewPanelSkeleton } from "@/components/Skeleton";
import { ResourceMeta } from "@/components/ResourceMeta";
import { MarkdownContent } from "@/components/MarkdownContent";
import styles from "./PreviewPanel.module.css";

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query || query.length < 3) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "var(--color-accent-light)", borderRadius: 2, padding: "0 1px" }}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

interface PreviewPanelProps {
  resource: Resource;
  searchQuery?: string;
  onOpenInReader: (highlightId?: string) => void;
  onNavigateToFolder?: (folderId: string) => void;
}

export function PreviewPanel({ resource: initialResource, searchQuery, onOpenInReader, onNavigateToFolder }: PreviewPanelProps) {
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
              <div className={styles.highlightText}>{searchQuery ? highlightMatch(hl.text_content, searchQuery) : hl.text_content}</div>
              <div className={styles.highlightMeta}>
                <span>{new Date(hl.created_at).toLocaleDateString()}</span>
              </div>

              {comments.length > 0 && (
                <div className={styles.commentList} onClick={(e) => e.stopPropagation()}>
                  <div className={styles.commentItem}><MarkdownContent content={comments[0].content} searchQuery={searchQuery} /></div>
                  {comments.length > 1 && !isExpanded && (
                    <span
                      className={styles.commentToggle}
                      onClick={() => setExpandedHighlightId(hl.id)}
                    >
                      查看全部 {comments.length} 条评论
                    </span>
                  )}
                  {isExpanded && comments.slice(1).map((c) => (
                    <div key={c.id} className={styles.commentItem}><MarkdownContent content={c.content} searchQuery={searchQuery} /></div>
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
                <div className={styles.noteContent}><MarkdownContent content={note.content} searchQuery={searchQuery} /></div>
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
