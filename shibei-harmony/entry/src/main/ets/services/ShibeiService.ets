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
  resetDevice as napiResetDevice,
  setS3Config as napiSetS3Config,
  setE2eePassword as napiSetE2eePassword,
  syncMetadata as napiSyncMetadata,
  subscribeSyncProgress as napiSubscribeSyncProgress,
  decryptPairingPayload as napiDecryptPairingPayload,
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

  /// Factory-reset this device: clears local DB contents, cached snapshot
  /// files, and the in-memory Master Key. Subsequent cold start will land
  /// on Onboard because S3 config is wiped. Does NOT touch remote S3 data
  /// — the next sync after re-onboarding will repopulate everything.
  resetDevice(): void {
    const result: string = napiResetDevice();
    if (result !== 'ok') {
      throw new ShibeiError(result);
    }
  }

  // ── Pairing QR decrypt ────────────────────────────────────

  /// Decrypt a pairing envelope (scanned from the desktop QR) with the
  /// 6-digit PIN. Returns an S3ConfigInput ready to feed setS3Config.
  decryptPairingPayload(pin: string, envelopeJson: string): S3ConfigInput {
    const raw: string = napiDecryptPairingPayload(pin, envelopeJson);
    const parsed = JSON.parse(raw) as PairingPlain;
    if (parsed.error) {
      throw new ShibeiError(parsed.error);
    }
    // Plain payload uses snake_case; remap to the camelCase facade shape.
    return {
      endpoint: parsed.endpoint || undefined,
      region: parsed.region ?? '',
      bucket: parsed.bucket ?? '',
      accessKey: parsed.access_key ?? '',
      secretKey: parsed.secret_key ?? '',
    };
  }

  // ── Config + sync (Track A4 batch 1 + 3) ──────────────────

  /// Persist S3 config + credentials. No network call. Overwrites any
  /// previously-saved values.
  setS3Config(cfg: S3ConfigInput): void {
    const result: string = napiSetS3Config(JSON.stringify(cfg));
    if (result !== 'ok') {
      throw new ShibeiError(result);
    }
  }

  /// Download `meta/keyring.json` from S3, Argon2id-derive wrapper key
  /// from `password`, unwrap the Master Key and cache it. Async because
  /// the S3 round-trip dominates (~200ms).
  async setE2eePassword(password: string): Promise<void> {
    let result: string;
    try {
      result = await napiSetE2eePassword(password);
    } catch (rejected) {
      // NAPI async reject delivers a raw string, not an Error — convert it
      // into our ShibeiError shape so catch sites can rely on `err.code`.
      throw new ShibeiError(asErrorCode(rejected));
    }
    if (result !== 'ok') {
      throw new ShibeiError(result);
    }
  }

  /// Run one full sync pass. Returns the parsed SyncResult JSON envelope:
  ///   { kind: "success", uploaded, downloaded, applied } | { kind: "skipped" }
  async syncMetadata(): Promise<SyncResult> {
    let raw: string;
    try {
      raw = await napiSyncMetadata();
    } catch (rejected) {
      throw new ShibeiError(asErrorCode(rejected));
    }
    return JSON.parse(raw) as SyncResult;
  }

  /// Subscribe to per-phase progress emitted by `syncMetadata`. The callback
  /// receives one tick whenever the engine advances (uploading / downloading
  /// / applying / snapshots), plus a final `{phase:"done"}` tick on success.
  /// Returns the unsubscribe fn — caller must invoke it on unmount.
  ///
  /// Last-subscriber-wins on the Rust side: wiring a second listener while
  /// the first is alive silently dispossesses the first. In practice only
  /// one progress UI (Demo 12 / Onboard) is mounted at a time.
  onSyncProgress(listener: (ev: SyncProgressEvent) => void): () => void {
    return napiSubscribeSyncProgress((raw: string) => {
      try {
        const ev = JSON.parse(raw) as SyncProgressEvent;
        listener(ev);
      } catch (e) {
        hilog.warn(0x0000, 'shibei', 'bad sync-progress payload: %{public}s', raw);
      }
    });
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

// shibei-db serializes SearchResult with `#[serde(rename_all = "camelCase")]`
// so the wire shape is matchFields / matchedBody, not snake_case. Getting
// these names wrong crashes the page — `matchFields.includes(...)` throws
// "Cannot read property includes of undefined" when the field is absent.
export interface SearchResult extends Resource {
  matchFields: string[];
  snippet?: string | null;
  matchedBody?: boolean;
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

export interface S3ConfigInput {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface SyncResultSuccess {
  kind: 'success';
  uploaded: number;
  downloaded: number;
  applied: number;
}

export interface SyncResultSkipped {
  kind: 'skipped';
}

export type SyncResult = SyncResultSuccess | SyncResultSkipped;

/// Progress tick emitted during syncMetadata. `phase` values the engine
/// currently produces: "uploading" | "downloading" | "downloading_snapshots"
/// | "done". Unknown phases are safe to ignore — the UI falls back to an
/// indeterminate bar.
export interface SyncProgressEvent {
  phase: string;
  current: number;
  total: number;
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

interface PairingPlain {
  version?: number;
  endpoint?: string;
  region?: string;
  bucket?: string;
  access_key?: string;
  secret_key?: string;
  error?: string;
}

// NAPI async commands reject with a raw string (napi_reject_deferred of a
// utf8 value). ArkTS surfaces that string as the caught value directly, so
// `err.message` / `err.code` are undefined. Normalise it to an error code
// string our ShibeiError can carry.
function asErrorCode(rejected: Object): string {
  if (typeof rejected === 'string') return rejected as string;
  const asError = rejected as Error;
  if (asError && typeof asError.message === 'string') return asError.message;
  return 'error.unknown';
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
