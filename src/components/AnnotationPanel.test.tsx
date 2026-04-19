import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { AnnotationPanel } from "./AnnotationPanel";
import type { Resource } from "@/types";

// Mock ResourceMeta — it has complex deps (plugin-opener, Tauri events) unrelated to SummarySection
vi.mock("@/components/ResourceMeta", () => ({
  ResourceMeta: () => null,
}));

// Mock Tauri command module — stub getResourceSummary; spread actual module for other exports
vi.mock("@/lib/commands", async (orig) => {
  const actual = await orig<typeof import("@/lib/commands")>();
  return {
    ...actual,
    getResourceSummary: vi.fn(),
  };
});

import * as cmd from "@/lib/commands";

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: "r1",
    title: "Test Resource",
    url: "https://example.com/a",
    domain: "example.com",
    author: null,
    description: null,
    folder_id: "__inbox__",
    resource_type: "html",
    file_path: "/tmp/test",
    created_at: new Date().toISOString(),
    captured_at: new Date().toISOString(),
    selection_meta: null,
    ...overrides,
  };
}

const baseProps = {
  highlights: [],
  failedHighlightIds: new Set<string>(),
  getCommentsForHighlight: () => [],
  activeHighlightId: null,
  onClickHighlight: () => {},
  onDeleteHighlight: () => {},
  onChangeHighlightColor: () => {},
  onAddComment: () => {},
  onDeleteComment: () => {},
  onEditComment: () => {},
  resourceNotes: [],
};

describe("SummarySection via AnnotationPanel", () => {
  beforeEach(() => {
    // Stub IntersectionObserver (not available in jsdom)
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    } as unknown as typeof IntersectionObserver;

    vi.mocked(cmd.getResourceSummary).mockReset();
  });

  test("uses description when present", async () => {
    const resource = makeResource({ description: "Hand-written summary." });
    render(<AnnotationPanel resource={resource} {...baseProps} />);
    expect(await screen.findByText("Hand-written summary.")).toBeTruthy();
    expect(cmd.getResourceSummary).not.toHaveBeenCalled();
  });

  test("falls back to plain_text summary when description empty", async () => {
    vi.mocked(cmd.getResourceSummary).mockResolvedValue("Extracted from body.");
    const resource = makeResource({ description: null });
    render(<AnnotationPanel resource={resource} {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByText("Extracted from body.")).toBeTruthy();
    });
  });

  test("renders nothing when both are empty", async () => {
    vi.mocked(cmd.getResourceSummary).mockResolvedValue("");
    const resource = makeResource({ description: null });
    const { container } = render(<AnnotationPanel resource={resource} {...baseProps} />);
    await waitFor(() => {
      expect(vi.mocked(cmd.getResourceSummary)).toHaveBeenCalled();
    });
    expect(within(container).queryByTestId("summary-section")).toBeNull();
  });
});
