import { useResources } from "@/hooks/useResources";
import * as cmd from "@/lib/commands";
import type { Resource } from "@/types";
import { Spinner } from "@/components/Spinner";
import styles from "./ResourceList.module.css";

interface ResourceListProps {
  folderId: string | null;
  selectedResourceId: string | null;
  selectedTagIds: Set<string>;
  sortBy: "created_at" | "captured_at";
  sortOrder: "asc" | "desc";
  onSelect: (resource: Resource) => void;
  onOpen: (resource: Resource) => void;
  onSortByChange: (sortBy: "created_at" | "captured_at") => void;
  onSortOrderChange: (sortOrder: "asc" | "desc") => void;
}

export function ResourceList({ folderId, selectedResourceId, selectedTagIds, sortBy, sortOrder, onSelect, onOpen, onSortByChange, onSortOrderChange }: ResourceListProps) {
  const { resources, resourceTags, loading, refresh } = useResources(folderId, sortBy, sortOrder);

  const filteredResources = selectedTagIds.size === 0
    ? resources
    : resources.filter((r) => {
        const tags = resourceTags[r.id] || [];
        return tags.some((t) => selectedTagIds.has(t.id));
      });

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
      <div className={styles.header}>
        <span className={styles.title}>资料</span>
        <div className={styles.sortControls}>
          <select
            className={styles.sortSelect}
            value={sortBy}
            onChange={(e) => onSortByChange(e.target.value as "created_at" | "captured_at")}
          >
            <option value="created_at">创建时间</option>
            <option value="captured_at">抓取时间</option>
          </select>
          <button
            className={styles.sortOrderBtn}
            onClick={() => onSortOrderChange(sortOrder === "desc" ? "asc" : "desc")}
            title={sortOrder === "desc" ? "降序" : "升序"}
          >
            {sortOrder === "desc" ? "↓" : "↑"}
          </button>
        </div>
      </div>
      {!folderId && (
        <div className={styles.empty}>选择文件夹查看资料</div>
      )}
      {loading && <Spinner />}
      {folderId && !loading && filteredResources.length === 0 && (
        <div className={styles.empty}>该文件夹暂无资料</div>
      )}
      {filteredResources.map((resource) => (
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
