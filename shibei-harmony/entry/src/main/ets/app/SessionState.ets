// Session persistence — mirrors the desktop src/lib/sessionState.ts schema
// (simplified: mobile has at most one Reader open, no tab bar).
//
// Reader scroll and PDF zoom are NOT stored here; they already have their
// own per-resource persistence in ReaderScrollState.ets / ReaderZoomState.ets.
// This module only records "which Reader is open" + library selection state.
//
// ArkTS strict mode constraints:
//   - No object spread (`...`) — use manual field copy
//   - No `in` operator — use `!== undefined` / `!== null`
//   - No `unknown` — use explicit types
//   - Object literals must correspond to named interfaces

import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PREF_SESSION_STATE } from './AppStorageKeys';

const CURRENT_VERSION = 1;
const PREF_STORE = 'shibei_prefs';

export interface SessionState {
  version: 1;
  inReader: boolean;
  readerResourceId: string | null;
  library: SessionLibrary;
}

export interface SessionLibrary {
  selectedFolderId: string;
  selectedTagIds: string[];
  selectedResourceId: string | null;
  listScrollTop?: number;
}

function makeDefaultState(): SessionState {
  return {
    version: CURRENT_VERSION,
    inReader: false,
    readerResourceId: null,
    library: {
      selectedFolderId: '__all__',
      selectedTagIds: [],
      selectedResourceId: null,
    },
  };
}

function makeDefaultLibrary(): SessionLibrary {
  return {
    selectedFolderId: '__all__',
    selectedTagIds: [],
    selectedResourceId: null,
  };
}

function validate(raw: Record<string, Object>): SessionState {
  const version = raw['version'] as number;
  if (typeof version !== 'number' || version !== CURRENT_VERSION) {
    return makeDefaultState();
  }
  const inReader = raw['inReader'] as boolean;
  const readerResourceId = raw['readerResourceId'] as string | null;
  const libRaw = raw['library'] as Record<string, Object> | undefined;

  const state: SessionState = {
    version: CURRENT_VERSION,
    inReader: typeof inReader === 'boolean' ? inReader : false,
    readerResourceId: typeof readerResourceId === 'string' ? readerResourceId : null,
    library: makeDefaultLibrary(),
  };

  if (libRaw !== undefined && libRaw !== null) {
    const folderId = libRaw['selectedFolderId'] as string;
    if (typeof folderId === 'string') {
      state.library.selectedFolderId = folderId;
    }
    const tagIds = libRaw['selectedTagIds'] as string[];
    if (Array.isArray(tagIds)) {
      const filtered: string[] = [];
      for (let i = 0; i < tagIds.length; i++) {
        if (typeof tagIds[i] === 'string') {
          filtered.push(tagIds[i] as string);
        }
      }
      state.library.selectedTagIds = filtered;
    }
    const resId = libRaw['selectedResourceId'] as string | null;
    if (typeof resId === 'string' || resId === null) {
      state.library.selectedResourceId = resId;
    }
    const scrollTop = libRaw['listScrollTop'] as number;
    if (typeof scrollTop === 'number') {
      state.library.listScrollTop = scrollTop;
    }
  }

  return state;
}

function mergeLibrary(base: SessionLibrary, patch: SessionLibrary): SessionLibrary {
  const result: SessionLibrary = {
    selectedFolderId: patch.selectedFolderId !== undefined ? patch.selectedFolderId : base.selectedFolderId,
    selectedTagIds: patch.selectedTagIds !== undefined ? patch.selectedTagIds : base.selectedTagIds,
    selectedResourceId: patch.selectedResourceId !== undefined ? patch.selectedResourceId : base.selectedResourceId,
    listScrollTop: patch.listScrollTop !== undefined ? patch.listScrollTop : base.listScrollTop,
  };
  return result;
}

function mergeState(base: SessionState, patch: Partial<SessionState>): SessionState {
  const result: SessionState = {
    version: CURRENT_VERSION,
    inReader: patch.inReader !== undefined ? (patch.inReader as boolean) : base.inReader,
    readerResourceId: patch.readerResourceId !== undefined
      ? (patch.readerResourceId as string | null) : base.readerResourceId,
    library: patch.library !== undefined
      ? mergeLibrary(base.library, patch.library as SessionLibrary)
      : base.library,
  };
  return result;
}

export namespace SessionState {
  export async function load(ctx: common.UIAbilityContext): Promise<SessionState> {
    try {
      const store: preferences.Preferences = await preferences.getPreferences(ctx, PREF_STORE);
      const raw: string = await store.get(PREF_SESSION_STATE, '') as string;
      if (raw === '' || raw === null || raw === undefined) {
        return makeDefaultState();
      }
      const parsed: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      return validate(parsed);
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'SessionState.load fail: %{public}s',
        (err as Error).message);
      return makeDefaultState();
    }
  }

  export async function save(
    ctx: common.UIAbilityContext,
    patch: Partial<SessionState>,
  ): Promise<void> {
    try {
      const current: SessionState = await load(ctx);
      const merged: SessionState = mergeState(current, patch);
      const store: preferences.Preferences = await preferences.getPreferences(ctx, PREF_STORE);
      const json: string = JSON.stringify(merged);
      await store.put(PREF_SESSION_STATE, json);
      await store.flush();
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'SessionState.save fail: %{public}s',
        (err as Error).message);
    }
  }

  export async function clear(ctx: common.UIAbilityContext): Promise<void> {
    try {
      const store: preferences.Preferences = await preferences.getPreferences(ctx, PREF_STORE);
      await store.put(PREF_SESSION_STATE, JSON.stringify(makeDefaultState()));
      await store.flush();
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'SessionState.clear fail: %{public}s',
        (err as Error).message);
    }
  }
}
