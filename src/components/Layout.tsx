import { useState, useRef, useCallback, useEffect } from "react";
import { DndContext, DragOverlay, pointerWithin, PointerSensor, useSensor, useSensors, type DragStartEvent, type DragEndEvent, type DragOverEvent } from "@dnd-kit/core";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import type { Resource } from "@/types";
import * as cmd from "@/lib/commands";
import { FolderTree } from "@/components/Sidebar/FolderTree";
import { TagFilter } from "@/components/Sidebar/TagFilter";
import { ResourceList } from "@/components/Sidebar/ResourceList";
import { PreviewPanel } from "@/components/PreviewPanel";
import { SyncStatus } from "@/components/SyncStatus";
import { SyncSettings } from "@/components/SyncSettings";
import styles from "./Layout.module.css";

interface LibraryViewProps {
  onOpenResource: (resource: Resource, highlightId?: string) => void;
}

export function LibraryView({ onOpenResource }: LibraryViewProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
  const [lastClickedResourceId, setLastClickedResourceId] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"created_at" | "annotated_at">("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [listPanelWidth, setListPanelWidth] = useState(340);
  const [resourceRefreshKey, setResourceRefreshKey] = useState(0);
  const [showSyncSettings, setShowSyncSettings] = useState(false);
  const dragging = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const [activeDrag, setActiveDrag] = useState<{ type: "folder" | "resource"; id: string; title: string } | null>(null);
  const [_overDropTarget, setOverDropTarget] = useState<string | null>(null);
  const folderTreeRefreshRef = useRef<(() => void) | null>(null);

  // Refresh all data when sync completes
  useEffect(() => {
    const unlisten = listen("sync-completed", () => {
      setResourceRefreshKey((k) => k + 1);
      folderTreeRefreshRef.current?.();
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleResourceSelect = useCallback((resource: Resource, resources: Resource[], event: { metaKey: boolean; shiftKey: boolean }) => {
    if (event.metaKey) {
      // Cmd+Click: toggle individual
      setSelectedResourceIds((prev) => {
        const next = new Set(prev);
        if (next.has(resource.id)) {
          next.delete(resource.id);
        } else {
          next.add(resource.id);
        }
        return next;
      });
    } else if (event.shiftKey && lastClickedResourceId) {
      // Shift+Click: range select
      const startIdx = resources.findIndex((r) => r.id === lastClickedResourceId);
      const endIdx = resources.findIndex((r) => r.id === resource.id);
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const rangeIds = resources.slice(lo, hi + 1).map((r) => r.id);
        setSelectedResourceIds(new Set(rangeIds));
      }
    } else {
      // Plain click: single select
      setSelectedResourceIds(new Set([resource.id]));
      setSelectedResource(resource);
    }
    setLastClickedResourceId(resource.id);
  }, [lastClickedResourceId]);

  // When selectedFolderId changes, clear resource selection
  useEffect(() => {
    setSelectedResourceIds(new Set());
    setSelectedResource(null);
  }, [selectedFolderId]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const data = active.data.current as { type: "folder" | "resource"; title: string };
    setActiveDrag({ type: data.type, id: String(active.id), title: data.title });
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    setOverDropTarget(over ? String(over.id) : null);
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDrag(null);
    setOverDropTarget(null);
    if (!over) return;

    const activeData = active.data.current as { type: string; parentId?: string };
    const overData = over.data.current as { type: string; folderId?: string; parentId?: string };

    // Resolve target folder ID: droppable uses "folder-target" with folderId,
    // sortable uses "folder" with the folder id as the over.id itself.
    const resolveTargetFolderId = (): string | null => {
      if (overData.type === "folder-target") return overData.folderId ?? null;
      if (overData.type === "folder") return String(over.id);
      return null;
    };

    // Resource → folder: move resource(s)
    if (activeData.type === "resource") {
      const targetFolderId = resolveTargetFolderId();
      if (!targetFolderId) return;
      try {
        const idsToMove = selectedResourceIds.has(String(active.id))
          ? Array.from(selectedResourceIds)
          : [String(active.id)];
        for (const id of idsToMove) {
          await cmd.moveResource(id, targetFolderId);
        }
        setSelectedResourceIds(new Set());
        setSelectedResource(null);
        setResourceRefreshKey((k) => k + 1);
        folderTreeRefreshRef.current?.();
      } catch (err) {
        console.error("Failed to move resource:", err);
        toast.error("移动资料失败");
      }
      return;
    }

    // Folder → folder: move into target
    if (activeData.type === "folder" && active.id !== over.id) {
      const targetFolderId = resolveTargetFolderId();
      if (!targetFolderId || String(active.id) === targetFolderId) return;
      try {
        await cmd.moveFolder(String(active.id), targetFolderId);
        folderTreeRefreshRef.current?.();
      } catch (err) {
        console.error("Failed to move folder:", err);
        const msg = String(err);
        if (msg.includes("own subtree")) {
          toast.error("不能将文件夹移入自身的子文件夹中");
        } else {
          toast.error("移动文件夹失败");
        }
      }
      return;
    }
  }, [selectedResourceIds]);

  const handleDragCancel = useCallback(() => {
    setActiveDrag(null);
    setOverDropTarget(null);
  }, []);

  const layoutRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(() => {
    dragging.current = true;
    layoutRef.current?.classList.add(styles.resizing);
  }, []);

  // Layout constants — see CLAUDE.md "三栏布局约束"
  const LIST_MIN = 240;
  const PREVIEW_MIN = 280;
  const HANDLE_WIDTH = 4;

  function getSidebarWidth() {
    return document.querySelector(`.${styles.sidebar}`)?.getBoundingClientRect().width ?? 200;
  }

  function clampListWidth(width: number) {
    const maxWidth = window.innerWidth - getSidebarWidth() - HANDLE_WIDTH - PREVIEW_MIN;
    return Math.max(LIST_MIN, Math.min(maxWidth, width));
  }

  // Clamp listPanelWidth when window resizes
  useEffect(() => {
    function onResize() {
      setListPanelWidth((prev) => clampListWidth(prev));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const newWidth = e.clientX - getSidebarWidth();
      setListPanelWidth(clampListWidth(newWidth));
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
      sensors={sensors}
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
            onSelectFolder={setSelectedFolderId}
            onRefreshRef={folderTreeRefreshRef}
          />
          <TagFilter selectedTagIds={selectedTagIds} onToggleTag={handleToggleTag} />
          <SyncStatus onOpenSettings={() => setShowSyncSettings(true)} />
        </div>
        {showSyncSettings && <SyncSettings onClose={() => setShowSyncSettings(false)} />}

        {/* Col 2: Resource list */}
        <div className={styles.listPanel} style={{ width: listPanelWidth }}>
          <ResourceList
            folderId={selectedFolderId}
            selectedResourceIds={selectedResourceIds}
            selectedTagIds={selectedTagIds}
            sortBy={sortBy}
            sortOrder={sortOrder}
            refreshKey={resourceRefreshKey}
            onSelectResource={handleResourceSelect}
            onOpen={(resource) => onOpenResource(resource)}
            onSortByChange={setSortBy}
            onSortOrderChange={setSortOrder}
            onDataChanged={() => { setResourceRefreshKey((k) => k + 1); folderTreeRefreshRef.current?.(); }}
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
              refreshKey={resourceRefreshKey}
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
            {activeDrag.type === "resource" && selectedResourceIds.has(activeDrag.id) && selectedResourceIds.size > 1
              ? `${activeDrag.title} 等 ${selectedResourceIds.size} 项`
              : activeDrag.title}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
