import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import type { Resource } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import { useAnnotations } from "@/hooks/useAnnotations";
import { ResourceMeta } from "@/components/ResourceMeta";
import { MarkdownContent } from "@/components/MarkdownContent";
import styles from "./PreviewPanel.module.css";

interface PreviewPanelProps {
  resource: Resource;
  onNavigateToFolder?: (folderId: string) => void;
}

export function PreviewPanel({ resource: initialResource, onNavigateToFolder }: PreviewPanelProps) {
  const { t: tSidebar } = useTranslation('sidebar');
  const { t: tAnnotation } = useTranslation('annotation');
  const [resource, setResource] = useState<Resource>(initialResource);
  const { highlights, getCommentsForHighlight, resourceNotes, loading } = useAnnotations(resource.id);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    setResource(initialResource);
  }, [initialResource]);

  useEffect(() => {
    cmd.getResourceSummary(resource.id, 200).then(setSummary).catch(() => {});
  }, [resource.id]);

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
        {/* Summary section */}
        <div className={styles.summarySection}>
          <div className={styles.sectionLabel}>{tSidebar('previewSummary')}</div>
          <p className={styles.summaryText}>
            {resource.description || summary || tSidebar('previewNoDescription')}
          </p>
        </div>

        {/* Highlights & comments */}
        {!loading && highlights.length > 0 && (
          <div className={styles.annotationsSection}>
            <div className={styles.sectionLabel}>
              {tAnnotation('annotationsCount', { count: highlights.length })}
            </div>
            {highlights.map((hl) => {
              const comments = getCommentsForHighlight(hl.id);
              return (
                <div key={hl.id} className={styles.highlightItem} style={{ borderLeftColor: hl.color }}>
                  <div className={styles.highlightText}>{hl.text_content}</div>
                  {comments.map((c) => (
                    <div key={c.id} className={styles.commentItem}>
                      <MarkdownContent content={c.content} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* Notes */}
        {!loading && resourceNotes.length > 0 && (
          <div className={styles.annotationsSection}>
            <div className={styles.sectionLabel}>{tAnnotation('notes')} ({resourceNotes.length})</div>
            {resourceNotes.map((note) => (
              <div key={note.id} className={styles.noteItem}>
                <MarkdownContent content={note.content} />
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
