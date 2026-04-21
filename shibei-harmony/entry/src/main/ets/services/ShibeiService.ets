// Single ArkTS facade over the generated NAPI module. Every component calls
// `ShibeiService.instance.xxx(...)` instead of `libshibei_core.xxx(...)`
// directly so error translation, debug logging, and any future in-flight
// deduplication live in one place.

// HarmonyOS native modules don't support `import * as napi` — ArkTS resolves
// that to `undefined`, which is why every `napi.foo()` below would throw
// "TypeError: undefined is not callable". Use named imports instead.
import {
  initApp as napiInitApp,
  isInitialized as napiIsInitialized,
  hasSavedConfig as napiHasSavedConfig,
  isUnlocked as napiIsUnlocked,
  lockVault as napiLockVault,
  listFolders as napiListFolders,
  listResources as napiListResources,
  searchResources as napiSearchResources,
  listTags as napiListTags,
  getResource as napiGetResource,
  getResourceSummary as napiGetResourceSummary,
  hello as napiHello,
  echoAsync as napiEchoAsync,
} from 'libshibei_core.so';
import { hilog } from '@kit.PerformanceAnalysisKit';

/// Thrown by ShibeiService when NAPI returns an error.* code. The raw code
/// (e.g. "error.notInitialized") is available for i18n lookup upstream.
export class ShibeiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ShibeiError';
    this.code = code;
  }
}

export class ShibeiService {
  private static _instance: ShibeiService | null = null;

  static get instance(): ShibeiService {
    if (!ShibeiService._instance) {
      ShibeiService._instance = new ShibeiService();
    }
    return ShibeiService._instance;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async init(dataDir: string): Promise<void> {
    const result: string = napiInitApp(dataDir);
    if (result !== 'ok') {
      hilog.error(0x0000, 'shibei', 'NAPI initApp failed: %{public}s', result);
      throw new ShibeiError(result);
    }
    hilog.info(0x0000, 'shibei', 'NAPI initApp ok dataDir=%{public}s', dataDir);
  }

  isInitialized(): boolean {
    return napiIsInitialized();
  }

  hasSavedConfig(): boolean {
    return napiHasSavedConfig();
  }

  isUnlocked(): boolean {
    return napiIsUnlocked();
  }

  lockVault(): void {
    napiLockVault();
  }

  // ── Queries (Track A4 batch 2) ────────────────────────────
  //
  // Each NAPI command returns a JSON string; the facade parses it here so
  // every caller hands back typed objects. Failure JSON has shape
  // `{"error": "..."}` — caller's type expects the happy-path shape, so
  // we throw ShibeiError when the error field is present.

  listFolders(): Folder[] {
    return parseListOrThrow<Folder>(napiListFolders(), 'listFolders');
  }

  listResources(folderId: string, tagIds: string[] = [], sort?: SortInput): Resource[] {
    const tagJson = JSON.stringify(tagIds);
    const sortJson = sort ? JSON.stringify(sort) : '';
    return parseListOrThrow<Resource>(
      napiListResources(folderId, tagJson, sortJson),
      'listResources',
    );
  }

  searchResources(query: string, tagIds: string[] = []): SearchResult[] {
    return parseListOrThrow<SearchResult>(
      napiSearchResources(query, JSON.stringify(tagIds)),
      'searchResources',
    );
  }

  listTags(): Tag[] {
    return parseListOrThrow<Tag>(napiListTags(), 'listTags');
  }

  getResource(id: string): Resource | null {
    const raw: string = napiGetResource(id);
    const parsed = JSON.parse(raw) as GetResourceEnvelope;
    if (parsed.error) {
      throw new ShibeiError(parsed.error);
    }
    return parsed.resource ?? null;
  }

  getResourceSummary(id: string, maxChars: number = 200): string {
    return napiGetResourceSummary(id, maxChars);
  }

  // ── Smoke tests (kept for Demo pages; remove when confidence earned) ─

  hello(): string {
    return napiHello();
  }

  async echoAsync(text: string): Promise<string> {
    return napiEchoAsync(text);
  }
}

// ── Types mirrored from shibei-db (kept narrow — only fields UI reads) ─

export interface Folder {
  id: string;
  name: string;
  parent_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Resource {
  id: string;
  title: string;
  url: string;
  folder_id: string;
  resource_type: string;
  created_at: string;
  captured_at: string;
  description?: string | null;
  // ... other fields exist; extend here when UI needs them.
}

export interface SearchResult extends Resource {
  match_fields: string[];
  snippet?: string | null;
  matched_body?: boolean;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface SortInput {
  by?: 'created_at' | 'annotated_at';
  order?: 'asc' | 'desc';
}

// NAPI error-envelope shape. `error` is present iff the Rust side folded a
// failure into the JSON response. Declared as a named interface (ArkTS
// forbids object-literal types with arkts-no-obj-literals-as-types).
interface ErrorEnvelope {
  error?: string;
}

interface GetResourceEnvelope {
  resource?: Resource | null;
  error?: string;
}

// NAPI returns either a JSON array (happy path) or `{"error": "..."}`.
// ArkTS strict mode forbids:
//   - `any`/`unknown` typing for JSON.parse output (arkts-no-any-unknown)
//   - the `in` operator (arkts-no-in)
// Work around both by casting to a narrow ErrorEnvelope shape and probing
// the field directly.
function parseListOrThrow<T>(raw: string, label: string): T[] {
  const parsed = JSON.parse(raw) as Object;
  if (!Array.isArray(parsed)) {
    const envelope = parsed as ErrorEnvelope;
    if (envelope.error) {
      throw new ShibeiError(envelope.error);
    }
    throw new ShibeiError(`${label}: unexpected response shape`);
  }
  return parsed as T[];
}
