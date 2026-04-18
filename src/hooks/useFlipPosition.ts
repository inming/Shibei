import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const DEFAULT_MARGIN = 4;

/**
 * Clamp a fixed-positioned element's top/left so it stays inside the viewport.
 *
 * Pass the element's ref and the desired viewport-space (x, y). After the element
 * mounts we measure it with getBoundingClientRect() and flip/shift so it never
 * overflows past `margin` from any edge.
 */
export function useFlipPosition(
  ref: RefObject<HTMLElement | null>,
  desiredX: number,
  desiredY: number,
  margin: number = DEFAULT_MARGIN,
): { left: number; top: number } {
  const [pos, setPos] = useState({ left: desiredX, top: desiredY });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = desiredX;
    let top = desiredY;
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    setPos({ left, top });
  }, [ref, desiredX, desiredY, margin]);
  return pos;
}

/**
 * Position a submenu relative to an anchor element (e.g. the parent menu item).
 *
 * Default placement: flush right of the anchor (`left: 100%`, `top: 0`).
 * When the submenu would overflow the right edge, flips to `right: 100%`.
 * When it would overflow the bottom edge, shifts up by the overflow amount
 * (clamped so it doesn't go past the top margin).
 *
 * Returns CSS properties to merge into the submenu style. While `open` is false
 * or refs aren't mounted yet, returns `{ visibility: "hidden" }` to avoid a
 * flash of unpositioned content.
 */
export function useSubmenuPosition(
  anchorRef: RefObject<HTMLElement | null>,
  submenuRef: RefObject<HTMLElement | null>,
  open: boolean,
  margin: number = DEFAULT_MARGIN,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }
    const anchor = anchorRef.current;
    const submenu = submenuRef.current;
    if (!anchor || !submenu) return;
    const anchorRect = anchor.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();

    const flipHorizontal = anchorRect.right + submenuRect.width > window.innerWidth - margin;

    const overflowBottom = anchorRect.top + submenuRect.height - (window.innerHeight - margin);
    const shiftUp = Math.max(0, Math.min(overflowBottom, anchorRect.top - margin));

    setStyle({
      left: flipHorizontal ? "auto" : "100%",
      right: flipHorizontal ? "100%" : "auto",
      top: shiftUp === 0 ? 0 : -shiftUp,
      visibility: "visible",
    });
  }, [open, anchorRef, submenuRef, margin]);
  return style;
}
