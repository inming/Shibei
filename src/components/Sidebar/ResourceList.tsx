import { useState, useEffect, useCallback, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useResources } from "@/hooks/useResources";
import * as cmd from "@/lib/commands";
import type { Resource } from "@/types";
import { ResourceListSkeleton } from "@/components/Skeleton";
import { Modal } from "@/components/Modal";
import { ResourceContextMenu } from "@/components/Sidebar/ResourceContextMenu";
import { ResourceEditDialog } from "@/components/Sidebar/ResourceEditDialog";
import toast from "react-hot-toast";
import styles from "./ResourceList.module.css";

interface ResourceListProps {
  folderId: string | null;
  selectedResourceIds: Set<string>;
  selectedTagIds: Set<string>;
  sortBy: "created_at" | "annotated_at";
  sortOrder: "asc" | "desc";
  refreshKey: number;
  onSelectResource: (resource: Resource, resources: Resource[], event: { metaKey: boolean; shiftKey: boolean }) => void;
  onOpen: (resource: Resource) => void;
  onSortByChange: (sortBy: "created_at" | "annotated_at") => void;
  onSortOrderChange: (sortOrder: "asc" | "desc") => void;
  onDataChanged?: () => void;
}

function DraggableResourceItem({ resource, isSelected, onClick, onDoubleClick, onContextMenu }: {
  resource: Resource;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: resource.id,
    data: { type: "resource", title: resource.title },
  });

  return (
    <div
      ref={setNodeRef}
      className={`${styles.item} ${isSelected ? styles.itemSelected : ""}`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="option"
      aria-selected={isSelected}
    >
      <div className={styles.itemTitle}>
        {resource.selection_meta && <span className={styles.clipBadge} title="选区保存">&#9986;</span>}
        {resource.title}
      </div>
      <div className={styles.itemMeta}>
        <span>{resource.domain ?? new URL(resource.url).hostname} · {new Date(resource.created_at).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

export function ResourceList({ folderId, selectedResourceIds, selectedTagIds, sortBy, sortOrder, refreshKey, onSelectResource, onOpen, onSortByChange, onSortOrderChange, onDataChanged }: ResourceListProps) {
  const { resources, resourceTags, loading, refresh } = useResources(folderId, sortBy, sortOrder);
  const listRef = useRef<HTMLDivElement>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [contextResourceIds, setContextResourceIds] = useState<string[]>([]);
  const [editingResource, setEditingResource] = useState<Resource | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Refresh when refreshKey changes (e.g. after resource move)
  useEffect(() => {
    if (refreshKey > 0) {
      refresh();
    }
  }, [refreshKey, refresh]);

  const filteredResources = selectedTagIds.size === 0
    ? resources
    : resources.filter((r) => {
        const tags = resourceTags[r.id] || [];
        return tags.some((t) => selectedTagIds.has(t.id));
      });

  function handleContextMenu(e: React.MouseEvent, resource: Resource) {
    e.preventDefault();
    e.stopPropagation();

    // If right-clicked item is not in selection, single-select it
    if (!selectedResourceIds.has(resource.id)) {
      onSelectResource(resource, filteredResources, { metaKey: false, shiftKey: false });
      setContextResourceIds([resource.id]);
    } else {
      setContextResourceIds(Array.from(selectedResourceIds));
    }

    setContextMenu({ x: e.clientX, y: e.clientY });
  }

  const handleDelete = useCallback(async () => {
    setDeleteConfirm(false);
    setContextMenu(null);
    try {
      for (const id of contextResourceIds) {
        await cmd.deleteResource(id);
      }
      refresh();
      onDataChanged?.();
    } catch (err: unknown) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [contextResourceIds, refresh, onDataChanged]);

  const handleMove = useCallback(async (targetFolderId: string) => {
    setContextMenu(null);
    try {
      for (const id of contextResourceIds) {
        await cmd.moveResource(id, targetFolderId);
      }
      refresh();
      onDataChanged?.();
    } catch (err: unknown) {
      toast.error(`移动失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [contextResourceIds, refresh, onDataChanged]);

  const handleEdit = useCallback(() => {
    if (contextResourceIds.length !== 1) return;
    const resource = resources.find((r) => r.id === contextResourceIds[0]);
    if (resource) {
      setEditingResource(resource);
    }
    setContextMenu(null);
  }, [contextResourceIds, resources]);

  const isSingleSelect = contextResourceIds.length === 1;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (filteredResources.length === 0) return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Find the last selected resource index
      let currentIndex = -1;
      for (let i = filteredResources.length - 1; i >= 0; i--) {
        if (selectedResourceIds.has(filteredResources[i].id)) {
          currentIndex = i;
          break;
        }
      }

      let nextIndex: number;
      if (e.key === "ArrowDown") {
        nextIndex = currentIndex < filteredResources.length - 1 ? currentIndex + 1 : currentIndex;
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : 0;
      }

      onSelectResource(filteredResources[nextIndex], filteredResources, { metaKey: false, shiftKey: false });
    } else if (e.key === "Enter") {
      // Open the last selected resource
      for (let i = filteredResources.length - 1; i >= 0; i--) {
        if (selectedResourceIds.has(filteredResources[i].id)) {
          onOpen(filteredResources[i]);
          break;
        }
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedResourceIds.size > 0) {
        setContextResourceIds(Array.from(selectedResourceIds));
        setDeleteConfirm(true);
      }
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <span className={styles.title}>
          资料
          {selectedResourceIds.size > 1 && (
            <span className={styles.selectionCount}>已选 {selectedResourceIds.size} 项</span>
          )}
        </span>
        <div className={styles.sortControls}>
          <select
            className={styles.sortSelect}
            value={sortBy}
            onChange={(e) => onSortByChange(e.target.value as "created_at" | "annotated_at")}
          >
            <option value="created_at">创建时间</option>
            <option value="annotated_at">标注时间</option>
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
      {loading && <ResourceListSkeleton />}
      {folderId && !loading && filteredResources.length === 0 && (
        <div className={styles.empty}>该文件夹暂无资料</div>
      )}
      <div
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="资料列表"
        onKeyDown={handleKeyDown}
      >
        {filteredResources.map((resource) => (
          <DraggableResourceItem
            key={resource.id}
            resource={resource}
            isSelected={selectedResourceIds.has(resource.id)}
            onClick={(e) => onSelectResource(resource, filteredResources, { metaKey: e.metaKey, shiftKey: e.shiftKey })}
            onDoubleClick={() => onOpen(resource)}
            onContextMenu={(e) => handleContextMenu(e, resource)}
          />
        ))}
      </div>

      {contextMenu && folderId && (
        <ResourceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          resourceIds={contextResourceIds}
          currentFolderId={folderId}
          isSingleSelect={isSingleSelect}
          onEdit={handleEdit}
          onDelete={() => {
            setContextMenu(null);
            setDeleteConfirm(true);
          }}
          onMove={handleMove}
          onTagsChanged={() => { refresh(); onDataChanged?.(); }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {editingResource && (
        <ResourceEditDialog
          resource={editingResource}
          onSave={refresh}
          onClose={() => setEditingResource(null)}
        />
      )}

      {deleteConfirm && (
        <Modal title="确认删除" onClose={() => setDeleteConfirm(false)}>
          <p>
            {isSingleSelect
              ? `确定删除该资料吗？`
              : `确定删除选中的 ${contextResourceIds.length} 项资料吗？`}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button
              style={{
                padding: "6px 14px",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                background: "none",
                color: "var(--color-text-primary)",
                fontSize: "var(--font-size-sm)",
                cursor: "pointer",
              }}
              onClick={() => setDeleteConfirm(false)}
            >
              取消
            </button>
            <button
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 4,
                background: "var(--color-danger)",
                color: "white",
                fontSize: "var(--font-size-sm)",
                cursor: "pointer",
              }}
              onClick={handleDelete}
            >
              删除
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
