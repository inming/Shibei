import { useResources } from "@/hooks/useResources";
import type { Resource } from "@/types";
import styles from "./ResourceList.module.css";

interface ResourceListProps {
  folderId: string | null;
  selectedResourceId: string | null;
  onSelectResource: (resource: Resource) => void;
}

export function ResourceList({ folderId, selectedResourceId, onSelectResource }: ResourceListProps) {
  const { resources } = useResources(folderId);

  return (
    <div className={styles.section}>
      <div className={styles.title}>资料</div>
      {!folderId && (
        <div className={styles.empty}>选择文件夹查看资料</div>
      )}
      {folderId && resources.length === 0 && (
        <div className={styles.empty}>该文件夹暂无资料</div>
      )}
      {resources.map((resource) => (
        <div
          key={resource.id}
          className={`${styles.item} ${selectedResourceId === resource.id ? styles.itemSelected : ""}`}
          onClick={() => onSelectResource(resource)}
        >
          <div className={styles.itemTitle}>{resource.title}</div>
          <div className={styles.itemMeta}>
            {resource.domain ?? new URL(resource.url).hostname} · {new Date(resource.created_at).toLocaleDateString()}
          </div>
        </div>
      ))}
    </div>
  );
}
