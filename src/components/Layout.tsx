import { useState } from "react";
import type { Resource } from "@/types";
import { FolderTree } from "@/components/Sidebar/FolderTree";
import { TagFilter } from "@/components/Sidebar/TagFilter";
import { ResourceList } from "@/components/Sidebar/ResourceList";
import { PreviewPanel } from "@/components/PreviewPanel";
import styles from "./Layout.module.css";

interface LibraryViewProps {
  onOpenResource: (resource: Resource, highlightId?: string) => void;
}

export function LibraryView({ onOpenResource }: LibraryViewProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);

  return (
    <div className={styles.layout}>
      {/* Col 1: Folder tree + Tags */}
      <div className={styles.sidebar}>
        <FolderTree
          selectedFolderId={selectedFolderId}
          onSelectFolder={(id) => {
            setSelectedFolderId(id);
            setSelectedResource(null);
          }}
        />
        <TagFilter />
      </div>

      {/* Col 2: Resource list */}
      <div className={styles.listPanel}>
        <ResourceList
          folderId={selectedFolderId}
          selectedResourceId={selectedResource?.id ?? null}
          onSelect={setSelectedResource}
          onOpen={(resource) => onOpenResource(resource)}
        />
      </div>

      {/* Col 3: Preview or placeholder */}
      <div className={styles.main}>
        {selectedResource ? (
          <PreviewPanel
            key={selectedResource.id}
            resource={selectedResource}
            onOpenInReader={(highlightId) => onOpenResource(selectedResource, highlightId)}
          />
        ) : (
          <div className={styles.mainPlaceholder}>
            双击资料在新标签页中打开阅读
          </div>
        )}
      </div>
    </div>
  );
}
