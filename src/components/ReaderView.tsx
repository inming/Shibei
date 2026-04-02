import { useRef, useState, useEffect, useCallback } from "react";
import toast from "react-hot-toast";
import type { Resource, Anchor } from "@/types";
import { useAnnotations } from "@/hooks/useAnnotations";
import { SelectionToolbar } from "@/components/SelectionToolbar";
import { AnnotationPanel } from "@/components/AnnotationPanel";
import * as cmd from "@/lib/commands";
import styles from "./ReaderView.module.css";

// Tauri 2 uses different protocol URLs per platform:
// macOS/Linux: shibei://localhost/...
// Windows:     http://shibei.localhost/...
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const PROTOCOL_BASE = IS_WINDOWS ? "http://shibei.localhost" : "shibei://localhost";

interface ReaderViewProps {
  resource: Resource;
  initialHighlightId: string | null;
}

interface SelectionInfo {
  text: string;
  anchor: Anchor;
  rect: { top: number; left: number; width: number; height: number };
}

export function ReaderView({ resource, initialHighlightId }: ReaderViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const didScrollToInitial = useRef(false);
  const dragging = useRef(false);
  const [panelWidth, setPanelWidth] = useState(280);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [failedHighlightIds, setFailedHighlightIds] = useState<Set<string>>(new Set());

  // Reset scroll guard when initialHighlightId changes
  useEffect(() => {
    didScrollToInitial.current = false;
  }, [initialHighlightId]);

  // Clear selection toolbar when resource changes (e.g. switching tabs)
  useEffect(() => {
    setSelection(null);
  }, [resource.id]);

  const {
    highlights,
    getCommentsForHighlight,
    resourceNotes,
    addHighlight,
    removeHighlight,
    addComment,
    removeComment,
    editComment,
  } = useAnnotations(resource.id);

  // Listen for messages from iframe
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (!msg || !msg.type || msg.source !== "shibei") return;

      switch (msg.type) {
        case "shibei:annotator-ready":
          setIframeReady(true);
          break;

        case "shibei:selection":
          if (iframeRef.current) {
            const iframeRect = iframeRef.current.getBoundingClientRect();
            const TOOLBAR_HEIGHT = 36;
            const TOOLBAR_WIDTH = 180;
            const MARGIN = 8;
            const selRect = msg.rect;

            let top = iframeRect.top + selRect.top - TOOLBAR_HEIGHT - MARGIN;
            let left =
              iframeRect.left +
              selRect.left +
              selRect.width / 2 -
              TOOLBAR_WIDTH / 2;

            // Edge detection: if toolbar would go above viewport, show below selection
            if (top < MARGIN) {
              top = iframeRect.top + selRect.bottom + MARGIN;
            }

            // Horizontal clamping
            if (left < MARGIN) {
              left = MARGIN;
            } else if (left + TOOLBAR_WIDTH > window.innerWidth - MARGIN) {
              left = window.innerWidth - MARGIN - TOOLBAR_WIDTH;
            }

            setSelection({
              text: msg.text,
              anchor: msg.anchor,
              rect: {
                top,
                left,
                width: selRect.width,
                height: selRect.height,
              },
            });
          }
          break;

        case "shibei:selection-cleared":
          setSelection(null);
          break;

        case "shibei:highlight-clicked":
          setActiveHighlightId(msg.id);
          break;

        case "shibei:link-clicked":
          if (msg.url) {
            import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
              openUrl(msg.url);
            });
            toast("已在浏览器中打开", { duration: 2000 });
          }
          break;

        case "shibei:render-result":
          if (Array.isArray(msg.failedIds)) {
            setFailedHighlightIds(new Set(msg.failedIds as string[]));
          }
          break;
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Send highlights to iframe once when iframe becomes ready.
  // Only fires on initial load — individual adds/removes use their own messages.
  const didSendInitialHighlights = useRef(false);
  useEffect(() => {
    if (iframeReady && highlights.length > 0 && !didSendInitialHighlights.current && iframeRef.current?.contentWindow) {
      didSendInitialHighlights.current = true;
      iframeRef.current.contentWindow.postMessage(
        { type: "shibei:render-highlights", source: "shibei", highlights },
        "*",
      );
    }
  }, [iframeReady, highlights]);

  // Scroll to initial highlight if specified (once only)
  useEffect(() => {
    if (
      initialHighlightId &&
      iframeReady &&
      highlights.length > 0 &&
      !didScrollToInitial.current &&
      iframeRef.current?.contentWindow
    ) {
      didScrollToInitial.current = true;
      setActiveHighlightId(initialHighlightId);
      iframeRef.current.contentWindow.postMessage(
        { type: "shibei:scroll-to-highlight", source: "shibei", id: initialHighlightId },
        "*",
      );
    }
  }, [initialHighlightId, iframeReady, highlights]);

  // Handle color selection → create highlight
  const handleCreateHighlight = useCallback(
    async (color: string) => {
      if (!selection) return;
      try {
        const hl = await cmd.createHighlight(
          resource.id,
          selection.text,
          selection.anchor,
          color,
        );
        addHighlight(hl);

        // Tell iframe to render the new highlight
        iframeRef.current?.contentWindow?.postMessage(
          { type: "shibei:add-highlight", source: "shibei", highlight: hl },
          "*",
        );

        setSelection(null);
      } catch (err) {
        console.error("Failed to create highlight:", err);
        toast.error("创建高亮失败");
      }
    },
    [selection, resource.id, addHighlight],
  );

  // Handle delete highlight
  const handleDeleteHighlight = useCallback(
    async (id: string) => {
      await removeHighlight(id);
      iframeRef.current?.contentWindow?.postMessage(
        { type: "shibei:remove-highlight", source: "shibei", id },
        "*",
      );
      if (activeHighlightId === id) setActiveHighlightId(null);
    },
    [removeHighlight, activeHighlightId],
  );

  // Layout constants — see CLAUDE.md "阅读器双栏布局约束"
  const PANEL_MIN = 220;
  const READER_MIN = 400;
  const HANDLE_WIDTH = 4;

  function clampPanelWidth(width: number) {
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const maxWidth = containerWidth - READER_MIN - HANDLE_WIDTH;
    return Math.max(PANEL_MIN, Math.min(maxWidth, width));
  }

  // Clamp panelWidth when window resizes
  useEffect(() => {
    function onResize() {
      setPanelWidth((prev) => clampPanelWidth(prev));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleResizeMouseDown = useCallback(() => {
    dragging.current = true;
    containerRef.current?.classList.add(styles.resizing);
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current || !containerRef.current) return;
      const containerRight = containerRef.current.getBoundingClientRect().right;
      const newWidth = containerRight - e.clientX;
      setPanelWidth(clampPanelWidth(newWidth));
    }

    function onMouseUp() {
      if (!dragging.current) return;
      dragging.current = false;
      containerRef.current?.classList.remove(styles.resizing);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Handle click on annotation panel → scroll iframe to highlight
  const handlePanelClickHighlight = useCallback((id: string) => {
    setActiveHighlightId(id);
    // Don't scroll to highlight if it failed to anchor in the DOM
    if (!failedHighlightIds.has(id)) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "shibei:scroll-to-highlight", source: "shibei", id },
        "*",
      );
    }
  }, [failedHighlightIds]);

  return (
    <div ref={containerRef} className={styles.container}>
      <div className={styles.reader}>
        {/* Meta bar */}
        <div className={styles.metaBar}>
          <span className={styles.metaTitle}>{resource.title}</span>
          <a
            className={styles.metaUrl}
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {resource.domain ?? new URL(resource.url).hostname}
          </a>
          <span className={styles.metaTime}>
            {new Date(resource.created_at).toLocaleDateString()}
          </span>
        </div>

        {/* MHTML content */}
        <iframe
          ref={iframeRef}
          className={styles.iframe}
          src={`${PROTOCOL_BASE}/resource/${resource.id}`}
          title={resource.title}
        />
      </div>

      {/* Selection toolbar */}
      {selection && (
        <SelectionToolbar
          position={{ top: selection.rect.top, left: selection.rect.left }}
          onSelectColor={handleCreateHighlight}
        />
      )}

      {/* Resize handle */}
      <div className={styles.resizeHandle} onMouseDown={handleResizeMouseDown} />

      {/* Annotation panel */}
      <AnnotationPanel
        style={{ width: panelWidth }}
        highlights={highlights}
        getCommentsForHighlight={getCommentsForHighlight}
        resourceNotes={resourceNotes}
        activeHighlightId={activeHighlightId}
        failedHighlightIds={failedHighlightIds}
        onClickHighlight={handlePanelClickHighlight}
        onDeleteHighlight={handleDeleteHighlight}
        onAddComment={(hlId, content) => addComment(hlId, content)}
        onDeleteComment={removeComment}
        onEditComment={editComment}
      />
    </div>
  );
}
