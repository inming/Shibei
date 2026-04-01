import { useRef, useState, useEffect, useCallback } from "react";
import type { Resource, Anchor } from "@/types";
import { useAnnotations } from "@/hooks/useAnnotations";
import { SelectionToolbar } from "@/components/SelectionToolbar";
import { AnnotationPanel } from "@/components/AnnotationPanel";
import * as cmd from "@/lib/commands";
import styles from "./ReaderView.module.css";

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
  const didScrollToInitial = useRef(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);

  // Reset scroll guard when initialHighlightId changes
  useEffect(() => {
    didScrollToInitial.current = false;
  }, [initialHighlightId]);

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
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case "shibei:annotator-ready":
          setIframeReady(true);
          break;

        case "shibei:selection":
          if (iframeRef.current) {
            const iframeRect = iframeRef.current.getBoundingClientRect();
            setSelection({
              text: msg.text,
              anchor: msg.anchor,
              rect: {
                top: iframeRect.top + msg.rect.top - 40,
                left: iframeRect.left + msg.rect.left + msg.rect.width / 2 - 70,
                width: msg.rect.width,
                height: msg.rect.height,
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
          // Open external links in default browser
          if (msg.url) {
            window.open(msg.url, "_blank");
          }
          break;
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Send highlights to iframe when ready
  useEffect(() => {
    if (iframeReady && highlights.length > 0 && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: "shibei:render-highlights", highlights },
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
        { type: "shibei:scroll-to-highlight", id: initialHighlightId },
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
          { type: "shibei:add-highlight", highlight: hl },
          "*",
        );

        setSelection(null);
      } catch (err) {
        console.error("Failed to create highlight:", err);
      }
    },
    [selection, resource.id, addHighlight],
  );

  // Handle delete highlight
  const handleDeleteHighlight = useCallback(
    async (id: string) => {
      await removeHighlight(id);
      iframeRef.current?.contentWindow?.postMessage(
        { type: "shibei:remove-highlight", id },
        "*",
      );
      if (activeHighlightId === id) setActiveHighlightId(null);
    },
    [removeHighlight, activeHighlightId],
  );

  // Handle click on annotation panel → scroll iframe to highlight
  const handlePanelClickHighlight = useCallback((id: string) => {
    setActiveHighlightId(id);
    iframeRef.current?.contentWindow?.postMessage(
      { type: "shibei:scroll-to-highlight", id },
      "*",
    );
  }, []);

  return (
    <div className={styles.container}>
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
          src={`shibei://localhost/resource/${resource.id}`}
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

      {/* Annotation panel */}
      <AnnotationPanel
        highlights={highlights}
        getCommentsForHighlight={getCommentsForHighlight}
        resourceNotes={resourceNotes}
        activeHighlightId={activeHighlightId}
        onClickHighlight={handlePanelClickHighlight}
        onDeleteHighlight={handleDeleteHighlight}
        onAddComment={(hlId, content) => addComment(hlId, content)}
        onDeleteComment={removeComment}
        onEditComment={editComment}
      />
    </div>
  );
}
