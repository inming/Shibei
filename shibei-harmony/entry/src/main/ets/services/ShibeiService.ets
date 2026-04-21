// Single ArkTS facade over the generated NAPI module. Every component calls
// `ShibeiService.instance.xxx(...)` instead of `libshibei_core.xxx(...)`
// directly so error translation, debug logging, and any future in-flight
// deduplication live in one place.

// HarmonyOS native modules don't support `import * as napi` — ArkTS resolves
// that to `undefined`, which is why every `napi.foo()` below would throw
// "TypeError: undefined is not callable". Use named imports instead.
import {
  init as napiInit,
  isInitialized as napiIsInitialized,
  hasSavedConfig as napiHasSavedConfig,
  isUnlocked as napiIsUnlocked,
  lockVault as napiLockVault,
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
    const result: string = napiInit(dataDir);
    if (result !== 'ok') {
      hilog.error(0x0000, 'shibei', 'NAPI init failed: %{public}s', result);
      throw new ShibeiError(result);
    }
    hilog.info(0x0000, 'shibei', 'NAPI init ok dataDir=%{public}s', dataDir);
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

  // ── Smoke tests (kept for Demo pages; remove when confidence earned) ─

  hello(): string {
    return napiHello();
  }

  async echoAsync(text: string): Promise<string> {
    return napiEchoAsync(text);
  }
}
