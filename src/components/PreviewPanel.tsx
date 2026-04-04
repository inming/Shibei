import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Resource, Tag, Folder } from "@/types";
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
  const [folderPath, setFolderPath] = useState<Folder[]>([]);

  useEffect(() => {
    setResource(initialResource);
  }, [initialResource]);

  useEffect(() => {
    cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
  }, [resource.id]);

  useEffect(() => {
    cmd.getFolderPath(resource.folder_id).then(setFolderPath).catch(() => setFolderPath([]));
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
      cmd.getFolderPath(resource.folder_id).then(setFolderPath).catch(() => setFolderPath([]));
    });
    const u4 = listen(DataEvents.FOLDER_CHANGED, () => {
      cmd.getFolderPath(resource.folder_id).then(setFolderPath).catch(() => setFolderPath([]));
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
      u4.then((f) => f());
    };
  }, [resource.id, resource.folder_id]);

  return (
    <div className={styles.panel}>
      {/* Meta section */}
      <div className={styles.metaSection}>
        <div className={styles.metaTitle}>{resource.title}</div>

        <table className={styles.metaTable}>
          <tbody>
            <tr>
              <td className={styles.metaLabel}>网址</td>
              <td className={styles.metaValue}>
                <a
                  className={styles.metaUrl}
                  href={resource.url}
                  title={resource.url}
                  onClick={(e) => {
                    e.preventDefault();
                    import("@tauri-apps/plugin-opener").then((mod) => mod.openUrl(resource.url));
                  }}
                >
                  {resource.url}
                </a>
              </td>
            </tr>
            <tr>
              <td className={styles.metaLabel}>收藏时间</td>
              <td className={styles.metaValue}>
                {new Date(resource.created_at).toLocaleString()}
              </td>
            </tr>
            {folderPath.length > 0 && (
              <tr>
                <td className={styles.metaLabel}>文件夹</td>
                <td className={styles.metaValue}>
                  <span className={styles.breadcrumb}>
                    {folderPath.map((f, i) => (
                      <span key={f.id}>
                        {i > 0 && <span className={styles.breadcrumbSep}>/</span>}
                        <span
                          className={styles.breadcrumbItem}
                          onClick={() => onNavigateToFolder?.(f.id)}
                        >
                          {f.name}
                        </span>
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            )}
            {tags.length > 0 && (
              <tr>
                <td className={styles.metaLabel}>标签</td>
                <td className={styles.metaValue}>
                  <div className={styles.tagRow}>
                    {tags.map((tag) => (
                      <span key={tag.id} className={styles.tagBadge}>
                        <span className={styles.tagDot} style={{ backgroundColor: tag.color }} />
                        {tag.name}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
