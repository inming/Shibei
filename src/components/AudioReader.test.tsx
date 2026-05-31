import { describe, expect, test, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AudioReader } from "./AudioReader";
import type { AudioAnchor, Highlight } from "@/types";

afterEach(cleanup);

function makeAudioHighlight(id: string, start: number): Highlight {
  return {
    id,
    resource_id: "r1",
    text_content: "marker",
    anchor: { type: "audio", start, end: start } as AudioAnchor,
    color: "#FFEB3B",
    created_at: new Date().toISOString(),
  } as Highlight;
}

const baseProps = {
  resourceId: "r1",
  highlights: [],
  activeHighlightId: null,
  onSelection: vi.fn(),
  onClearSelection: vi.fn(),
  onHighlightClick: vi.fn(),
  onHighlightContextMenu: vi.fn(),
  onReady: vi.fn(),
  seekRequest: null,
};

describe("AudioReader", () => {
  test("renders playback controls", () => {
    render(<AudioReader {...baseProps} />);
    // Play / pause toggle button.
    expect(screen.getByRole("button", { name: /▶|play|播放/i })).toBeTruthy();
  });

  test("'mark current position' emits an audio anchor selection", () => {
    const onSelection = vi.fn();
    render(<AudioReader {...baseProps} onSelection={onSelection} />);

    const markBtn = screen.getByTestId("audio-add-marker");
    fireEvent.click(markBtn);

    expect(onSelection).toHaveBeenCalledTimes(1);
    const arg = onSelection.mock.calls[0][0];
    expect(arg.anchor.type).toBe("audio");
    expect(typeof arg.anchor.start).toBe("number");
    expect(arg.anchor.end).toBe(arg.anchor.start);
    expect(typeof arg.text).toBe("string");
  });

  test("clicking a marker requests a seek and reports the highlight click", () => {
    const onHighlightClick = vi.fn();
    // duration must be > 0 for markers to render; stub the media element.
    Object.defineProperty(window.HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get: () => 100,
    });
    const { container } = render(
      <AudioReader
        {...baseProps}
        highlights={[makeAudioHighlight("h1", 50)]}
        onHighlightClick={onHighlightClick}
      />,
    );
    // Fire loadedmetadata so the component records duration = 100.
    const audio = container.querySelector("audio")!;
    fireEvent.loadedMetadata(audio);

    const marker = container.querySelector('[title="marker"]') as HTMLElement;
    expect(marker).toBeTruthy();
    fireEvent.click(marker);
    expect(onHighlightClick).toHaveBeenCalledWith("h1");
  });
});
