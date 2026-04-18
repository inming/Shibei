import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { useRef, type CSSProperties } from "react";
import { useFlipPosition, useSubmenuPosition } from "@/hooks/useFlipPosition";

// jsdom always returns a zero-DOMRect from getBoundingClientRect(). Patch the
// prototype to read from data-rect-* attributes so tests can declare sizes
// inline on each element.
function installRectStub() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const el = this as HTMLElement;
    const top = parseFloat(el.dataset.rectTop ?? "0");
    const left = parseFloat(el.dataset.rectLeft ?? "0");
    const width = parseFloat(el.dataset.rectWidth ?? "0");
    const height = parseFloat(el.dataset.rectHeight ?? "0");
    return {
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

function stubViewport(width: number, height: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
}

interface Probe {
  left: number;
  top: number;
}

function FlipProbe({
  x,
  y,
  width,
  height,
  onRender,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  onRender: (p: Probe) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFlipPosition(ref, x, y);
  onRender({ left: pos.left, top: pos.top });
  return (
    <div
      ref={ref}
      data-rect-width={String(width)}
      data-rect-height={String(height)}
      data-rect-left={String(pos.left)}
      data-rect-top={String(pos.top)}
    />
  );
}

function SubmenuProbe({
  anchor,
  submenuSize,
  open,
  onRender,
}: {
  anchor: { top: number; left: number; width: number; height: number };
  submenuSize: { width: number; height: number };
  open: boolean;
  onRender: (s: CSSProperties) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const style = useSubmenuPosition(anchorRef, submenuRef, open);
  onRender(style);
  return (
    <div
      ref={anchorRef}
      data-rect-top={String(anchor.top)}
      data-rect-left={String(anchor.left)}
      data-rect-width={String(anchor.width)}
      data-rect-height={String(anchor.height)}
    >
      {open && (
        <div
          ref={submenuRef}
          data-rect-width={String(submenuSize.width)}
          data-rect-height={String(submenuSize.height)}
          style={style}
        />
      )}
    </div>
  );
}

describe("useFlipPosition", () => {
  let restoreRect: (() => void) | undefined;

  beforeEach(() => {
    stubViewport(1000, 800);
    restoreRect = installRectStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreRect?.();
    restoreRect = undefined;
  });

  it("returns requested position when it fits inside viewport", () => {
    const renders: Probe[] = [];
    render(<FlipProbe x={100} y={100} width={200} height={100} onRender={(p) => renders.push(p)} />);
    expect(renders[renders.length - 1]).toEqual({ left: 100, top: 100 });
  });

  it("shifts left when element would overflow right edge", () => {
    const renders: Probe[] = [];
    render(<FlipProbe x={900} y={100} width={200} height={100} onRender={(p) => renders.push(p)} />);
    // 900 + 200 = 1100 > 1000 - 4 → clamp to 1000 - 200 - 4 = 796
    expect(renders[renders.length - 1]).toEqual({ left: 796, top: 100 });
  });

  it("shifts up when element would overflow bottom edge", () => {
    const renders: Probe[] = [];
    render(<FlipProbe x={100} y={700} width={200} height={300} onRender={(p) => renders.push(p)} />);
    // 700 + 300 = 1000 > 800 - 4 → clamp to 800 - 300 - 4 = 496
    expect(renders[renders.length - 1]).toEqual({ left: 100, top: 496 });
  });

  it("clamps both axes when element overflows corner", () => {
    const renders: Probe[] = [];
    render(<FlipProbe x={950} y={700} width={200} height={300} onRender={(p) => renders.push(p)} />);
    expect(renders[renders.length - 1]).toEqual({ left: 796, top: 496 });
  });

  it("falls back to margin when element is larger than viewport", () => {
    const renders: Probe[] = [];
    render(<FlipProbe x={500} y={100} width={1200} height={100} onRender={(p) => renders.push(p)} />);
    expect(renders[renders.length - 1]).toEqual({ left: 4, top: 100 });
  });
});

describe("useSubmenuPosition", () => {
  let restoreRect: (() => void) | undefined;

  beforeEach(() => {
    stubViewport(1000, 800);
    restoreRect = installRectStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreRect?.();
    restoreRect = undefined;
  });

  it("returns hidden style when closed", () => {
    const renders: CSSProperties[] = [];
    render(
      <SubmenuProbe
        anchor={{ top: 100, left: 100, width: 100, height: 30 }}
        submenuSize={{ width: 180, height: 200 }}
        open={false}
        onRender={(s) => renders.push(s)}
      />,
    );
    expect(renders[renders.length - 1]).toEqual({ visibility: "hidden" });
  });

  it("places submenu to the right when it fits", () => {
    const renders: CSSProperties[] = [];
    render(
      <SubmenuProbe
        anchor={{ top: 100, left: 100, width: 100, height: 30 }}
        submenuSize={{ width: 180, height: 200 }}
        open={true}
        onRender={(s) => renders.push(s)}
      />,
    );
    // anchor.right (200) + 180 = 380 < 1000 - 4 → right side
    // anchor.top (100) + 200 = 300 < 800 - 4 → no vertical shift
    expect(renders[renders.length - 1]).toEqual({
      left: "100%",
      right: "auto",
      top: 0,
      visibility: "visible",
    });
  });

  it("flips to left when submenu would overflow right edge", () => {
    const renders: CSSProperties[] = [];
    render(
      <SubmenuProbe
        anchor={{ top: 100, left: 850, width: 100, height: 30 }}
        submenuSize={{ width: 180, height: 200 }}
        open={true}
        onRender={(s) => renders.push(s)}
      />,
    );
    // anchor.right (950) + 180 = 1130 > 1000 - 4 → flip
    expect(renders[renders.length - 1]).toMatchObject({
      left: "auto",
      right: "100%",
      visibility: "visible",
    });
  });

  it("shifts up when submenu would overflow bottom edge", () => {
    const renders: CSSProperties[] = [];
    render(
      <SubmenuProbe
        anchor={{ top: 700, left: 100, width: 100, height: 30 }}
        submenuSize={{ width: 180, height: 200 }}
        open={true}
        onRender={(s) => renders.push(s)}
      />,
    );
    // overflowBottom = 700 + 200 - (800 - 4) = 104
    // anchor.top - margin = 696, min(104, 696) = 104
    expect(renders[renders.length - 1]).toMatchObject({ top: -104, visibility: "visible" });
  });

  it("caps upward shift to anchor.top - margin", () => {
    const renders: CSSProperties[] = [];
    render(
      <SubmenuProbe
        anchor={{ top: 50, left: 100, width: 100, height: 30 }}
        submenuSize={{ width: 180, height: 900 }}
        open={true}
        onRender={(s) => renders.push(s)}
      />,
    );
    // overflowBottom = 50 + 900 - 796 = 154
    // anchor.top - margin = 46 → shiftUp = min(154, 46) = 46
    expect(renders[renders.length - 1]).toMatchObject({ top: -46, visibility: "visible" });
  });
});
