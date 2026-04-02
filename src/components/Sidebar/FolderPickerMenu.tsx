import { useState, useEffect } from "react";
import * as cmd from "@/lib/commands";
import type { Folder } from "@/types";
import styles from "./FolderPickerMenu.module.css";

interface FolderEntry extends Folder {
  depth: number;
}

interface FolderPickerMenuProps {
  currentFolderId?: string;
  onSelect: (folderId: string) => void;
}

export function FolderPickerMenu({ currentFolderId, onSelect }: FolderPickerMenuProps) {
  const [entries, setEntries] = useState<FolderEntry[]>([]);

  useEffect(() => {
    async function loadAll() {
      const result: FolderEntry[] = [];
      async function walk(parentId: string, depth: number) {
        const children = await cmd.listFolders(parentId);
        for (const child of children) {
          result.push({ ...child, depth });
          await walk(child.id, depth + 1);
        }
      }
      await walk("__root__", 0);
      setEntries(result);
    }
    loadAll();
  }, []);

  return (
    <div className={styles.picker}>
      {entries.map((folder) => (
        <button
          key={folder.id}
          className={`${styles.item} ${folder.id === currentFolderId ? styles.current : ""}`}
          style={{ paddingLeft: 10 + folder.depth * 16 }}
          onClick={() => onSelect(folder.id)}
          disabled={folder.id === currentFolderId}
        >
          {folder.name}
        </button>
      ))}
    </div>
  );
}
