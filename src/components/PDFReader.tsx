import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Highlight, PdfAnchor } from "@/types";
import * as cmd from "@/lib/commands";
import styles from "./PDFReader.module.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// ── Types ──

interface PageInfo {
  width: number;
  height: number;
}

interface PDFReaderProps {
  resourceId: string;
  highlights: Highlight[];
  activeHighlightId: string | null;
  onSelection: (info: {
    text: string;
    anchor: PdfAnchor;
    rect: DOMRect;
  }) => void;
  onClearSelection: () => void;
  onHighlightClick: (id: string) => void;
  onHighlightContextMenu: (id: string, position: { top: number; left: number }) => void;
  onScroll: (info: {
    scrollPercent: number;
    direction: "up" | "down";
  }) => void;
  onReady: () => void;
  /** Set to { id, ts } to scroll to a highlight. ts forces re-trigger for same id. */
  scrollToHighlightRequest: { id: string; ts: number } | null;
}

// ── Component ──

export function PDFReader({
  resourceId,
  highlights,
  activeHighlightId,
  onSelection,
  onClearSelection,
  onHighlightClick,
  onHighlightContextMenu,
  onScroll,
  onReady,
  scrollToHighlightRequest,
}: PDFReaderProps) {
  const { t } = useTranslation("reader");

  // State (only for things that need React re-render)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [pageInfos, setPageInfos] = useState<PageInfo[]>([]);

  // Refs
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const activeHlIdRef = useRef(activeHighlightId);
  activeHlIdRef.current = activeHighlightId;
  const pendingHlRef = useRef<{ id: string; top: number; left: number } | null>(null);
  const lastWidthRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const renderedPagesRef = useRef(new Set<number>());
  const renderGenRef = useRef(0);
  const canvasMapRef = useRef(new Map<number, HTMLCanvasElement>());
  const textLayerMapRef = useRef(new Map<number, HTMLDivElement>());
  const pageContainerMapRef = useRef(new Map<number, HTMLDivElement>());
  const lastScrollTopRef = useRef(0);
  const pdfBytesRef = useRef<Uint8Array | null>(null);

  // ── Height / offset helpers ──
  // Always computed from current container.clientWidth — no caching, no state.

  const getPageHeights = useCallback((): number[] => {
    const w = containerRef.current?.clientWidth ?? 0;
    if (!w || pageInfos.length === 0) return [];
    return pageInfos.map((info) => info.height * (w / info.width));
  }, [pageInfos]);

  const getPageOffsets = useCallback((): number[] => {
    const heights = getPageHeights();
    const offsets: number[] = [];
    let cum = 0;
    for (let i = 0; i < heights.length; i++) {
      offsets.push(cum);
      cum += heights[i] + (i < heights.length - 1 ? 8 : 0);
    }
    return offsets;
  }, [getPageHeights]);

  const getVisiblePageIndices = useCallback((): Set<number> => {
    const container = containerRef.current;
    if (!container || pageInfos.length === 0) return new Set();
    const heights = getPageHeights();
    const offsets = getPageOffsets();
    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight;
    const bufferTop = scrollTop - viewH;
    const bufferBottom = scrollTop + viewH * 2;
    const visible = new Set<number>();
    for (let i = 0; i < pageInfos.length; i++) {
      const top = offsets[i];
      const bottom = top + heights[i];
      if (bottom >= bufferTop && top <= bufferBottom) {
        visible.add(i);
      }
    }
    return visible;
  }, [pageInfos, getPageHeights, getPageOffsets]);

  // ── Load PDF ──

  const loadPdf = useCallback(
    async (passwordAttempt?: string) => {
      setLoading(true);
      setError(null);
      setNeedsPassword(false);

      try {
        if (!pdfBytesRef.current) {
          const raw = await cmd.readPdfBytes(resourceId);
          pdfBytesRef.current = new Uint8Array(raw);
        }

        const doc = await (pdfjsLib.getDocument({
          data: pdfBytesRef.current.slice(),
          password: passwordAttempt,
        })).promise;
        pdfDocRef.current = doc;

        const infos: PageInfo[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          infos.push({ width: vp.width, height: vp.height });
        }
        setPageInfos(infos);
        lastWidthRef.current = containerRef.current?.clientWidth ?? 0;
        setLoading(false);
        onReady();
      } catch (err: unknown) {
        const pdfErr = err as { name?: string };
        if (pdfErr.name === "PasswordException") {
          setNeedsPassword(true);
          setLoading(false);
        } else {
          setError(t("pdfLoadError"));
          setLoading(false);
        }
      }
    },
    [resourceId, onReady, t],
  );

  useEffect(() => {
    renderedPagesRef.current.clear();
    canvasMapRef.current.clear();
    textLayerMapRef.current.clear();
    pageContainerMapRef.current.clear();
    pdfBytesRef.current = null;
    pdfDocRef.current = null;
    lastScrollTopRef.current = 0;

    loadPdf();

    return () => {
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId]);

  // ── Render highlights for one page (reads from refs, always current) ──

  const renderHighlightsForPage = useCallback(
    (pageIndex: number, pageDiv: HTMLDivElement) => {
      const existing = pageDiv.querySelectorAll(`.${styles.highlight}`);
      existing.forEach((el) => el.remove());

      const textDiv = textLayerMapRef.current.get(pageIndex);
      if (!textDiv) return;

      const curHighlights = highlightsRef.current;
      const curActiveId = activeHlIdRef.current;

      const pageHighlights = curHighlights.filter((h) => {
        const a = h.anchor as PdfAnchor;
        return a.type === "pdf" && a.page === pageIndex;
      });

      for (const hl of pageHighlights) {
        const anchor = hl.anchor as PdfAnchor;
        const rects = getHighlightRects(textDiv, anchor.charIndex, anchor.length);

        for (const rect of rects) {
          const div = document.createElement("div");
          div.className = styles.highlight;
          div.dataset.highlightId = hl.id;
          div.style.left = `${rect.left}px`;
          div.style.top = `${rect.top}px`;
          div.style.width = `${rect.width}px`;
          div.style.height = `${rect.height}px`;
          div.style.backgroundColor = hl.color || "rgba(255, 212, 0, 0.4)";
          if (hl.id === curActiveId) {
            div.style.outline = "2px solid var(--accent-color)";
          }
          div.addEventListener("click", () => onHighlightClick(hl.id));
          pageDiv.appendChild(div);
        }
      }
    },
    [onHighlightClick],
  );

  // ── Render a single page ──

  const renderPage = useCallback(
    async (pageIndex: number) => {
      const doc = pdfDocRef.current;
      const container = containerRef.current;
      if (!doc || !container) return;
      if (renderedPagesRef.current.has(pageIndex)) return;

      const containerWidth = container.clientWidth;
      if (!containerWidth) return;

      const gen = renderGenRef.current;
      renderedPagesRef.current.add(pageIndex);

      const page = await doc.getPage(pageIndex + 1);
      if (renderGenRef.current !== gen) return;

      const info = pageInfos[pageIndex];
      if (!info) return;

      const scale = containerWidth / info.width;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const hiDpiViewport = page.getViewport({ scale: scale * dpr });

      const pageDiv = pageContainerMapRef.current.get(pageIndex);
      if (!pageDiv) return;

      // CSS variables for PDF.js text layer sizing
      pageDiv.style.setProperty("--scale-factor", String(scale));
      pageDiv.style.setProperty("--total-scale-factor", String(scale));

      // Always create a NEW canvas to avoid "Cannot use the same canvas
      // during multiple render() operations" when resize triggers re-render
      // while old renders are still in progress.
      const canvas = document.createElement("canvas");
      canvas.style.pointerEvents = "none";
      canvas.width = hiDpiViewport.width;
      canvas.height = hiDpiViewport.height;

      try {
        await page.render({ canvas, viewport: hiDpiViewport }).promise;
      } catch {
        return;
      }

      if (renderGenRef.current !== gen) return;

      // Replace old canvas in DOM
      const oldCanvas = canvasMapRef.current.get(pageIndex);
      if (oldCanvas && pageDiv.contains(oldCanvas)) {
        pageDiv.replaceChild(canvas, oldCanvas);
      } else {
        pageDiv.appendChild(canvas);
      }
      canvasMapRef.current.set(pageIndex, canvas);

      // Text layer
      let textDiv = textLayerMapRef.current.get(pageIndex);
      if (!textDiv) {
        textDiv = document.createElement("div");
        textDiv.className = `textLayer ${styles.textLayer}`;
        textLayerMapRef.current.set(pageIndex, textDiv);
      }
      textDiv.innerHTML = "";

      if (!pageDiv.contains(textDiv)) {
        pageDiv.appendChild(textDiv);
      }

      const textContentSource = page.streamTextContent();
      const tl = new TextLayer({
        textContentSource,
        container: textDiv,
        viewport,
      });
      await tl.render();

      // Re-render highlights now that text layer is ready
      renderHighlightsForPage(pageIndex, pageDiv);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageInfos],
  );

  // ── Render visible pages ──

  const renderVisiblePages = useCallback(() => {
    const visible = getVisiblePageIndices();
    for (const idx of visible) {
      if (!renderedPagesRef.current.has(idx)) {
        renderPage(idx);
      }
    }
  }, [getVisiblePageIndices, renderPage]);

  // ── Scroll handler ──

  useEffect(() => {
    if (pageInfos.length === 0) return;

    renderVisiblePages();

    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const scrollTop = container.scrollTop;
      const maxScroll = container.scrollHeight - container.clientHeight;
      const scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;
      const direction: "up" | "down" =
        scrollTop >= lastScrollTopRef.current ? "down" : "up";
      lastScrollTopRef.current = scrollTop;

      onScroll({ scrollPercent, direction });
      renderVisiblePages();
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [pageInfos, onScroll, renderVisiblePages]);

  // ── ResizeObserver: CSS handles layout, we just re-render for quality ──

  useEffect(() => {
    const container = containerRef.current;
    if (!container || pageInfos.length === 0) return;

    let debounceTimer: ReturnType<typeof setTimeout>;

    const observer = new ResizeObserver((entries) => {
      const newWidth = entries[0].contentRect.width;
      if (!lastWidthRef.current || Math.abs(newWidth - lastWidthRef.current) < 1) return;
      lastWidthRef.current = newWidth;

      // Don't adjust scrollTop — CSS aspect-ratio changes page heights
      // and the browser preserves scroll position naturally.
      // Just debounce re-render for quality.
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        renderGenRef.current += 1;
        renderedPagesRef.current.clear();
        renderVisiblePages();
      }, 200);
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
      clearTimeout(debounceTimer);
    };
  }, [pageInfos, renderVisiblePages]);

  // ── Text selection (right-click) ──

  const findHighlightAtPoint = useCallback((x: number, y: number): string | null => {
    for (const pageDiv of pageContainerMapRef.current.values()) {
      const hlDivs = pageDiv.querySelectorAll<HTMLElement>(`[data-highlight-id]`);
      for (const div of hlDivs) {
        const r = div.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return div.dataset.highlightId || null;
        }
      }
    }
    return null;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return;

    const hlId = findHighlightAtPoint(e.clientX, e.clientY);
    if (hlId) {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      pendingHlRef.current = { id: hlId, top: e.clientY, left: e.clientX };
      return;
    }
    pendingHlRef.current = null;

    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      e.preventDefault();
    }
  }, [findHighlightAtPoint]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    if (pendingHlRef.current) {
      const { id, top, left } = pendingHlRef.current;
      pendingHlRef.current = null;
      onHighlightContextMenu(id, { top, left });
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    const selText = sel.toString().trim();
    if (!selText) return;

    const range = sel.getRangeAt(0);

    let pageIndex = -1;
    for (const [idx, textDiv] of textLayerMapRef.current.entries()) {
      if (textDiv.contains(range.startContainer)) {
        pageIndex = idx;
        break;
      }
    }
    if (pageIndex < 0) return;

    const textDiv = textLayerMapRef.current.get(pageIndex);
    if (!textDiv) return;

    const startCharIndex = computeCharIndex(textDiv, range.startContainer, range.startOffset);
    const endCharIndex = computeCharIndex(textDiv, range.endContainer, range.endOffset);
    if (startCharIndex < 0 || endCharIndex < 0 || endCharIndex <= startCharIndex) return;

    const length = endCharIndex - startCharIndex;
    const fullText = collectTextContent(textDiv);
    const exact = fullText.slice(startCharIndex, startCharIndex + length);
    const prefix = fullText.slice(Math.max(0, startCharIndex - 32), startCharIndex);
    const suffix = fullText.slice(startCharIndex + length, startCharIndex + length + 32);

    const anchor: PdfAnchor = {
      type: "pdf",
      page: pageIndex,
      charIndex: startCharIndex,
      length,
      textQuote: { exact, prefix, suffix },
    };

    const rect = range.getBoundingClientRect();
    onSelection({ text: selText, anchor, rect });
  }, [onSelection, onHighlightContextMenu]);

  // ── Highlight rendering (when highlights/activeId change from React) ──

  useEffect(() => {
    for (const [idx, pageDiv] of pageContainerMapRef.current.entries()) {
      if (renderedPagesRef.current.has(idx)) {
        renderHighlightsForPage(idx, pageDiv);
      }
    }
  }, [highlights, activeHighlightId, renderHighlightsForPage]);

  // ── Scroll to highlight on request ──

  useEffect(() => {
    if (!scrollToHighlightRequest) return;

    const hl = highlights.find((h) => h.id === scrollToHighlightRequest.id);
    if (!hl) return;
    const anchor = hl.anchor as PdfAnchor;
    if (anchor.type !== "pdf") return;

    const pageDiv = pageContainerMapRef.current.get(anchor.page);
    if (!pageDiv) return;

    const hlDiv = pageDiv.querySelector(
      `[data-highlight-id="${scrollToHighlightRequest.id}"]`
    ) as HTMLElement | null;
    if (hlDiv) {
      hlDiv.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      pageDiv.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [scrollToHighlightRequest, highlights]);

  // ── Password form ──

  const handlePasswordSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      loadPdf(password);
    },
    [loadPdf, password],
  );

  // ── Render ──

  if (loading) {
    return (
      <div className={styles.loading}>
        <span>{t("loadingPdf")}</span>
      </div>
    );
  }

  if (needsPassword) {
    return (
      <div className={styles.passwordDialog}>
        <span>{t("pdfPasswordRequired")}</span>
        <form onSubmit={handlePasswordSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("pdfPasswordPlaceholder")}
            autoFocus
          />
          <button type="submit">{t("pdfUnlock")}</button>
        </form>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.error}>
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onClick={onClearSelection}
    >
      {pageInfos.map((info, idx) => (
        <div
          key={idx}
          ref={(el) => {
            if (el) pageContainerMapRef.current.set(idx, el);
          }}
          className={`${styles.pageContainer} ${
            renderedPagesRef.current.has(idx) ? "" : styles.placeholder
          }`}
          style={{ aspectRatio: `${info.width} / ${info.height}` }}
        />
      ))}
    </div>
  );
}

// ── Utility functions ──

function collectTextContent(container: HTMLElement): string {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let result = "";
  let node = walker.nextNode();
  while (node) {
    result += node.textContent ?? "";
    node = walker.nextNode();
  }
  return result;
}

function computeCharIndex(
  container: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === targetNode) {
      return charCount + targetOffset;
    }
    charCount += (node.textContent ?? "").length;
    node = walker.nextNode();
  }
  return -1;
}

function getHighlightRects(
  textDiv: HTMLDivElement,
  charIndex: number,
  length: number,
): Array<{ left: number; top: number; width: number; height: number }> {
  const walker = document.createTreeWalker(textDiv, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let node = walker.nextNode() as Text | null;
  while (node) {
    const nodeLen = (node.textContent ?? "").length;
    if (!startNode && charCount + nodeLen > charIndex) {
      startNode = node;
      startOffset = charIndex - charCount;
    }
    if (charCount + nodeLen >= charIndex + length) {
      endNode = node;
      endOffset = charIndex + length - charCount;
      break;
    }
    charCount += nodeLen;
    node = walker.nextNode() as Text | null;
  }

  if (!startNode || !endNode) return [];

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);

  const containerRect = textDiv.getBoundingClientRect();
  const clientRects = range.getClientRects();
  const result: Array<{ left: number; top: number; width: number; height: number }> = [];

  const INSET = 1;
  for (let i = 0; i < clientRects.length; i++) {
    const r = clientRects[i];
    if (r.width < 1 || r.height < 1) continue;
    const h = r.height - INSET * 2;
    if (h < 1) continue;
    result.push({
      left: r.left - containerRect.left,
      top: r.top - containerRect.top + INSET,
      width: r.width,
      height: h,
    });
  }

  if (result.length > 1) {
    for (let i = 0; i < result.length - 1; i++) {
      const gap = result[i + 1].top - result[i].top;
      if (gap > 0 && result[i].height > gap) {
        result[i].height = gap;
      }
    }
  }

  return result;
}
