import { useState } from "react";
import type { Resource } from "@/types";
import { FolderTree } from "@/components/Sidebar/FolderTree";
import { TagFilter } from "@/components/Sidebar/TagFilter";
import { ResourceList } from "@/components/Sidebar/ResourceList";
import styles from "./Layout.module.css";

interface LibraryViewProps {
  onOpenResource: (resource: Resource) => void;
}

export function LibraryView({ onOpenResource }: LibraryViewProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  return (
    <div className={styles.layout}>
      {/* Col 1: Folder tree + Tags */}
      <div className={styles.sidebar}>
        <FolderTree
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
        />
        <TagFilter />
      </div>

      {/* Col 2: Resource list */}
      <div className={styles.listPanel}>
        <ResourceList
          folderId={selectedFolderId}
          selectedResourceId={null}
          onSelectResource={onOpenResource}
        />
      </div>

      {/* Col 3: Welcome / placeholder */}
      <div className={styles.main}>
        <div className={styles.mainPlaceholder}>
          双击资料在新标签页中打开阅读
        </div>
      </div>
    </div>
  );
}
