import { describe, expect, test, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { mockInvoke } from "@/test/tauriMock";
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

  test("renders transcript segments and links highlighted ones", async () => {
    const onHighlightClick = vi.fn();
    mockInvoke((cmd) => {
      if (cmd === "cmd_get_transcript") {
        return {
          version: 1,
          segments: [
            { start: 0, end: 2, text: "alpha" },
            { start: 2, end: 4, text: "beta" },
          ],
        };
      }
      return undefined;
    });
    // Point marker at 2.5s overlaps the second segment [2,4).
    render(
      <AudioReader
        {...baseProps}
        highlights={[makeAudioHighlight("h1", 2.5)]}
        onHighlightClick={onHighlightClick}
      />,
    );

    expect(await screen.findByText(/alpha/)).toBeTruthy();
    const beta = await screen.findByText(/beta/);
    fireEvent.click(beta);
    expect(onHighlightClick).toHaveBeenCalledWith("h1");
  });

  test("range highlight does not bleed into the contiguous neighbor segment", async () => {
    mockInvoke((cmd) => {
      if (cmd === "cmd_get_transcript") {
        return {
          version: 1,
          segments: [
            { start: 0, end: 2, text: "alpha" },
            { start: 2, end: 4, text: "beta" },
          ],
        };
      }
      return undefined;
    });
    // Range highlight covers exactly the second segment [2,4); the first
    // segment [0,2) shares the boundary at t=2 but must NOT be tinted.
    const rangeHl = {
      id: "r1",
      resource_id: "r1",
      text_content: "beta",
      anchor: { type: "audio", start: 2, end: 4 } as AudioAnchor,
      color: "#FFEB3B",
      created_at: new Date().toISOString(),
    } as Highlight;
    render(<AudioReader {...baseProps} highlights={[rangeHl]} />);

    const alpha = (await screen.findByText(/alpha/)) as HTMLElement;
    const beta = (await screen.findByText(/beta/)) as HTMLElement;
    expect(beta.style.backgroundColor).toBeTruthy(); // tinted
    expect(alpha.style.backgroundColor).toBeFalsy(); // not bled into
  });
});
