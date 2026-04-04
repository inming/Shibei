import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Resource, Tag } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import { useAnnotations } from "@/hooks/useAnnotations";
import { PreviewPanelSkeleton } from "@/components/Skeleton";
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
  const [tags, setTags] = useState<Tag[]>([]);
  const [folderName, setFolderName] = useState<string>("");

  useEffect(() => {
    setResource(initialResource);
  }, [initialResource]);

  useEffect(() => {
    cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
  }, [resource.id]);

  useEffect(() => {
    cmd.getFolder(resource.folder_id).then((f) => setFolderName(f.name)).catch(() => setFolderName(""));
  }, [resource.folder_id]);

  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, () => {
      cmd.getResource(resource.id).then(setResource).catch(() => {});
      cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
    });
    const u2 = listen(DataEvents.TAG_CHANGED, () => {
      cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
    });
    const u3 = listen(DataEvents.SYNC_COMPLETED, () => {
      cmd.getResource(resource.id).then(setResource).catch(() => {});
      cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
      cmd.getFolder(resource.folder_id).then((f) => setFolderName(f.name)).catch(() => setFolderName(""));
    });
    const u4 = listen(DataEvents.FOLDER_CHANGED, () => {
      cmd.getFolder(resource.folder_id).then((f) => setFolderName(f.name)).catch(() => setFolderName(""));
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
      u4.then((f) => f());
    };
  }, [resource.id, resource.folder_id]);

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
        {folderName && (
          <div
            className={styles.metaFolder}
            onClick={() => onNavigateToFolder?.(resource.folder_id)}
          >
            📁 {folderName}
          </div>
        )}
        <div className={styles.metaUrl} title={resource.url}>
          {resource.url}
        </div>
        {tags.length > 0 && (
          <div className={styles.tagRow}>
            {tags.map((tag) => (
              <span key={tag.id} className={styles.tagBadge}>
                <span className={styles.tagDot} style={{ backgroundColor: tag.color }} />
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <hr className={styles.divider} />

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
  );
}
