export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4.0;
export const ZOOM_STEP = 0.05;
export const ZOOM_DEFAULT = 1.0;

export interface PdfPageInfo {
  width: number;
  height: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  if (value < ZOOM_MIN) return ZOOM_MIN;
  if (value > ZOOM_MAX) return ZOOM_MAX;
  return value;
}

export function nextZoom(current: number): number {
  return round2(Math.min(ZOOM_MAX, current + ZOOM_STEP));
}

export function prevZoom(current: number): number {
  return round2(Math.max(ZOOM_MIN, current - ZOOM_STEP));
}

export function computePageHeights(
  infos: PdfPageInfo[],
  containerWidth: number,
  zoom: number,
): number[] {
  if (!containerWidth || infos.length === 0) return [];
  const effectiveWidth = containerWidth * zoom;
  return infos.map((info) => info.height * (effectiveWidth / info.width));
}
