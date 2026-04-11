import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import type { Resource, Tag } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import { useAnnotations } from "@/hooks/useAnnotations";
import { ResourceMeta } from "@/components/ResourceMeta";
import styles from "./PreviewPanel.module.css";

interface PreviewPanelProps {
  resource: Resource;
  onOpenInReader: (highlightId?: string) => void;
  onNavigateToFolder?: (folderId: string) => void;
}

export function PreviewPanel({ resource: initialResource, onOpenInReader, onNavigateToFolder }: PreviewPanelProps) {
  const { t: tSidebar } = useTranslation('sidebar');
  const [resource, setResource] = useState<Resource>(initialResource);
  const { highlights, getCommentsForHighlight, resourceNotes, loading } = useAnnotations(resource.id);
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    setResource(initialResource);
  }, [initialResource]);

  useEffect(() => {
    cmd.getTagsForResource(resource.id).then(setTags).catch(() => {});
  }, [resource.id]);

  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, () => {
      cmd.getResource(resource.id).then(setResource).catch(() => {});
    });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => {
      cmd.getResource(resource.id).then(setResource).catch(() => {});
    });
    const u3 = listen(DataEvents.TAG_CHANGED, () => {
      cmd.getTagsForResource(resource.id).then(setTags).catch(() => {});
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
    };
  }, [resource.id]);

  return (
    <div className={styles.panel}>
      <ResourceMeta resource={resource} onNavigateToFolder={onNavigateToFolder} />

      <div className={styles.body}>
        {/* Summary section */}
        <div className={styles.summarySection}>
          <div className={styles.sectionLabel}>{tSidebar('previewSummary')}</div>
          <p className={styles.summaryText}>
            {resource.description || tSidebar('previewNoDescription')}
          </p>
        </div>

        {/* Stats section */}
        {!loading && (
          <div className={styles.statsSection}>
            <span className={styles.statsText}>
              {tSidebar('previewStats', {
                highlights: highlights.length,
                comments: highlights.reduce((sum, h) => sum + getCommentsForHighlight(h.id).length, 0),
                notes: resourceNotes.length,
              })}
            </span>
          </div>
        )}

        {/* Tags section */}
        {tags.length > 0 && (
          <div className={styles.tagsSection}>
            <div className={styles.sectionLabel}>{tSidebar('previewTags')}</div>
            <div className={styles.tagList}>
              {tags.map(tag => (
                <span key={tag.id} className={styles.tag} style={{ backgroundColor: tag.color + '20', color: tag.color }}>
                  {tag.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Open button */}
        <button className={styles.openButton} onClick={() => onOpenInReader()}>
          {tSidebar('previewOpenReader')}
        </button>
      </div>
    </div>
  );
}
