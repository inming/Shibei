// Per-resource scroll position persistence for the Reader.
//
// Stored as a JSON map `{ resourceId: yOffset }` under key
// `reader:scrollMap` in the shared `shibei_prefs` store. Kept as one blob
// (not one key per resource) so we can trim old entries in a single pass
// if the map ever grows unbounded.

import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';

const PREF_STORE = 'shibei_prefs';
const PREF_KEY = 'reader:scrollMap';

interface ScrollMap {
  [resourceId: string]: number;
}

async function loadMap(ctx: common.UIAbilityContext): Promise<ScrollMap> {
  try {
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    const raw = await store.get(PREF_KEY, '{}') as string;
    const parsed = JSON.parse(raw) as ScrollMap;
    return parsed ?? {};
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'ReaderScrollState.loadMap fail: %{public}s',
      (err as Error).message);
    return {};
  }
}

export async function getReaderScroll(
  ctx: common.UIAbilityContext,
  resourceId: string,
): Promise<number> {
  const map = await loadMap(ctx);
  const v = map[resourceId];
  return typeof v === 'number' ? v : 0;
}

export async function saveReaderScroll(
  ctx: common.UIAbilityContext,
  resourceId: string,
  y: number,
): Promise<void> {
  try {
    const map = await loadMap(ctx);
    map[resourceId] = y;
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    await store.put(PREF_KEY, JSON.stringify(map));
    await store.flush();
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'ReaderScrollState.save fail: %{public}s',
      (err as Error).message);
  }
}
