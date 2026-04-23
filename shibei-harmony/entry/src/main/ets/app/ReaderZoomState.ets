// Per-resource PDF zoom persistence for the Reader.
//
// Stored alongside scroll state (same `shibei_prefs` store) under key
// `reader:zoomMap` as JSON `[resourceId, zoom]` tuples. Mirrors
// ReaderScrollState.ets layout verbatim — keep them in sync if you add
// fields or change the serialization shape.
//
// Zoom is clamped [0.5, 4.0] at write time so a pref-file corruption
// can't produce an out-of-range value that breaks the shell.

import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';

const PREF_STORE = 'shibei_prefs';
const PREF_KEY = 'reader:zoomMap';

export const PDF_ZOOM_MIN = 0.5;
export const PDF_ZOOM_MAX = 4.0;
export const PDF_ZOOM_DEFAULT = 1.0;
export const PDF_ZOOM_STEP = 0.05;

type Entry = [string, number];

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return PDF_ZOOM_DEFAULT;
  if (z < PDF_ZOOM_MIN) return PDF_ZOOM_MIN;
  if (z > PDF_ZOOM_MAX) return PDF_ZOOM_MAX;
  // Round to 2 decimals so +/- steps don't accumulate FP drift across
  // save cycles (matches shell main.js clampZoom).
  return Math.round(z * 100) / 100;
}

async function loadMap(ctx: common.UIAbilityContext): Promise<Map<string, number>> {
  try {
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    const raw = await store.get(PREF_KEY, '[]') as string;
    const parsed = JSON.parse(raw) as Entry[];
    const map = new Map<string, number>();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && entry.length === 2
            && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
          map.set(entry[0], clampZoom(entry[1]));
        }
      }
    }
    return map;
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'ReaderZoomState.loadMap fail: %{public}s',
      (err as Error).message);
    return new Map<string, number>();
  }
}

function serializeMap(map: Map<string, number>): string {
  const entries: Entry[] = [];
  map.forEach((z: number, id: string) => { entries.push([id, z]); });
  return JSON.stringify(entries);
}

export async function getReaderZoom(
  ctx: common.UIAbilityContext,
  resourceId: string,
): Promise<number> {
  const map = await loadMap(ctx);
  return map.get(resourceId) ?? PDF_ZOOM_DEFAULT;
}

export async function saveReaderZoom(
  ctx: common.UIAbilityContext,
  resourceId: string,
  zoom: number,
): Promise<void> {
  try {
    const map = await loadMap(ctx);
    map.set(resourceId, clampZoom(zoom));
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    await store.put(PREF_KEY, serializeMap(map));
    await store.flush();
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'ReaderZoomState.save fail: %{public}s',
      (err as Error).message);
  }
}
