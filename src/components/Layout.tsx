import { useState, useRef, useCallback } from "react";
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
  const [listPanelWidth, setListPanelWidth] = useState(340);
  const dragging = useRef(false);

  const layoutRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(() => {
    dragging.current = true;
    layoutRef.current?.classList.add(styles.resizing);

    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const sidebarWidth = document.querySelector(`.${styles.sidebar}`)?.getBoundingClientRect().width ?? 200;
      const newWidth = e.clientX - sidebarWidth;
      setListPanelWidth(Math.max(200, Math.min(600, newWidth)));
    }

    function onMouseUp() {
      dragging.current = false;
      layoutRef.current?.classList.remove(styles.resizing);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div ref={layoutRef} className={styles.layout}>
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
      <div className={styles.listPanel} style={{ width: listPanelWidth }}>
        <ResourceList
          folderId={selectedFolderId}
          selectedResourceId={selectedResource?.id ?? null}
          onSelect={setSelectedResource}
          onOpen={(resource) => onOpenResource(resource)}
        />
      </div>

      {/* Resize handle */}
      <div className={styles.resizeHandle} onMouseDown={handleMouseDown} />

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
