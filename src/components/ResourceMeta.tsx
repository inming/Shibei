import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import type { Resource, Tag, Folder } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import styles from "./ResourceMeta.module.css";

interface ResourceMetaProps {
  resource: Resource;
  onNavigateToFolder?: (folderId: string) => void;
}

export function ResourceMeta({ resource, onNavigateToFolder }: ResourceMetaProps) {
  const { t } = useTranslation('sidebar');
  const [tags, setTags] = useState<Tag[]>([]);
  const [folderPath, setFolderPath] = useState<Folder[]>([]);

  useEffect(() => {
    cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
  }, [resource.id]);

  useEffect(() => {
    cmd.getFolderPath(resource.folder_id).then(setFolderPath).catch(() => setFolderPath([]));
  }, [resource.folder_id]);

  useEffect(() => {
    const u1 = listen(DataEvents.TAG_CHANGED, () => {
      cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
    });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => {
      cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
      cmd.getFolderPath(resource.folder_id).then(setFolderPath).catch(() => setFolderPath([]));
    });
    const u3 = listen(DataEvents.FOLDER_CHANGED, () => {
      cmd.getFolderPath(resource.folder_id).then(setFolderPath).catch(() => setFolderPath([]));
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
    };
  }, [resource.id, resource.folder_id]);

  return (
    <div className={styles.meta}>
      <div className={styles.title}>{resource.title}</div>
      <table className={styles.table}>
        <tbody>
          <tr>
            <td className={styles.label}>{t('metaUrl')}</td>
            <td className={styles.value}>
              <div className={styles.urlRow}>
                <span className={styles.url}>{resource.url}</span>
                <button
                  className={styles.urlOpenBtn}
                  title={t('metaOpenInBrowser')}
                  onClick={() => import("@tauri-apps/plugin-opener").then((mod) => mod.openUrl(resource.url))}
                >
                  ↗
                </button>
              </div>
            </td>
          </tr>
          <tr>
            <td className={styles.label}>{t('metaSavedAt')}</td>
            <td className={styles.value}>
              {new Date(resource.created_at).toLocaleString()}
            </td>
          </tr>
          {folderPath.length > 0 && (
            <tr>
              <td className={styles.label}>{t('metaFolder')}</td>
              <td className={styles.value}>
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
              <td className={styles.label}>{t('metaTags')}</td>
              <td className={styles.value}>
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
  );
}
