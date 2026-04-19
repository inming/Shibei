import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import type { Resource, Anchor } from "@/types";
import { useAnnotations } from "@/hooks/useAnnotations";
import { SelectionToolbar } from "@/components/SelectionToolbar";
import { AnnotationPanel } from "@/components/AnnotationPanel";
import { HighlightContextMenu } from "@/components/HighlightContextMenu";
import { PDFReader } from "@/components/PDFReader";
import * as cmd from "@/lib/commands";
import { updateReaderTab } from "@/lib/sessionState";
import { clampZoom, nextZoom, prevZoom, ZOOM_DEFAULT, ZOOM_MIN, ZOOM_MAX } from "@/lib/pdfZoom";
import styles from "./ReaderView.module.css";

// Tauri 2 uses different protocol URLs per platform:
// macOS/Linux: shibei://localhost/...
// Windows:     http://shibei.localhost/...
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const PROTOCOL_BASE = IS_WINDOWS ? "http://shibei.localhost" : "shibei://localhost";

interface ReaderViewProps {
  resource: Resource;
  initialHighlightId: string | null;
  initialScrollY?: number | null;
  initialPdfPage?: number | null;
  initialPdfScrollFraction?: number | null;
  initialPdfZoom?: number | null;
}

interface SelectionInfo {
  text: string;
  anchor: Anchor;
  rect: { top: number; left: number; width: number; height: number };
}

export function ReaderView({
  resource,
  initialHighlightId,
  initialScrollY,
  initialPdfPage,
  initialPdfScrollFraction,
  initialPdfZoom,
}: ReaderViewProps) {
  const { t } = useTranslation('reader');
  const { t: tAnnotation } = useTranslation('annotation');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const didScrollToInitial = useRef(false);
  const didRestoreScroll = useRef(false);
  const scrollPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrollYRef = useRef<number | null>(null);
  const pdfPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPdfPositionRef = useRef<{ page: number; fraction: number } | null>(null);
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
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [metaHidden, setMetaHidden] = useState(false);
  const [scrollPercent, setScrollPercent] = useState(0);
  const [pdfScrollRequest, setPdfScrollRequest] = useState<
    | { kind: "highlight"; id: string; ts: number }
    | { kind: "position"; page: number; fraction: number; ts: number }
    | null
  >(null);
  const [pdfZoom, setPdfZoom] = useState<number>(() =>
    clampZoom(initialPdfZoom ?? ZOOM_DEFAULT)
  );

  // Persist zoom on change (no debounce — changes are user-driven, low frequency)
  useEffect(() => {
    if (resource.resource_type !== "pdf") return;
    updateReaderTab(resource.id, { pdfZoom });
  }, [pdfZoom, resource.id, resource.resource_type]);

  // Reset scroll guard when initialHighlightId changes
  useEffect(() => {
    didScrollToInitial.current = false;
  }, [initialHighlightId]);

  // Reset restore-scroll guard on resource change (defensive)
  useEffect(() => {
    didRestoreScroll.current = false;
  }, [resource.id]);

  // Reset zoom when switching to a different resource
  useEffect(() => {
    setPdfZoom(clampZoom(initialPdfZoom ?? ZOOM_DEFAULT));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id]);

  // Cleanup pending scroll persist timer on unmount
  useEffect(() => () => {
    if (scrollPersistTimer.current) clearTimeout(scrollPersistTimer.current);
    // Flush any unflushed scroll position so users don't lose up to 500ms of
    // scroll when quitting the app.
    if (pendingScrollYRef.current !== null && resource.resource_type !== "pdf") {
      updateReaderTab(resource.id, { scrollY: pendingScrollYRef.current });
      pendingScrollYRef.current = null;
    }
    if (pdfPersistTimer.current) clearTimeout(pdfPersistTimer.current);
    if (pendingPdfPositionRef.current && resource.resource_type === "pdf") {
      const { page, fraction } = pendingPdfPositionRef.current;
      updateReaderTab(resource.id, { pdfPage: page, pdfScrollFraction: fraction });
      pendingPdfPositionRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          if (
            resource.resource_type !== "pdf" &&
            !didRestoreScroll.current &&
            !initialHighlightId &&
            typeof initialScrollY === "number" &&
            initialScrollY > 0 &&
            iframeRef.current?.contentWindow
          ) {
            didRestoreScroll.current = true;
            iframeRef.current.contentWindow.postMessage(
              { type: "shibei:restore-scroll", source: "shibei", scrollY: initialScrollY },
              "*",
            );
          }
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
          if (typeof scrollY === "number" && resource.resource_type !== "pdf") {
            pendingScrollYRef.current = scrollY;
            if (scrollPersistTimer.current) clearTimeout(scrollPersistTimer.current);
            const id = resource.id;
            const y = scrollY;
            scrollPersistTimer.current = setTimeout(() => {
              updateReaderTab(id, { scrollY: y });
              pendingScrollYRef.current = null;
            }, 500);
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
    // Empty deps: initialScrollY / initialHighlightId / resource.resource_type
    // are mount-time-only and never change for a given ReaderView instance
    // (parent keys the wrapping <div> by resource.id, so a different resource
    // causes a full remount rather than reusing this listener).
  }, []);

  // Send highlights to iframe once when iframe becomes ready.
  // Only fires on initial load — individual adds/removes use their own messages.
  const didSendInitialHighlights = useRef(false);
  useEffect(() => {
    if (resource.resource_type === "pdf") return;
    if (iframeReady && highlights.length > 0 && !didSendInitialHighlights.current && iframeRef.current?.contentWindow) {
      didSendInitialHighlights.current = true;
      iframeRef.current.contentWindow.postMessage(
        { type: "shibei:render-highlights", source: "shibei", highlights },
        "*",
      );
    }
  }, [iframeReady, highlights, resource.resource_type]);

  // Scroll to initial highlight if specified (once only)
  useEffect(() => {
    if (resource.resource_type === "pdf") return;
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
  }, [initialHighlightId, iframeReady, highlights, resource.resource_type]);

  // PDF counterpart: auto-scroll after PDFReader reports onReady (drives iframeLoading=false)
  useEffect(() => {
    if (resource.resource_type !== "pdf") return;
    if (
      initialHighlightId &&
      !iframeLoading &&
      highlights.length > 0 &&
      !didScrollToInitial.current
    ) {
      didScrollToInitial.current = true;
      setActiveHighlightId(initialHighlightId);
      setPdfScrollRequest({ kind: "highlight", id: initialHighlightId, ts: Date.now() });
    }
  }, [initialHighlightId, iframeLoading, highlights, resource.resource_type]);

  const didRestorePdfPosition = useRef(false);

  useEffect(() => {
    if (resource.resource_type !== "pdf") return;
    if (didRestorePdfPosition.current) return;
    if (initialHighlightId) return; // highlight wins
    if (iframeLoading) return; // wait for onReady
    if (typeof initialPdfPage !== "number") return;
    didRestorePdfPosition.current = true;
    setPdfScrollRequest({
      kind: "position",
      page: initialPdfPage,
      fraction: typeof initialPdfScrollFraction === "number" ? initialPdfScrollFraction : 0,
      ts: Date.now(),
    });
  }, [resource.resource_type, initialPdfPage, initialPdfScrollFraction, initialHighlightId, iframeLoading]);

  useEffect(() => {
    didRestorePdfPosition.current = false;
  }, [resource.id]);

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

        // Tell iframe to render the new highlight (HTML only, PDF handles its own rendering)
        if (resource.resource_type !== "pdf") {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "shibei:add-highlight", source: "shibei", highlight: hl },
            "*",
          );
        }

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
      if (updated && resource.resource_type !== "pdf") {
        // Tell iframe to update the highlight color
        iframeRef.current?.contentWindow?.postMessage(
          { type: "shibei:update-highlight-color", source: "shibei", id, color },
          "*",
        );
      }
    },
    [updateHighlightColor, resource.resource_type],
  );

  // Handle delete highlight
  const handleDeleteHighlight = useCallback(
    async (id: string) => {
      await removeHighlight(id);
      if (resource.resource_type !== "pdf") {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "shibei:remove-highlight", source: "shibei", id },
          "*",
        );
      }
      if (activeHighlightId === id) setActiveHighlightId(null);
    },
    [removeHighlight, activeHighlightId, resource.resource_type],
  );

  const handlePdfScrollPosition = useCallback(({ page, fraction }: { page: number; fraction: number }) => {
    pendingPdfPositionRef.current = { page, fraction };
    if (pdfPersistTimer.current) clearTimeout(pdfPersistTimer.current);
    const id = resource.id;
    pdfPersistTimer.current = setTimeout(() => {
      updateReaderTab(id, { pdfPage: page, pdfScrollFraction: fraction });
      pendingPdfPositionRef.current = null;
    }, 500);
  }, [resource.id]);

  const handleZoomIn = useCallback(() => setPdfZoom((z) => nextZoom(z)), []);
  const handleZoomOut = useCallback(() => setPdfZoom((z) => prevZoom(z)), []);
  const handleZoomReset = useCallback(() => setPdfZoom(ZOOM_DEFAULT), []);

  // Keyboard shortcuts for PDF zoom (Ctrl/Cmd +/-/0)
  useEffect(() => {
    if (resource.resource_type !== "pdf") return;

    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (isEditableTarget(e.target)) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        handleZoomReset();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [resource.resource_type, handleZoomIn, handleZoomOut, handleZoomReset]);

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
    if (resource.resource_type === "pdf") {
      // Trigger PDFReader scroll — ts forces re-trigger for same id
      setPdfScrollRequest({ kind: "highlight", id, ts: Date.now() });
    } else if (!failedHighlightIds.has(id)) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "shibei:scroll-to-highlight", source: "shibei", id },
        "*",
      );
    }
  }, [failedHighlightIds, resource.resource_type]);

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
            {resource.domain ?? (() => { try { return new URL(resource.url).hostname; } catch { return resource.url; } })()}
          </a>
          <span className={styles.metaTime}>
            {new Date(resource.created_at).toLocaleDateString()}
          </span>
          {resource.resource_type !== "pdf" ? (
            <button
              className={`${styles.invertBtn} ${inverted ? styles.invertBtnActive : ""}`}
              onClick={() => setInverted((v) => !v)}
              title={inverted ? t('restoreOriginalColors') : t('invertColors')}
            >
              🌓
            </button>
          ) : (
            <div className={styles.zoomControls}>
              <button
                className={styles.zoomBtn}
                onClick={handleZoomOut}
                disabled={pdfZoom <= ZOOM_MIN + 0.001}
                title={t("zoomOut")}
              >
                −
              </button>
              <span className={styles.zoomLabel}>
                {t("zoomPercentage", { value: Math.round(pdfZoom * 100) })}
              </span>
              <button
                className={styles.zoomBtn}
                onClick={handleZoomIn}
                disabled={pdfZoom >= ZOOM_MAX - 0.001}
                title={t("zoomIn")}
              >
                +
              </button>
              <button
                className={styles.zoomBtn}
                onClick={handleZoomReset}
                disabled={Math.abs(pdfZoom - ZOOM_DEFAULT) < 0.001}
                title={t("zoomReset")}
              >
                ↺
              </button>
            </div>
          )}
        </div>

        {/* Content area: PDF or HTML iframe */}
        {resource.resource_type === "pdf" ? (
          <PDFReader
            resourceId={resource.id}
            highlights={highlights}
            activeHighlightId={activeHighlightId}
            onSelection={(info) => {
              setSelection({
                text: info.text,
                anchor: info.anchor,
                rect: {
                  top: info.rect.top,
                  left: info.rect.left,
                  width: info.rect.width,
                  height: info.rect.height,
                },
              });
            }}
            onClearSelection={() => {
              setSelection(null);
              setHighlightMenu(null);
            }}
            onHighlightClick={(id) => setActiveHighlightId(id)}
            onHighlightContextMenu={(id, pos) => {
              setHighlightMenu({ id, top: pos.top, left: pos.left });
              setActiveHighlightId(id);
            }}
            onScroll={({ scrollPercent: pct, direction }) => {
              setSelection(null);
              setHighlightMenu(null);
              setScrollPercent(pct);
              if (direction === "down") setMetaHidden(true);
              else setMetaHidden(false);
            }}
            onReady={() => setIframeLoading(false)}
            onScrollPosition={handlePdfScrollPosition}
            scrollRequest={pdfScrollRequest}
            zoomFactor={pdfZoom}
          />
        ) : snapshotStatus === "pending" || downloading ? (
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

      {panelCollapsed ? (
        <div
          className={styles.collapsedPanel}
          onClick={() => setPanelCollapsed(false)}
          title={t('expandPanel')}
        >
          <div className={styles.collapsedHighlights}>
            {highlights.map(h => (
              <div
                key={h.id}
                className={styles.collapsedDot}
                style={{ backgroundColor: h.color }}
              />
            ))}
          </div>
          <span className={styles.collapsedCount}>{highlights.length}</span>
        </div>
      ) : (
        <>
          {/* Resize handle with collapse button */}
          <div className={styles.resizeHandle} onMouseDown={handleResizeMouseDown}>
            <button
              className={styles.collapseBtn}
              onClick={(e) => { e.stopPropagation(); setPanelCollapsed(true); }}
              title={t('collapsePanel')}
            >
              ›
            </button>
          </div>

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
        </>
      )}
    </div>
  );
}
