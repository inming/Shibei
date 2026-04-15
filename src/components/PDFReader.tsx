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
import { debugLog } from "@/lib/commands";
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
  onHighlightClick: (id: string) => void;
  onScroll: (info: {
    scrollPercent: number;
    direction: "up" | "down";
  }) => void;
  onReady: () => void;
}

// ── Helpers ──

/**
 * Determine which pages are visible (or within 1 viewport buffer)
 * given the container's scroll position, viewport height,
 * and cumulative page offsets.
 */
function getVisiblePages(
  scrollTop: number,
  viewportHeight: number,
  pageOffsets: number[],
  pageHeights: number[],
  totalPages: number,
): Set<number> {
  const bufferTop = scrollTop - viewportHeight;
  const bufferBottom = scrollTop + viewportHeight * 2;
  const visible = new Set<number>();
  for (let i = 0; i < totalPages; i++) {
    const top = pageOffsets[i];
    const bottom = top + pageHeights[i];
    if (bottom >= bufferTop && top <= bufferBottom) {
      visible.add(i);
    }
  }
  return visible;
}

// ── Component ──

export function PDFReader({
  resourceId,
  highlights,
  activeHighlightId,
  onSelection,
  onHighlightClick,
  onScroll,
  onReady,
}: PDFReaderProps) {
  const { t } = useTranslation("reader");

  // State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [pageInfos, setPageInfos] = useState<PageInfo[]>([]);

  // Refs (mutable state that doesn't trigger renders)
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const renderedPagesRef = useRef(new Set<number>());
  const canvasMapRef = useRef(new Map<number, HTMLCanvasElement>());
  const textLayerMapRef = useRef(new Map<number, HTMLDivElement>());
  const pageContainerMapRef = useRef(new Map<number, HTMLDivElement>());
  const lastScrollTopRef = useRef(0);
  const pdfBytesRef = useRef<Uint8Array | null>(null);
  const scaleRef = useRef(1);

  // Compute cumulative page offsets for virtual scrolling.
  // Each page has 8px gap (except first).
  const pageHeights = useCallback((): number[] => {
    const container = containerRef.current;
    if (!container || pageInfos.length === 0) return [];
    const containerWidth = container.clientWidth;
    return pageInfos.map((info) => {
      const scale = containerWidth / info.width;
      return info.height * scale;
    });
  }, [pageInfos]);

  const pageOffsets = useCallback((): number[] => {
    const heights = pageHeights();
    const offsets: number[] = [];
    let cumulative = 0;
    for (let i = 0; i < heights.length; i++) {
      offsets.push(cumulative);
      cumulative += heights[i] + (i < heights.length - 1 ? 8 : 0);
    }
    return offsets;
  }, [pageHeights]);

  // ── Load PDF ──

  const loadPdf = useCallback(
    async (passwordAttempt?: string) => {
      setLoading(true);
      setError(null);
      setNeedsPassword(false);

      try {
        // Fetch bytes if not cached
        if (!pdfBytesRef.current) {
          const raw = await cmd.readPdfBytes(resourceId);
          pdfBytesRef.current = new Uint8Array(raw);
        }

        const loadingTask = pdfjsLib.getDocument({
          data: pdfBytesRef.current.slice(),
          password: passwordAttempt,
        });

        const doc = await loadingTask.promise;
        pdfDocRef.current = doc;

        // Gather page dimensions
        const infos: PageInfo[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          infos.push({ width: vp.width, height: vp.height });
        }
        setPageInfos(infos);
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
    // Reset state on resource change
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

  // ── Render visible pages ──

  const renderPage = useCallback(
    async (pageIndex: number) => {
      const doc = pdfDocRef.current;
      const container = containerRef.current;
      if (!doc || !container) return;
      if (renderedPagesRef.current.has(pageIndex)) return;

      renderedPagesRef.current.add(pageIndex);

      const page = await doc.getPage(pageIndex + 1);
      const containerWidth = container.clientWidth;
      const info = pageInfos[pageIndex];
      if (!info) return;

      const scale = containerWidth / info.width;
      scaleRef.current = scale;
      const viewport = page.getViewport({ scale });

      // For HiDPI: render at higher resolution, display at CSS size
      const dpr = window.devicePixelRatio || 1;
      const hiDpiViewport = page.getViewport({ scale: scale * dpr });

      const pageDiv = pageContainerMapRef.current.get(pageIndex);
      if (!pageDiv) return;

      // PDF.js v5 CSS variables for text layer sizing:
      // - --scale-factor: viewport scale (set by PDFPageView in official viewer)
      // - --total-scale-factor: used in width/height calc and font-size calc
      //   (set by PDFPageView, NOT by TextLayer — we must set it ourselves)
      // Without --total-scale-factor, all calc() expressions are invalid and
      // fonts fall back to browser default (14px), making all spans misaligned.
      pageDiv.style.setProperty("--scale-factor", String(scale));
      pageDiv.style.setProperty("--total-scale-factor", String(scale));

      // Canvas — pointer-events: none, low z-index so text layer receives mouse events
      let canvas = canvasMapRef.current.get(pageIndex);
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.style.pointerEvents = "none";
        canvas.style.position = "relative";
        canvas.style.zIndex = "0";
        canvas.style.display = "block";
        canvasMapRef.current.set(pageIndex, canvas);
      }
      canvas.width = hiDpiViewport.width;
      canvas.height = hiDpiViewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      // Append canvas if not already there
      if (!pageDiv.contains(canvas)) {
        pageDiv.appendChild(canvas);
      }

      await page.render({ canvas, viewport: hiDpiViewport }).promise;

      // Text layer
      let textDiv = textLayerMapRef.current.get(pageIndex);
      if (!textDiv) {
        textDiv = document.createElement("div");
        // "textLayer" class is required by pdfjs-dist/web/pdf_viewer.css
        // styles.textLayer adds our own overrides (z-index, opacity, etc.)
        textDiv.className = `textLayer ${styles.textLayer}`;
        textLayerMapRef.current.set(pageIndex, textDiv);
      }
      // Clear previous text content
      textDiv.innerHTML = "";

      if (!pageDiv.contains(textDiv)) {
        pageDiv.appendChild(textDiv);
      }

      // pdfjs-dist v5 TextLayer expects a ReadableStream, not the resolved object.
      // Use streamTextContent() instead of getTextContent().
      const textContentSource = page.streamTextContent();

      const tl = new TextLayer({
        textContentSource,
        container: textDiv,
        viewport,
      });
      await tl.render();

      // Debug: compare textLayer vs canvas dimensions and span positioning
      const tlRect = textDiv.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const firstSpan = textDiv.querySelector("span") as HTMLElement | null;
      const computedTL = getComputedStyle(textDiv);
      cmd.debugLog("pdf-textlayer-layout", {
        pageIndex,
        scale,
        canvasCSS: { w: Math.round(canvasRect.width), h: Math.round(canvasRect.height) },
        textLayerRect: { w: Math.round(tlRect.width), h: Math.round(tlRect.height) },
        textLayerComputed: {
          width: computedTL.width,
          height: computedTL.height,
          totalScaleFactor: computedTL.getPropertyValue("--total-scale-factor"),
          scaleFactor: computedTL.getPropertyValue("--scale-factor"),
          minFontSize: computedTL.getPropertyValue("--min-font-size"),
        },
        textLayerInlineStyle: textDiv.getAttribute("style"),
        firstSpan: firstSpan ? {
          inlineStyle: firstSpan.getAttribute("style"),
          computedLeft: getComputedStyle(firstSpan).left,
          computedTop: getComputedStyle(firstSpan).top,
          computedFontSize: getComputedStyle(firstSpan).fontSize,
          computedTransform: getComputedStyle(firstSpan).transform,
          computedTransformOrigin: getComputedStyle(firstSpan).transformOrigin,
          rect: (() => { const r = firstSpan.getBoundingClientRect(); return { l: Math.round(r.left - tlRect.left), t: Math.round(r.top - tlRect.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        } : null,
        pageDivScaleFactor: pageDiv.style.getPropertyValue("--scale-factor"),
      });
    },
    [pageInfos],
  );

  const updateVisiblePages = useCallback(() => {
    const container = containerRef.current;
    if (!container || pageInfos.length === 0) return;

    const heights = pageHeights();
    const offsets = pageOffsets();
    const visible = getVisiblePages(
      container.scrollTop,
      container.clientHeight,
      offsets,
      heights,
      pageInfos.length,
    );

    // Render newly visible pages
    for (const idx of visible) {
      if (!renderedPagesRef.current.has(idx)) {
        renderPage(idx);
      }
    }
  }, [pageInfos, pageHeights, pageOffsets, renderPage]);

  // Initial render + scroll listener
  useEffect(() => {
    if (pageInfos.length === 0) return;

    // Render initial visible pages
    updateVisiblePages();

    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const scrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight - container.clientHeight;
      const scrollPercent = scrollHeight > 0 ? scrollTop / scrollHeight : 0;
      const direction: "up" | "down" =
        scrollTop >= lastScrollTopRef.current ? "down" : "up";
      lastScrollTopRef.current = scrollTop;

      onScroll({ scrollPercent, direction });
      updateVisiblePages();
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [pageInfos, onScroll, updateVisiblePages]);

  // ── Text selection ──

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    const range = sel.getRangeAt(0);
    const selText = sel.toString().trim();
    if (!selText) return;

    // Find which page's text layer contains the selection start
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

    // Compute both start and end charIndex from the DOM tree walk.
    // We build fullText from the same tree walk to ensure consistency —
    // textDiv.textContent includes \n from <br> elements that the tree
    // walker (SHOW_TEXT) doesn't visit, causing index drift.
    const startCharIndex = computeCharIndex(textDiv, range.startContainer, range.startOffset);
    const endCharIndex = computeCharIndex(textDiv, range.endContainer, range.endOffset);
    if (startCharIndex < 0 || endCharIndex < 0 || endCharIndex <= startCharIndex) return;

    const length = endCharIndex - startCharIndex;

    // Build fullText from tree-walked text nodes (same source as charIndex)
    const fullText = collectTextContent(textDiv);
    const exact = fullText.slice(startCharIndex, startCharIndex + length);
    const prefix = fullText.slice(Math.max(0, startCharIndex - 32), startCharIndex);
    const suffix = fullText.slice(startCharIndex + length, startCharIndex + length + 32);

    const anchor: PdfAnchor = {
      type: "pdf",
      page: pageIndex,
      charIndex: startCharIndex,
      length,
      textQuote: {
        exact,
        prefix,
        suffix,
      },
    };

    const rect = range.getBoundingClientRect();
    onSelection({ text: selText, anchor, rect });
  }, [onSelection]);

  // ── Highlight rendering ──

  const renderHighlights = useCallback(
    (pageIndex: number, pageDiv: HTMLDivElement) => {
      // Remove existing highlights on this page
      const existing = pageDiv.querySelectorAll(`.${styles.highlight}`);
      existing.forEach((el) => el.remove());

      const textDiv = textLayerMapRef.current.get(pageIndex);
      if (!textDiv) return;

      const pageHighlights = highlights.filter((h) => {
        const a = h.anchor as PdfAnchor;
        return a.type === "pdf" && a.page === pageIndex;
      });

      for (const hl of pageHighlights) {
        const anchor = hl.anchor as PdfAnchor;
        const rects = getHighlightRects(textDiv, anchor.charIndex, anchor.length);

        for (const rect of rects) {
          const div = document.createElement("div");
          div.className = styles.highlight;
          div.style.left = `${rect.left}px`;
          div.style.top = `${rect.top}px`;
          div.style.width = `${rect.width}px`;
          div.style.height = `${rect.height}px`;
          div.style.backgroundColor = hl.color || "rgba(255, 212, 0, 0.4)";
          if (hl.id === activeHighlightId) {
            div.style.outline = "2px solid var(--accent-color)";
          }
          div.addEventListener("click", () => onHighlightClick(hl.id));
          pageDiv.appendChild(div);
        }
      }
    },
    [highlights, activeHighlightId, onHighlightClick],
  );

  // Re-render highlights when they change
  useEffect(() => {
    for (const [idx, pageDiv] of pageContainerMapRef.current.entries()) {
      if (renderedPagesRef.current.has(idx)) {
        renderHighlights(idx, pageDiv);
      }
    }
  }, [highlights, activeHighlightId, renderHighlights]);

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

  const heights = pageHeights();

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onMouseUp={handleMouseUp}
    >
      {pageInfos.map((info, idx) => {
        const container = containerRef.current;
        const containerWidth = container?.clientWidth ?? 0;
        const scale = containerWidth > 0 ? containerWidth / info.width : 1;
        const w = info.width * scale;
        const h = heights[idx] ?? info.height * scale;

        return (
          <div
            key={idx}
            ref={(el) => {
              if (el) {
                pageContainerMapRef.current.set(idx, el);
              }
            }}
            className={
              renderedPagesRef.current.has(idx)
                ? styles.pageContainer
                : `${styles.pageContainer} ${styles.placeholder}`
            }
            style={{ width: w, height: h }}
          />
        );
      })}
    </div>
  );
}

// ── Utility functions ──

/**
 * Collect text content by walking only text nodes (SHOW_TEXT).
 * This is consistent with computeCharIndex — unlike textContent which
 * includes \n from <br> elements that the tree walker skips.
 */
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

/**
 * Walk text nodes in a container to compute the character offset
 * of a given node + offset within the container's full text.
 */
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

/**
 * Given a text layer container, a charIndex, and a length,
 * find the corresponding DOM Range rects relative to the page container.
 */
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
  const result: Array<{
    left: number;
    top: number;
    width: number;
    height: number;
  }> = [];

  for (let i = 0; i < clientRects.length; i++) {
    const r = clientRects[i];
    // Filter out phantom zero-width rects that getClientRects() produces
    // at element boundaries when a Range spans multiple spans.
    if (r.width < 1 || r.height < 1) continue;
    result.push({
      left: r.left - containerRect.left,
      top: r.top - containerRect.top,
      width: r.width,
      height: r.height,
    });
  }
  return result;
}
