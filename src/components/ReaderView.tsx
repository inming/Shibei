import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import type { Resource, Anchor } from "@/types";
import { useAnnotations } from "@/hooks/useAnnotations";
import { SelectionToolbar } from "@/components/SelectionToolbar";
import { AnnotationPanel } from "@/components/AnnotationPanel";
import { HighlightContextMenu } from "@/components/HighlightContextMenu";
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
  const { t } = useTranslation('reader');
  const { t: tAnnotation } = useTranslation('annotation');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const didScrollToInitial = useRef(false);
  const draggingRef = useRef(false);
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem("shibei-annotation-width");
    return saved ? Math.max(220, parseInt(saved, 10)) : 280;
  });
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [highlightMenu, setHighlightMenu] = useState<{ id: string; top: number; left: number } | null>(null);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [failedHighlightIds, setFailedHighlightIds] = useState<Set<string>>(new Set());
  const [snapshotStatus, setSnapshotStatus] = useState<string>("synced");
  const [downloading, setDownloading] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [inverted, setInverted] = useState(false);
  const [metaHidden, setMetaHidden] = useState(false);
  const [scrollPercent, setScrollPercent] = useState(0);

  // Reset scroll guard when initialHighlightId changes
  useEffect(() => {
    didScrollToInitial.current = false;
  }, [initialHighlightId]);

  // Clear selection toolbar when resource changes (e.g. switching tabs)
  useEffect(() => {
    setSelection(null);
    setIframeLoading(true);
  }, [resource.id]);

  // Reset loading when iframe key changes (e.g. after download)
  useEffect(() => {
    setIframeLoading(true);
  }, [iframeKey]);

  // Check snapshot status and auto-download if pending
  useEffect(() => {
    let cancelled = false;
    cmd.getSnapshotStatus(resource.id).then(async (status) => {
      if (cancelled) return;
      setSnapshotStatus(status);
      if (status === "pending") {
        setDownloading(true);
        try {
          const success = await cmd.downloadSnapshot(resource.id);
          if (cancelled) return;
          if (success) {
            setSnapshotStatus("synced");
            setIframeKey((k) => k + 1);
          } else {
            toast.error(t('snapshotNotFound'));
          }
        } catch (err: unknown) {
          if (!cancelled) {
            const msg = err && typeof err === "object" && "message" in err
              ? String((err as { message: string }).message)
              : String(err);
            toast.error(t('snapshotDownloadFailed', { message: msg }));
          }
        } finally {
          if (!cancelled) setDownloading(false);
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [resource.id]);

  const {
    highlights,
    getCommentsForHighlight,
    resourceNotes,
    addHighlight,
    updateHighlightColor,
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

        // shibei:selection removed — toolbar is only shown via right-click

        case "shibei:selection-cleared":
          setSelection(null);
          setHighlightMenu(null);
          break;

        case "shibei:scroll": {
          // Hide menus on scroll
          setSelection(null);
          setHighlightMenu(null);
          // Auto-hide meta bar based on scroll direction
          const { scrollY, direction, scrollPercent: pct } = msg as {
            scrollY?: number;
            direction?: string;
            scrollPercent?: number;
          };
          if (typeof scrollY === "number") {
            if (scrollY <= 10) {
              setMetaHidden(false);
            } else if (direction === "down") {
              setMetaHidden(true);
            } else if (direction === "up") {
              setMetaHidden(false);
            }
          }
          if (typeof pct === "number") {
            setScrollPercent(pct);
          }
          break;
        }

        case "shibei:context-menu":
          // Right-click with active selection → show toolbar near mouse position
          if (iframeRef.current) {
            const iframeRect = iframeRef.current.getBoundingClientRect();
            const TOOLBAR_WIDTH = 180;
            const MARGIN = 8;

            // Position at mouse cursor (offset slightly so toolbar doesn't cover click point)
            let top = iframeRect.top + (msg.mouseY as number) + MARGIN;
            let left = iframeRect.left + (msg.mouseX as number) - TOOLBAR_WIDTH / 2;

            // Clamp to viewport
            if (top + 36 > window.innerHeight - MARGIN) {
              top = iframeRect.top + (msg.mouseY as number) - 36 - MARGIN;
            }
            if (left < MARGIN) left = MARGIN;
            else if (left + TOOLBAR_WIDTH > window.innerWidth - MARGIN) {
              left = window.innerWidth - MARGIN - TOOLBAR_WIDTH;
            }

            setSelection({
              text: msg.text,
              anchor: msg.anchor,
              rect: { top, left, width: 0, height: 0 },
            });
          }
          break;

        case "shibei:highlight-clicked":
          setActiveHighlightId(msg.id);
          break;

        case "shibei:highlight-context-menu":
          if (iframeRef.current && msg.id) {
            const iframeRect = iframeRef.current.getBoundingClientRect();
            setHighlightMenu({
              id: msg.id as string,
              top: iframeRect.top + (msg.mouseY as number),
              left: iframeRect.left + (msg.mouseX as number),
            });
            setActiveHighlightId(msg.id as string);
          }
          break;

        case "shibei:link-clicked":
          if (msg.url) {
            import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
              openUrl(msg.url);
            });
            toast(t('openedInBrowser'), { duration: 2000 });
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
        toast.error(tAnnotation('createHighlightFailed'));
      }
    },
    [selection, resource.id, addHighlight],
  );

  // Handle change highlight color
  const handleChangeHighlightColor = useCallback(
    async (id: string, color: string) => {
      const updated = await updateHighlightColor(id, color);
      if (updated) {
        // Tell iframe to update the highlight color
        iframeRef.current?.contentWindow?.postMessage(
          { type: "shibei:update-highlight-color", source: "shibei", id, color },
          "*",
        );
      }
    },
    [updateHighlightColor],
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

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    containerRef.current?.classList.add(styles.resizing);
    // Directly disable iframe pointer events to prevent event capture during drag
    if (iframeRef.current) {
      iframeRef.current.style.pointerEvents = "none";
    }
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = rect.right - e.clientX;
      const maxW = rect.width - READER_MIN - HANDLE_WIDTH;
      const clamped = Math.max(PANEL_MIN, Math.min(maxW, newWidth));
      setPanelWidth(clamped);
      localStorage.setItem("shibei-annotation-width", String(Math.round(clamped)));
    }

    function onMouseUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      containerRef.current?.classList.remove(styles.resizing);
      if (iframeRef.current) {
        iframeRef.current.style.pointerEvents = "";
      }
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
        {/* Progress bar */}
        <div className={styles.progressBar} style={{ width: `${scrollPercent * 100}%` }} />
        {/* Meta bar */}
        <div className={`${styles.metaBar} ${metaHidden ? styles.metaBarHidden : ''}`}>
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
          <button
            className={`${styles.invertBtn} ${inverted ? styles.invertBtnActive : ""}`}
            onClick={() => setInverted((v) => !v)}
            title={inverted ? t('restoreOriginalColors') : t('invertColors')}
          >
            🌓
          </button>
        </div>

        {/* Snapshot content or loading indicator */}
        {snapshotStatus === "pending" || downloading ? (
          <div className={styles.downloadPrompt}>
            <div className={styles.spinner} />
            <p>{t('downloadingSnapshot')}</p>
          </div>
        ) : (
          <>
            {iframeLoading && (
              <div className={styles.loadingOverlay}>
                <div className={styles.spinner} />
                <p>{t('loading')}</p>
              </div>
            )}
            <iframe
              key={iframeKey}
              ref={iframeRef}
              className={`${styles.iframe} ${inverted ? styles.iframeInverted : ""}`}
              style={iframeLoading ? { visibility: "hidden", position: "absolute", inset: 0 } : undefined}
              src={`${PROTOCOL_BASE}/resource/${resource.id}`}
              title={resource.title}
              onLoad={() => setIframeLoading(false)}
            />
          </>
        )}
      </div>

      {/* Selection toolbar (right-click on text selection) */}
      {selection && (
        <SelectionToolbar
          position={{ top: selection.rect.top, left: selection.rect.left }}
          onSelectColor={handleCreateHighlight}
        />
      )}

      {/* Highlight context menu (right-click on existing highlight) */}
      {highlightMenu && (
        <HighlightContextMenu
          position={{ top: highlightMenu.top, left: highlightMenu.left }}
          highlight={highlights.find((h) => h.id === highlightMenu.id) ?? null}
          resourceId={resource.id}
          onChangeColor={(color) => {
            handleChangeHighlightColor(highlightMenu.id, color);
            setHighlightMenu(null);
          }}
          onDelete={() => {
            handleDeleteHighlight(highlightMenu.id);
            setHighlightMenu(null);
          }}
          onClose={() => setHighlightMenu(null)}
        />
      )}

      {/* Resize handle */}
      <div className={styles.resizeHandle} onMouseDown={handleResizeMouseDown} />

      {/* Annotation panel */}
      <AnnotationPanel
        resource={resource}
        style={{ width: panelWidth }}
        highlights={highlights}
        getCommentsForHighlight={getCommentsForHighlight}
        resourceNotes={resourceNotes}
        activeHighlightId={activeHighlightId}
        failedHighlightIds={failedHighlightIds}
        onClickHighlight={handlePanelClickHighlight}
        onDeleteHighlight={handleDeleteHighlight}
        onChangeHighlightColor={handleChangeHighlightColor}
        onAddComment={(hlId, content) => addComment(hlId, content)}
        onDeleteComment={removeComment}
        onEditComment={editComment}
      />
    </div>
  );
}
