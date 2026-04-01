import { useState, useEffect, useCallback } from "react";
import { useFolders } from "@/hooks/useFolders";
import * as cmd from "@/lib/commands";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { FolderEditDialog } from "@/components/Sidebar/FolderEditDialog";
import styles from "./FolderTree.module.css";

interface FolderTreeProps {
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  folderId: string;
  folderName: string;
}

export function FolderTree({ selectedFolderId, onSelectFolder }: FolderTreeProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editFolder, setEditFolder] = useState<{ id: string; name: string } | null>(null);
  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});

  const loadCounts = useCallback(async () => {
    try {
      const counts = await cmd.getFolderCounts();
      setFolderCounts(counts);
    } catch (err) {
      console.error("Failed to load folder counts:", err);
    }
  }, []);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

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

  const parentId = selectedFolderId || "__root__";

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await cmd.createFolder(newName.trim(), parentId);
      setNewName("");
      setIsCreating(false);
      if (selectedFolderId) {
        setExpandedIds((prev) => new Set(prev).add(selectedFolderId));
      }
      loadCounts();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        alert("文件夹名称已存在，请换一个名称");
      } else {
        alert(`创建失败: ${msg}`);
      }
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`确定删除文件夹「${name}」及其所有资料吗？`)) return;
    try {
      await cmd.deleteFolder(id);
      loadCounts();
    } catch (err: unknown) {
      alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleContextMenu(e: React.MouseEvent, folderId: string, folderName: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, folderId, folderName });
  }

  const menuItems: MenuItem[] = contextMenu
    ? [
        {
          label: "编辑",
          onClick: () => setEditFolder({ id: contextMenu.folderId, name: contextMenu.folderName }),
        },
        {
          label: "删除",
          danger: true,
          onClick: () => handleDelete(contextMenu.folderId, contextMenu.folderName),
        },
      ]
    : [];

  return (
    <div className={styles.section}>
      <div className={styles.header}>
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

      <FolderNode
        parentId="__root__"
        depth={0}
        selectedFolderId={selectedFolderId}
        expandedIds={expandedIds}
        folderCounts={folderCounts}
        onSelect={onSelectFolder}
        onToggleExpand={toggleExpand}
        onContextMenu={handleContextMenu}
      />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {editFolder && (
        <FolderEditDialog
          folderId={editFolder.id}
          currentName={editFolder.name}
          onClose={() => setEditFolder(null)}
          onSaved={loadCounts}
        />
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
  folderCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, name: string) => void;
}

function FolderNode({
  parentId,
  depth,
  selectedFolderId,
  expandedIds,
  folderCounts,
  onSelect,
  onToggleExpand,
  onContextMenu,
}: FolderNodeProps) {
  const { folders, loading } = useFolders(parentId);

  if (loading && depth === 0) {
    return <div className={styles.empty}>加载中...</div>;
  }

  if (!loading && folders.length === 0 && depth === 0) {
    return <div className={styles.empty}>暂无文件夹</div>;
  }

  return (
    <>
      {folders.map((folder) => {
        const isExpanded = expandedIds.has(folder.id);
        const isSelected = selectedFolderId === folder.id;
        const count = folderCounts[folder.id];

        return (
          <div key={folder.id}>
            <div
              className={`${styles.item} ${isSelected ? styles.itemSelected : ""}`}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
              onClick={() => onSelect(folder.id)}
              onContextMenu={(e) => onContextMenu(e, folder.id, folder.name)}
            >
              <span
                className={styles.arrow}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(folder.id);
                }}
              >
                {isExpanded ? "▼" : "▶"}
              </span>
              <span className={styles.folderName}>📁 {folder.name}</span>
              {count ? <span className={styles.count}>{count}</span> : null}
            </div>
            {isExpanded && (
              <div className={styles.children}>
                <FolderNode
                  parentId={folder.id}
                  depth={depth + 1}
                  selectedFolderId={selectedFolderId}
                  expandedIds={expandedIds}
                  folderCounts={folderCounts}
                  onSelect={onSelect}
                  onToggleExpand={onToggleExpand}
                  onContextMenu={onContextMenu}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
