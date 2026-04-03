import { useState, useEffect, useCallback, useRef } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { listen } from "@tauri-apps/api/event";
import { useFolders } from "@/hooks/useFolders";
import type { Folder } from "@/types";
import * as cmd from "@/lib/commands";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { FolderEditDialog } from "@/components/Sidebar/FolderEditDialog";
import { Spinner } from "@/components/Spinner";
import { Modal } from "@/components/Modal";
import styles from "./FolderTree.module.css";

interface FolderTreeProps {
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
  onRefreshRef?: React.MutableRefObject<(() => void) | null>;
}

interface ContextMenuState {
  x: number;
  y: number;
  folderId: string;
  folderName: string;
}

export function FolderTree({ selectedFolderId, onSelectFolder, onRefreshRef }: FolderTreeProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editFolder, setEditFolder] = useState<{ id: string; name: string } | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<{ id: string; name: string } | null>(null);
  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});
  const [nonLeafIds, setNonLeafIds] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);

  const loadMeta = useCallback(async () => {
    try {
      const [counts, ids] = await Promise.all([
        cmd.getFolderCounts(),
        cmd.getNonLeafFolderIds(),
      ]);
      setFolderCounts(counts);
      setNonLeafIds(new Set(ids));
    } catch (err) {
      console.error("Failed to load folder metadata:", err);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  // Refresh folder counts when a new resource is saved via the extension
  useEffect(() => {
    const unlisten = listen("resource-saved", () => {
      loadMeta();
    });
    return () => { unlisten.then((f) => f()); };
  }, [loadMeta]);

  function refreshAll() {
    setRefreshKey((k) => k + 1);
    loadMeta();
  }

  useEffect(() => {
    if (onRefreshRef) {
      onRefreshRef.current = refreshAll;
    }
    return () => {
      if (onRefreshRef) {
        onRefreshRef.current = null;
      }
    };
  });

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await cmd.createFolder(newName.trim(), "__root__");
      setNewName("");
      setIsCreating(false);
      refreshAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        alert("文件夹名称已存在，请换一个名称");
      } else {
        alert(`创建失败: ${msg}`);
      }
    }
  }

  async function doDelete(id: string) {
    try {
      await cmd.deleteFolder(id);
      setDeleteFolder(null);
      refreshAll();
    } catch (err: unknown) {
      alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleContextMenu(e: React.MouseEvent, folderId: string, folderName: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, folderId, folderName });
  }

  const [subfolderTarget, setSubfolderTarget] = useState<string | null>(null);
  const [subfolderName, setSubfolderName] = useState("");

  async function handleCreateSubfolder() {
    if (!subfolderTarget || !subfolderName.trim()) return;
    try {
      await cmd.createFolder(subfolderName.trim(), subfolderTarget);
      setSubfolderName("");
      setSubfolderTarget(null);
      setExpandedIds((prev) => new Set(prev).add(subfolderTarget));
      refreshAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        alert("文件夹名称已存在，请换一个名称");
      } else {
        alert(`创建失败: ${msg}`);
      }
    }
  }

  const treeRef = useRef<HTMLDivElement>(null);

  /** Collect visible folder IDs from DOM data-folder-id attributes in tree order. */
  function getVisibleFolderIds(): string[] {
    if (!treeRef.current) return [];
    const items = treeRef.current.querySelectorAll("[data-folder-id]");
    return Array.from(items).map((el) => el.getAttribute("data-folder-id")!);
  }

  function handleTreeKeyDown(e: React.KeyboardEvent) {
    const visibleIds = getVisibleFolderIds();
    if (visibleIds.length === 0) return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const currentIndex = selectedFolderId ? visibleIds.indexOf(selectedFolderId) : -1;

      let nextIndex: number;
      if (e.key === "ArrowDown") {
        nextIndex = currentIndex < visibleIds.length - 1 ? currentIndex + 1 : currentIndex;
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : 0;
      }

      onSelectFolder(visibleIds[nextIndex]);
    } else if (e.key === "ArrowRight") {
      if (selectedFolderId && nonLeafIds.has(selectedFolderId) && !expandedIds.has(selectedFolderId)) {
        e.preventDefault();
        toggleExpand(selectedFolderId);
      }
    } else if (e.key === "ArrowLeft") {
      if (selectedFolderId && expandedIds.has(selectedFolderId)) {
        e.preventDefault();
        toggleExpand(selectedFolderId);
      }
    }
  }

  const menuItems: MenuItem[] = contextMenu
    ? [
        {
          label: "新建子文件夹",
          onClick: () => {
            setSubfolderTarget(contextMenu.folderId);
            setSubfolderName("");
          },
        },
        {
          label: "编辑",
          onClick: () => setEditFolder({ id: contextMenu.folderId, name: contextMenu.folderName }),
        },
        {
          label: "删除",
          danger: true,
          onClick: () => setDeleteFolder({ id: contextMenu.folderId, name: contextMenu.folderName }),
        },
      ]
    : [];

  const { setNodeRef: setRootDropRef, isOver: isRootOver } = useDroppable({
    id: "folder-drop-__root__",
    data: { type: "folder-target", folderId: "__root__" },
  });

  return (
    <div className={styles.section}>
      <div
        ref={setRootDropRef}
        className={`${styles.header} ${isRootOver ? styles.dropTarget : ""}`}
      >
        <span className={styles.title}>文件夹</span>
        <button
          className={styles.addButton}
          onClick={() => setIsCreating(!isCreating)}
          title="新建文件夹"
        >
          +
        </button>
      </div>

      {isCreating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          style={{ padding: "0 8px 8px" }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="文件夹名称..."
            autoFocus
            style={{
              width: "100%",
              padding: "4px 8px",
              border: "1px solid var(--color-border)",
              borderRadius: "4px",
              fontSize: "var(--font-size-sm)",
            }}
            onBlur={() => {
              if (!newName.trim()) setIsCreating(false);
            }}
          />
        </form>
      )}

      <div
        ref={treeRef}
        tabIndex={0}
        role="tree"
        aria-label="文件夹"
        onKeyDown={handleTreeKeyDown}
      >
        <FolderNode
          parentId="__root__"
          depth={0}
          selectedFolderId={selectedFolderId}
          expandedIds={expandedIds}
          nonLeafIds={nonLeafIds}
          folderCounts={folderCounts}
          refreshKey={refreshKey}
          onSelect={onSelectFolder}
          onToggleExpand={toggleExpand}
          onContextMenu={handleContextMenu}
        />
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {subfolderTarget && (
        <Modal title="新建子文件夹" onClose={() => setSubfolderTarget(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateSubfolder();
            }}
          >
            <input
              value={subfolderName}
              onChange={(e) => setSubfolderName(e.target.value)}
              placeholder="子文件夹名称..."
              autoFocus
              style={{
                width: "100%",
                padding: "var(--spacing-xs) var(--spacing-sm)",
                border: "1px solid var(--color-border)",
                borderRadius: "4px",
                fontSize: "var(--font-size-base)",
                marginBottom: "var(--spacing-lg)",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)" }}>
              <button
                type="button"
                onClick={() => setSubfolderTarget(null)}
                style={{
                  padding: "var(--spacing-xs) var(--spacing-md)",
                  borderRadius: "4px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-primary)",
                  cursor: "pointer",
                  fontSize: "var(--font-size-base)",
                }}
              >
                取消
              </button>
              <button
                type="submit"
                style={{
                  padding: "var(--spacing-xs) var(--spacing-md)",
                  borderRadius: "4px",
                  border: "none",
                  background: "var(--color-accent)",
                  color: "white",
                  cursor: "pointer",
                  fontSize: "var(--font-size-base)",
                }}
              >
                创建
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editFolder && (
        <FolderEditDialog
          folderId={editFolder.id}
          currentName={editFolder.name}
          onClose={() => setEditFolder(null)}
          onSaved={refreshAll}
        />
      )}

      {deleteFolder && (
        <Modal title="删除文件夹" onClose={() => setDeleteFolder(null)}>
          <p style={{ marginBottom: "var(--spacing-lg)" }}>
            确定删除文件夹「{deleteFolder.name}」及其所有资料吗？
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)" }}>
            <button
              onClick={() => setDeleteFolder(null)}
              style={{
                padding: "var(--spacing-xs) var(--spacing-md)",
                borderRadius: "4px",
                border: "1px solid var(--color-border)",
                background: "var(--color-bg-primary)",
                cursor: "pointer",
                fontSize: "var(--font-size-base)",
              }}
            >
              取消
            </button>
            <button
              onClick={() => doDelete(deleteFolder.id)}
              style={{
                padding: "var(--spacing-xs) var(--spacing-md)",
                borderRadius: "4px",
                border: "none",
                background: "var(--color-danger)",
                color: "white",
                cursor: "pointer",
                fontSize: "var(--font-size-base)",
              }}
            >
              删除
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Recursive FolderNode ──

interface FolderNodeProps {
  parentId: string;
  depth: number;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  nonLeafIds: Set<string>;
  folderCounts: Record<string, number>;
  refreshKey: number;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, name: string) => void;
}

function FolderNode({
  parentId,
  depth,
  selectedFolderId,
  expandedIds,
  nonLeafIds,
  folderCounts,
  refreshKey,
  onSelect,
  onToggleExpand,
  onContextMenu,
}: FolderNodeProps) {
  const { folders, loading } = useFolders(parentId, refreshKey);

  if (loading && depth === 0) {
    return <Spinner />;
  }

  if (!loading && folders.length === 0 && depth === 0) {
    return <div className={styles.empty}>暂无文件夹</div>;
  }

  return (
    <>
      {folders.map((folder) => (
        <DraggableFolderItem
          key={folder.id}
          folder={folder}
          depth={depth}
          selectedFolderId={selectedFolderId}
          expandedIds={expandedIds}
          nonLeafIds={nonLeafIds}
          folderCounts={folderCounts}
          refreshKey={refreshKey}
          onSelect={onSelect}
          onToggleExpand={onToggleExpand}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}

// ── Draggable + Droppable folder item ──

interface DraggableFolderItemProps {
  folder: Folder;
  depth: number;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  nonLeafIds: Set<string>;
  folderCounts: Record<string, number>;
  refreshKey: number;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, name: string) => void;
}

function DraggableFolderItem({
  folder,
  depth,
  selectedFolderId,
  expandedIds,
  nonLeafIds,
  folderCounts,
  refreshKey,
  onSelect,
  onToggleExpand,
  onContextMenu,
}: DraggableFolderItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: folder.id,
    data: { type: "folder", title: folder.name, parentId: folder.parent_id },
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder-drop-${folder.id}`,
    data: { type: "folder-target", folderId: folder.id },
  });

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );

  const isExpanded = expandedIds.has(folder.id);
  const hasChildren = nonLeafIds.has(folder.id);
  const isSelected = selectedFolderId === folder.id;
  const count = folderCounts[folder.id];

  return (
    <div ref={ref} style={{ opacity: isDragging ? 0.4 : 1 }}>
      <div
        className={`${styles.item} ${isSelected ? styles.itemSelected : ""} ${isOver ? styles.dropTarget : ""}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        data-folder-id={folder.id}
        {...attributes}
        {...listeners}
        onClick={() => onSelect(folder.id)}
        onContextMenu={(e) => onContextMenu(e, folder.id, folder.name)}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isExpanded : undefined}
      >
        {hasChildren ? (
          <span
            className={styles.arrow}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(folder.id);
            }}
          >
            {isExpanded ? "▼" : "▶"}
          </span>
        ) : (
          <span className={styles.arrow} />
        )}
        <span className={styles.folderName}>📁 {folder.name}</span>
        {count ? <span className={styles.count}>{count}</span> : null}
      </div>
      {isExpanded && hasChildren && (
        <div className={styles.children}>
          <FolderNode
            parentId={folder.id}
            depth={depth + 1}
            selectedFolderId={selectedFolderId}
            expandedIds={expandedIds}
            nonLeafIds={nonLeafIds}
            folderCounts={folderCounts}
            refreshKey={refreshKey}
            onSelect={onSelect}
            onToggleExpand={onToggleExpand}
            onContextMenu={onContextMenu}
          />
        </div>
      )}
    </div>
  );
}
