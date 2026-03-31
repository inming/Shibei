import { useState } from "react";
import { useFolders } from "@/hooks/useFolders";
import * as cmd from "@/lib/commands";
import styles from "./FolderTree.module.css";

interface FolderTreeProps {
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
}

export function FolderTree({ selectedFolderId, onSelectFolder }: FolderTreeProps) {
  const { folders, refresh } = useFolders("__root__");
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await cmd.createFolder(newName.trim(), "__root__");
      setNewName("");
      setIsCreating(false);
      refresh();
    } catch (err) {
      console.error("Failed to create folder:", err);
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

      {folders.length === 0 && !isCreating && (
        <div className={styles.empty}>暂无文件夹</div>
      )}

      {folders.map((folder) => (
        <div
          key={folder.id}
          className={`${styles.item} ${selectedFolderId === folder.id ? styles.itemSelected : ""}`}
          onClick={() => onSelectFolder(folder.id)}
        >
          📁 {folder.name}
        </div>
      ))}
    </div>
  );
}
