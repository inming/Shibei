import { useResources } from "@/hooks/useResources";
import * as cmd from "@/lib/commands";
import type { Resource } from "@/types";
import styles from "./ResourceList.module.css";

interface ResourceListProps {
  folderId: string | null;
  selectedResourceId: string | null;
  onSelect: (resource: Resource) => void;
  onOpen: (resource: Resource) => void;
}

export function ResourceList({ folderId, selectedResourceId, onSelect, onOpen }: ResourceListProps) {
  const { resources, loading, refresh } = useResources(folderId);

  async function handleDelete(e: React.MouseEvent, resource: Resource) {
    e.stopPropagation();
    if (!window.confirm(`确定删除资料「${resource.title}」吗？`)) return;
    try {
      await cmd.deleteResource(resource.id);
      refresh();
    } catch (err: unknown) {
      alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.title}>资料</div>
      {!folderId && (
        <div className={styles.empty}>选择文件夹查看资料</div>
      )}
      {loading && <div className={styles.empty}>加载中...</div>}
      {folderId && !loading && resources.length === 0 && (
        <div className={styles.empty}>该文件夹暂无资料</div>
      )}
      {resources.map((resource) => (
        <div
          key={resource.id}
          className={`${styles.item} ${selectedResourceId === resource.id ? styles.itemSelected : ""}`}
          onClick={() => onSelect(resource)}
          onDoubleClick={() => onOpen(resource)}
        >
          <div className={styles.itemTitle}>
            {resource.selection_meta && <span className={styles.clipBadge} title="选区保存">&#9986;</span>}
            {resource.title}
          </div>
          <div className={styles.itemMeta}>
            <span>{resource.domain ?? new URL(resource.url).hostname} · {new Date(resource.created_at).toLocaleDateString()}</span>
            <button
              className={styles.deleteBtn}
              onClick={(e) => handleDelete(e, resource)}
              title="删除资料"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
