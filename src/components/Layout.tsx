import { useState, useRef, useCallback, useEffect } from "react";
import { DndContext, DragOverlay, pointerWithin, type DragStartEvent, type DragEndEvent, type DragOverEvent } from "@dnd-kit/core";
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
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [sortBy, _setSortBy] = useState<"created_at" | "captured_at">("created_at");
  const [sortOrder, _setSortOrder] = useState<"asc" | "desc">("desc");
  const [listPanelWidth, setListPanelWidth] = useState(340);
  const dragging = useRef(false);

  const [activeDrag, setActiveDrag] = useState<{ type: "folder" | "resource"; id: string; title: string } | null>(null);
  const [_overDropTarget, setOverDropTarget] = useState<string | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const data = active.data.current as { type: "folder" | "resource"; title: string };
    setActiveDrag({ type: data.type, id: String(active.id), title: data.title });
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    setOverDropTarget(over ? String(over.id) : null);
  }, []);

  const handleDragEnd = useCallback((_event: DragEndEvent) => {
    setActiveDrag(null);
    setOverDropTarget(null);
    // Actual drag end handling will be added in Tasks 8 and 10
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDrag(null);
    setOverDropTarget(null);
  }, []);

  const layoutRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(() => {
    dragging.current = true;
    layoutRef.current?.classList.add(styles.resizing);
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const sidebarWidth = document.querySelector(`.${styles.sidebar}`)?.getBoundingClientRect().width ?? 200;
      const newWidth = e.clientX - sidebarWidth;
      setListPanelWidth(Math.max(200, Math.min(600, newWidth)));
    }

    function onMouseUp() {
      if (!dragging.current) return;
      dragging.current = false;
      layoutRef.current?.classList.remove(styles.resizing);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const handleToggleTag = useCallback((tagId: string) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  }, []);

  return (
    <DndContext
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
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
          <TagFilter selectedTagIds={selectedTagIds} onToggleTag={handleToggleTag} />
        </div>

        {/* Col 2: Resource list */}
        <div className={styles.listPanel} style={{ width: listPanelWidth }}>
          <ResourceList
            folderId={selectedFolderId}
            selectedResourceId={selectedResource?.id ?? null}
            selectedTagIds={selectedTagIds}
            sortBy={sortBy}
            sortOrder={sortOrder}
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
      <DragOverlay>
        {activeDrag && (
          <div className={styles.dragOverlay}>
            {activeDrag.title}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
