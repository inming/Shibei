// Per-resource scroll position persistence for the Reader.
//
// Serialized as an array of `[resourceId, yOffset]` tuples under key
// `reader:scrollMap` in the shared `shibei_prefs` store. Kept as one blob
// (not one key per resource) so we can trim old entries in a single pass
// if the map ever grows unbounded. At runtime the blob is rehydrated into
// a Map<string, number> — ArkTS strict mode forbids index signatures
// (`{ [key: string]: T }`) and bracket-access (`obj[key]`), so plain
// object shapes aren't viable.

import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';

const PREF_STORE = 'shibei_prefs';
const PREF_KEY = 'reader:scrollMap';

// On-disk shape — JSON array of `[id, y]` pairs. ArkTS allows tuple types.
type Entry = [string, number];

async function loadMap(ctx: common.UIAbilityContext): Promise<Map<string, number>> {
  try {
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    const raw = await store.get(PREF_KEY, '[]') as string;
    const parsed = JSON.parse(raw) as Entry[];
    const map = new Map<string, number>();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
          map.set(entry[0], entry[1]);
        }
      }
    }
    return map;
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'ReaderScrollState.loadMap fail: %{public}s',
      (err as Error).message);
    return new Map<string, number>();
  }
}

function serializeMap(map: Map<string, number>): string {
  const entries: Entry[] = [];
  map.forEach((y: number, id: string) => { entries.push([id, y]); });
  return JSON.stringify(entries);
}

export async function getReaderScroll(
  ctx: common.UIAbilityContext,
  resourceId: string,
): Promise<number> {
  const map = await loadMap(ctx);
  return map.get(resourceId) ?? 0;
}

export async function saveReaderScroll(
  ctx: common.UIAbilityContext,
  resourceId: string,
  y: number,
): Promise<void> {
  try {
    const map = await loadMap(ctx);
    map.set(resourceId, y);
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    await store.put(PREF_KEY, serializeMap(map));
    await store.flush();
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'ReaderScrollState.save fail: %{public}s',
      (err as Error).message);
  }
}
