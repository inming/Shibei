import { useState } from "react";
import { useFolders } from "@/hooks/useFolders";
import * as cmd from "@/lib/commands";
import styles from "./FolderTree.module.css";

interface FolderTreeProps {
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
}

export function FolderTree({ selectedFolderId, onSelectFolder }: FolderTreeProps) {
  const { folders, loading, refresh } = useFolders("__root__");
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await cmd.createFolder(newName.trim(), "__root__");
      setNewName("");
      setIsCreating(false);
      refresh();
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
      refresh();
    } catch (err: unknown) {
      alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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

      {loading && <div className={styles.empty}>加载中...</div>}

      {!loading && folders.length === 0 && !isCreating && (
        <div className={styles.empty}>暂无文件夹</div>
      )}

      {folders.map((folder) => (
        <div
          key={folder.id}
          className={`${styles.item} ${selectedFolderId === folder.id ? styles.itemSelected : ""}`}
          onClick={() => onSelectFolder(folder.id)}
        >
          <span style={{ flex: 1 }}>📁 {folder.name}</span>
          <button
            className={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(folder.id, folder.name);
            }}
            title="删除文件夹"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
