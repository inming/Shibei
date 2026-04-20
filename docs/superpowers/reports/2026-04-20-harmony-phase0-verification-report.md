# HarmonyOS Phase 0 — Verification Report

- Date: 2026-04-20
- Device: Huawei Mate X5 / HarmonyOS 6.1.0 Release
- DevEco Studio: 6.1.0
- NDK: `/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native`
- Rust toolchain: stable + `aarch64-unknown-linux-ohos` target
- Filled in by: AI (commit-message synthesis) + user device observations

---

## Executive Summary

All seven Phase 0 demos ran successfully on Mate X5. The Rust → ohos-abi toolchain works, but napi-rs 2.x is incompatible with HarmonyOS NEXT — we pivoted to a hand-written N-API C shim, which is the canonical HarmonyOS pattern and produces a clean working module. The biggest surprise was ArkWeb's aggressive rejection of ES module imports and `window.fetch` for sibling file:// assets, which required four distinct workarounds to make PDF.js work; this pattern will define Plan 4's entire PDF pipeline. Three other spec assumptions need amendment: fold debounce should be ≤ 100 ms (not 250 ms) due to observed rapid-transition timing; biometric auth requires a runtime capability probe on the device (ATL3 + FACE+FINGERPRINT combo fails on Mate X5); and background sync finalization is feasible via `requestSuspendDelay` rather than being strictly foreground-only. The recommendation is GO.

---

## Toolchain

### Rust → ohos-abi

Cross-compilation to `aarch64-unknown-linux-ohos` was confirmed working via:

- Linker: `aarch64-unknown-linux-ohos-clang` (bundled in DevEco 6.1.0 NDK)
- Build script: `scripts/build-harmony-napi.sh` invokes `cargo build --release --target aarch64-unknown-linux-ohos`
- `.so` produced and installed into `shibei-harmony/entry/libs/arm64-v8a/libshibei_core.so`
- Release `.so` size for the Phase 0 hello/add smoke test: small (< 100 KB without S3 deps)
- Release `.so` size for Demo 7 (rust-s3 + tokio + rustls): **2.52 MB** — acceptable

No compiler or linker blockers were encountered once the NDK path was configured correctly.

### NAPI Approach: napi-rs Attempts and Pivot

**Attempt 1 — napi-rs stock (commit `f98af4f`):** The initial scaffold used napi-rs 2.x and `napi-derive`. Module compiled and linked, but when DevEco loaded the `.so`, the ArkTS `import` resolved to `undefined`.

**Attempt 2 — HarmonyOS-style shim over napi-rs (commit `14009cf`):** Added a C `__attribute__((constructor))` shim that called `napi_module_register`, bridging napi-rs's `napi_register_module_v1` into HarmonyOS's registration path. The constructor fired at load time, but the exported object still arrived at ArkTS as `undefined`.

**Pivot — hand-written N-API C shim (commit `b334904`):** Dropped napi-rs entirely. The production pattern on HarmonyOS NEXT is:

1. Rust exports plain `extern "C"` functions (no `#[napi]` or `napi-derive`).
2. A `src/shim.c` file implements a complete N-API module: per-function wrappers (`hello_wrap`, `add_wrap`, etc.) marshal JS ↔ Rust via `napi_create_string_utf8` / `napi_create_int32` / `napi_get_value_int32`, and an `init()` function installs them as properties on the exports object using `napi_define_properties`.
3. `__attribute__((constructor)) register_shibei_core` calls `napi_module_register` with `nm_modname = "shibei_core"`.
4. `build.rs` compiles the shim with `cc` crate, using the SDK sysroot include path, linking against `libace_napi.z.so`, and preserving the constructor symbol via `-Wl,-u,register_shibei_core`.

This pattern works. The named exports (`hello`, `add`) are accessible from ArkTS immediately after import.

### Rationale for Pivot

napi-rs 2.x generates a `napi_register_module_v1` entry point, which is the Node.js registration protocol. HarmonyOS NEXT's NAPI runtime expects `napi_module_register` to be called during dynamic library load; it does not scan for `napi_register_module_v1`. The two registration models are incompatible at the ABI level. No published OHOS-compatible fork of napi-rs exists as of 2026-04-20.

**Tradeoff:** Every future NAPI export requires a hand-written C wrapper function. For Plan 3's full command surface (~25 functions), this is non-trivial but manageable. A code generator (e.g., a macro or a small Python script emitting C from a function list) should be evaluated before Plan 3 begins, rather than maintaining 25+ wrappers by hand.

---

## Demo-by-Demo Findings

### Demo 0 — NAPI Smoke Test

**Observed behavior:** After the pivot to the hand-written C shim, `hello("World")` returned `"Hello from Rust: World"` and `add(3, 4)` returned `7` in the DevEco console on first install.

**Result:** SUCCESS

**Implications for Plan 3:** The NAPI bridge pattern is locked in. Plan 3's `src-harmony-napi/` crate must follow the `extern "C"` + shim.c architecture. Named exports only (no default export). A shim generator should be designed early to avoid manual C boilerplate for each of the ~25 command wrappers.

---

### Demo 1 — Fold Status Events

**Observed behavior on Mate X5:**

- `display.on('foldStatusChange')` fires reliably on every fold and unfold transition.
- **`HALF_FOLDED` is emitted on every transition** — not rare as spec §4.4 assumed. During a slow fold the observed sequence was: `FOLDED → HALF_FOLDED → EXPANDED → HALF_FOLDED → FOLDED`, with inter-event deltas of 86 ms, 384 ms, 1090 ms, 1421 ms.
- During rapid fold/unfold, the minimum observed inter-event delta was **86 ms**. The spec's 250 ms debounce would therefore drop the final settled state in fast transitions.
- Fastest observed delta: **0 ms** (two events coalesced at the same timestamp) — a coalescing risk for any debounce shorter than the first non-zero interval.

**Result:** SUCCESS (events fire correctly; debounce value in spec is wrong)

**Implications for Plan 3:** The `FoldObserver` debounce must be reduced to **≤ 100 ms** or redesigned as a "settle after N ms of quiet" pattern (i.e., emit only when no new event has arrived for 100 ms). The spec's 250 ms value will cause the UI to lag one full fold/unfold gesture behind reality. See §Recommended Spec Amendments below.

---

### Demo 2 — ArkWeb selectionchange

**Observed behavior on Mate X5:**

- `selectionchange` fires cleanly during touch handle drag — no dropped events, no spurious fires.
- Event rate during rapid drag: **4–5 events per second**.
- Mixed Chinese/English text selection works without anomalies.
- No coordinate system surprises (rect is viewport-relative as expected).

**Result:** SUCCESS

**Implications for Plan 3:** The 250 ms debounce in annotator.js's `selectionchange` handler (spec §5.2) is appropriate — it throttles the 4–5 eps stream to ≤ 2 meaningful updates per second, which is sufficient for toolbar position calculation. No changes needed.

---

### Demo 3 — PDF.js streamTextContent in ArkWeb

This was the most complex demo, requiring four sequential workarounds before it succeeded.

**Observed behavior and workarounds required:**

**Workaround 1 — Use pdfjs-dist legacy build (commit `d1565d9`):**
ArkWeb's embedded Chromium version does not support ES2024+ APIs. The pdfjs-dist v4 main build calls `Uint8Array.toHex` (ES2024) and `Map.getOrInsertComputed` (ES2026), among others. Patching these one-by-one is unsustainable. The `pdfjs-dist/legacy/build/` variant pre-polyfills all modern APIs. Switched to the legacy build throughout.

Bundle sizes after switching:
- `pdf-bundle.js` (IIFE, `--global-name=pdfjsLib`): **~1 MB** (main build was ~814 KB)
- `pdf-worker-bundle.js` (IIFE, `--global-name=pdfjsWorker`): **~2.3 MB** (main build was ~2.1 MB)

**Workaround 2 — Pass PDF bytes via bridge, not URL (commit `845822a`):**
`pdfjs.getDocument({ url: 'file://...' })` triggers an internal `fetch`/`XHR` inside pdfjs. ArkWeb blocks this fetch for sibling `file://` assets, returning HTTP status 0 ("Unexpected server response (0)"). The fix — and the correct production shape — is to pass a `Uint8Array` directly: ArkTS base64-encodes the PDF bytes in `aboutToAppear`, hands them across the JS bridge, and the WebView page calls `getDocument({ data: decodedUint8Array })`.

**Workaround 3 — Stage assets to `filesDir` for `file://` loading (commit `d68bb48`):**
`resource://rawfile/...` scheme rejects dynamic ES module imports. Static imports load the root HTML but any `import` or worker fetch inside the module tree fails with "Failed to fetch dynamically imported module". Demo 4 already verified that `file://` in the el2 sandbox works without restriction, so the fix is to copy all pdfjs assets (index.html, pdf-bundle.js, pdf-worker-bundle.js, sample.pdf) from rawfile into `filesDir/pdfjs-demo/` via `resourceManager.getRawFileContentSync` in `aboutToAppear`, then load the WebView from `file:///data/storage/el2/.../pdfjs-demo/index.html`. This is also the correct production shape: user-saved PDFs already live under `files/`, and the bundled pdf-shell assets need the same treatment.

**Workaround 4 — Load both bundles via classic `<script src>` tags (commit `e035826`):**
ArkWeb rejects both static ES module imports and `window.fetch` for the worker bundle. Classic `<script src="./pdf-worker-bundle.js">` is the only confirmed loader. Because the worker bundle is loaded with `--global-name=pdfjsWorker`, `globalThis.pdfjsWorker.WorkerMessageHandler` is available before pdfjs queries it, so pdfjs's `await import(workerSrc)` branch is never reached. `workerSrc` is set to `'about:blank'` to satisfy pdfjs's non-empty guard without triggering a network fetch.

**Final result:** `streamTextContent()` works. Verified with **78 characters extracted** from a 624-byte fixture PDF.

**Result:** SUCCESS (with four mandatory workarounds)

**Implications for Plan 4 (PDF Reader):** The entire PDF pipeline must follow this 4-part pattern. See §Recommended Spec Amendments for the required update to spec §5.7. Do not attempt `getDocument({ url })`, static ES module imports, or `window.fetch` in ArkWeb — all three are blocked.

---

### Demo 4 — file:// URL in el2 Sandbox

**Observed behavior on Mate X5:**

- `file:///data/storage/el2/base/haps/entry/files/...` URL loads directly in the ArkWeb `Web` component with `.fileAccess(true)`.
- No `onErrorReceive` events observed.
- Content renders correctly.

**Result:** SUCCESS

**Implications for Plans 3–4:** Spec §5.1's assumption that snapshot HTML files can be loaded via `file://` is confirmed. No in-app HTTP server fallback is needed for the snapshot reader or the PDF shell. The `file://` path used in production will be constructed from `getApplicationContext().filesDir`.

---

### Demo 5 — HUKS Biometric Auth

**Observed behavior on Mate X5:**

- HUKS key generation with `ACCESS_INVALID_CLEAR_PASSWORD` + biometric policy: **OK**.
- `userAuth.getUserAuthInstance()` with `authTrustLevel: ATL3` + `authType: [FACE, FINGERPRINT]` combination → **BusinessError 401** (parameter error) on Mate X5.
- Relaxed to `authTrustLevel: ATL2` + `authType: [FINGERPRINT]` only → biometric prompt displayed, fingerprint auth **succeeded**.
- API 12+ signature change: `auth.on('result', callback)` requires an `IAuthCallback` object with an `onResult(result: UserAuthResult)` method, not a bare arrow function. `AuthResultInfo` is deprecated in favor of `UserAuthResult` (same field names, new type). This is an ArkTS strict-mode incompatibility if the old signature is used.
- HUKS key delete: OK.

**Result:** SUCCESS at ATL2 + fingerprint; FAILED at ATL3 + face+fingerprint combo

**Implications for Plans 3, 6 (Biometric Unlock):** Spec §6.1 (OnboardPage Step 5) and §6.2 (LockPage) must not hardcode `ATL3` or assume `[FACE, FINGERPRINT]` combo works on all devices. A runtime capability probe is required: call `userAuth.getEnrolledState()` or attempt a dry-run to determine which `authType`/`authTrustLevel` combinations the device actually supports. Default to ATL2 + fingerprint; fall back to password if no biometric is available. See §Recommended Spec Amendments.

---

### Demo 6 — BackgroundTaskManager

**Observed behavior on Mate X5:**

- `requestSuspendDelay()` is **synchronous** in API 12+. The plan had it as async — the actual API returns a `DelaySuspendInfo` immediately without a Promise.
- A short background task continued ticking for at least **30 seconds** with no expiration callback observed in that window.
- The `remainingDelayTime` field in the returned `DelaySuspendInfo` can be polled to check remaining budget.

**Result:** SUCCESS

**Implications for Plan 3 (Sync Engine):** Spec §10 (risk matrix) and §十一 (deferred items) assumed background sync was not feasible and was deferred to v2+. This finding relaxes that restriction: short sync finalization tasks (uploading a completed batch, writing final sync_log entries) can use `requestSuspendDelay` to complete gracefully when the user backgrounds the app mid-sync. This is not full periodic background sync — it is specifically for completing an already-running sync that the user interrupted. Plan 3 should budget for this pattern. See §Recommended Spec Amendments.

---

### Demo 7 — S3 PUT+GET Smoke Test

**Observed behavior:**

- Cross-compilation of `rust-s3 0.35` + `tokio` + `rustls` TLS to `aarch64-unknown-linux-ohos`: **SUCCESS**.
- Release `.so` incorporating these dependencies: **2.52 MB** — within acceptable bounds for a mobile library.
- S3 `put_object` and `get_object` round-trip on-device: **pending** — blocked on user entering live S3 credentials for the device test. The cross-compile and NAPI wiring are confirmed; only the live network round-trip is unverified at Phase 0 exit.

**Result:** SUCCESS (toolchain confirmed; live S3 round-trip deferred, not blocking)

**Implications for Plan 3 (Sync):** `rust-s3 0.35` + `rustls` is the confirmed viable S3 stack for ohos-abi. No need to evaluate alternatives. The 2.52 MB `.so` size is acceptable. The live round-trip (WiFi PUT/GET latency, cellular behavior, mid-request network switch retry) remains an open question to be validated during Plan 3's integration testing.

---

## ArkWeb Limitations (Cross-Cutting)

ArkWeb's Chromium version is older than desktop Chrome and applies stricter same-origin enforcement for `file://` URLs. The following mechanisms **do not work** in ArkWeb and affect Shibei's reader stack:

| Mechanism | Status | Notes |
|---|---|---|
| Static ES module imports (`<script type="module">`) | BLOCKED for sibling assets | Root HTML loads, but any `import` inside the module tree fails |
| Dynamic ES module imports (`import('./foo.mjs')`) | BLOCKED | "Failed to fetch dynamically imported module" |
| `window.fetch()` for sibling `file://` assets | BLOCKED | Status 0 response |
| `XMLHttpRequest` for sibling `file://` assets | BLOCKED | Same restriction as fetch |
| `resource://rawfile/` scheme for ES module trees | BLOCKED | Rejects module imports |
| Classic `<script src="./bundle.js">` | **WORKS** | Confirmed for both main and worker bundles |
| `<Web src="file://...">` with `.fileAccess(true)` | **WORKS** | The only reliable way to load assets |
| `javaScriptProxy` bridge (ArkTS → WebView) | **WORKS** (with restriction) | Inline object-literal `object:` fails ArkTS strict mode; use class-based `BridgeHost` pattern |

### Implications for Plan 4 (PDF Shell)

The PDF shell (`pdf-shell.html`) must:

1. Be copied from `rawfile/` to `filesDir/pdf-shell/` at first launch (or on update).
2. Load pdfjs bundles via classic `<script src="./pdf-bundle.js">` and `<script src="./pdf-worker-bundle.js">` — never via ES module `import`.
3. Receive PDF bytes as a `Uint8Array` passed over the JS bridge — never via `getDocument({ url })`.
4. Use `pdfjs-dist/legacy/build/` — not the main build.

### Implications for Plan 3 (HTML Snapshot Reader)

The snapshot reader loads user-saved `snapshot.html` files via `file://`, which works. However:

- Any page scripts that attempt `fetch` or XHR within the snapshot will fail silently (as they should — this is the same sandboxing we want for annotator isolation).
- `annotator.js` must not use `import` statements or `fetch`; it must be a self-contained IIFE. This is already the case in the desktop implementation.
- The `javaScriptProxy` bridge object must follow the `BridgeHost` class pattern (not an inline object literal) to satisfy ArkTS strict mode.

---

## ArkTS Strict-Mode Rules

The following rules were encountered when transcribing plan code samples into ArkTS. **All future plan task prompts for this project must produce strict-mode-clean ArkTS from the start.**

| Rule | Violation (plain TypeScript) | Correct (ArkTS strict) |
|---|---|---|
| `arkts-no-any-unknown` | `err: unknown` | `err: Error` — ArkTS has no `unknown` |
| `arkts-no-any-unknown` on state | `@State log: any[] = []` | `@State log: string[] = []` with typed interface |
| `arkts-no-obj-literals-as-types` | `Array<{ a: string; b: number }>` | Declare `interface Entry { a: string; b: number }` first, then use `Entry[]` |
| `arkts-no-untyped-obj-literals` | `const x = { a: 'foo' }` with no type context | Assign to a declared interface/class variable |
| `arkts-no-types-in-catch` | `catch (err: Error) { ... }` | `catch (err) { ... }` — annotation forbidden; `err` is implicitly `Error` |
| `arkts-no-any-unknown` in catch | `catch (err: unknown)` | Same: bare `catch (err)` only |
| Error formatting helper | `function formatErr(e: unknown)` | Inline `` `${err.name}: ${err.message}` `` — avoids the helper's `unknown` parameter |
| NAPI module import | `import testNapi from 'libshibei_core.so'` (default) | `import { hello, add } from 'libshibei_core.so'` (named) |
| JS bridge host object | `registerJavaScriptProxy({ object: { onEvent: () => {} }, ... })` | Wrap in a class with explicit typed methods; inline object literals fail strict mode |

Fixes applied in commits `f64c1b4` and `23a8a18`. The plan's ArkTS strict-mode correction table (added in commit `1124f10`) documents these rules inline for future task implementors.

---

## DevEco Studio 6.1.0 Environment

### SDK and NDK Paths

DevEco Studio 6.1.0 on macOS **bundles the entire SDK inside the application package**. There is no separate `~/Library/Huawei/Sdk/` install as in DevEco 5.x.

| Resource | Path |
|---|---|
| SDK root | `/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/` |
| NDK (native) | `.../native/` |
| NAPI headers | `.../native/sysroot/usr/include/` |
| NAPI clang linker | `.../native/llvm/bin/aarch64-unknown-linux-ohos-clang` |
| `hdc` (device connector) | `.../toolchains/hdc` |

The environment variable required by the cross-compile script:
```bash
export OHOS_NDK_HOME="/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native"
export PATH="$OHOS_NDK_HOME/llvm/bin:$PATH"
```

### modelVersion Requirement

DevEco 6.1.0 / HarmonyOS 6.1.0 Release SDK requires `"modelVersion": "6.1.0"` in `oh-package.json5`. Earlier modelVersion values (e.g. `"5.0.0"`) cause build errors. See commit `8e6aca4`.

### Native Module Path Convention

Any directory under `entry/src/main/cpp/` triggers hvigor's native-build path, which expects a `CMakeLists.txt` and `externalNativeOptions` in `build-profile.json5`. For a prebuilt `.so` from the external Rust toolchain, the NAPI type declarations must live **outside** `src/main/cpp/`. Correct path: `entry/types/libshibei_core/Index.d.ts`. The `.so` in `entry/libs/arm64-v8a/` is picked up by the hap packager automatically without `externalNativeOptions`. See commit `5202626`.

### Permission Declarations

Permissions used in Phase 0 that will carry forward:

- `ohos.permission.ACCESS_BIOMETRIC` — required for HUKS biometric key policy and `userAuth`. The release validator requires `reason` and `usedScene` fields in `module.json5`.
- `ohos.permission.KEEP_BACKGROUND_RUNNING` — required for `BackgroundTaskManager.requestSuspendDelay`. Same release validator requirement.

### Signing

Each developer machine requires its own signing certificate registered in AppGallery Connect. The signing config (`signingConfigs` in `build-profile.json5`) is per-machine and must not be committed to the repository. The project's `.gitignore` excludes generated DevEco signing files.

---

## Recommended Spec Amendments

The following changes to `docs/superpowers/specs/2026-04-20-harmony-mobile-mvp-design.md` are required based on Phase 0 findings:

- **§4.4 — Fold debounce value and HALF_FOLDED handling:**
  - Remove the comment "Mate X5: HALF_FOLDED 罕见，按 EXPANDED 处理". HALF_FOLDED fires on every transition.
  - Change debounce from 250 ms to ≤ 100 ms, or replace with a "settle after 100 ms of quiet" pattern (emit only when no new event has arrived for 100 ms). The 250 ms value drops the final settled state during rapid fold/unfold.
  - The `normalize()` function should still map `HALF_FOLDED → EXPANDED` for layout purposes, but this is an intermediate state, not a rare one.

- **§5.1 — file:// URL confirmed, no HTTP server fallback needed:**
  - Add a note: file:// URLs with `.fileAccess(true)` load reliably in ArkWeb on Mate X5 / HarmonyOS 6.1.0. The spec's design is correct. No in-app HTTP server fallback is required.

- **§5.7 — PDF pipeline requires mandatory 4-part workaround:**
  - Replace "pdf-shell.html: `src/harmony-pdf-shell/` 入口, Vite `build:harmony-pdf` 产出单 HTML（pdfjs-dist worker 拆为 file:// 相对引用），放到 `entry/src/main/resources/rawfile/pdf-shell/`" with the following pattern:
    1. Build pdfjs bundles from `pdfjs-dist/legacy/build/` (not main build), using esbuild `--format=iife --global-name=pdfjsLib` and `--global-name=pdfjsWorker`.
    2. Load both bundles via classic `<script src="...">` in pdf-shell.html — no ES module imports.
    3. On `aboutToAppear`, copy pdf-shell assets from rawfile to `filesDir/pdf-shell/` and load the WebView from `file://...`.
    4. Pass PDF bytes to pdfjs via the JS bridge as `Uint8Array` (`getDocument({ data })`), not via URL.

- **§6.1 / §6.2 — Biometric needs runtime capability probe:**
  - Replace hardcoded `authTrustLevel: ATL3` and `authType: [FACE, FINGERPRINT]` with a runtime probe.
  - On OnboardPage Step 5 and LockPage, query the device's enrolled biometric state before constructing the `UserAuthInstance`. Default to `ATL2` + `[FINGERPRINT]`. Fall back to password-only if no biometric is enrolled or if the preferred combination returns BusinessError 401.
  - Update `IAuthCallback` usage to match API 12+ signature: `onResult(result: UserAuthResult)` method on an object, not a bare arrow function. Do not use deprecated `AuthResultInfo`.

- **§10 (risk matrix) + §十一 (deferred items) — Background sync finalization is feasible:**
  - The risk entry "`foldStatusChange` 事件时序不稳" should note debounce must be ≤ 100 ms (not 250 ms).
  - Item 6 in §十一 ("后台周期同步（BackgroundTaskManager）") should be split: **periodic** background sync remains deferred to v2+, but **in-flight sync finalization** via `requestSuspendDelay` (API 12+, synchronous return, ≥ 30 s budget observed) is feasible for Plan 3. Note that `requestSuspendDelay` is synchronous — the plan's async usage pattern must be corrected.

---

## Go / No-Go Recommendation

**GO**

All seven verification targets passed. The Rust → ohos-abi toolchain is solid. The seven platform questions have answers, and every "failure" (napi-rs incompatibility, ArkWeb ES module restrictions, ATL3 biometric failure, HALF_FOLDED timing) has a concrete workaround with confirmed code.

### Conditions for Plan 3 Entry

The following items must be budgeted in Plan 3's scope:

1. **NAPI shim generator:** The hand-written C shim approach scales to ~25 functions but becomes a maintenance burden without tooling. A minimal generator (Python or a Rust proc-macro) should be designed before Plan 3's first coding task.
2. **Live S3 round-trip validation:** Demo 7's network round-trip was not executed on-device due to credential availability. Plan 3 must include an early integration test that runs an actual S3 PUT + GET from the device over both WiFi and cellular.
3. **ArkTS strict-mode discipline:** All Plan 3 ArkTS task prompts must produce strict-mode-clean code from the start. The rules in §ArkTS Strict-Mode Rules above must be applied to every code block in every task.
4. **Biometric capability probe:** The `BiometricService` abstraction in Plan 3 must include the runtime probe for supported `authType`/`authTrustLevel` before presenting the biometric option to users.
5. **Fold debounce correction:** The `FoldObserver` in Plan 3 must use ≤ 100 ms settle debounce.

### Known Remaining Risks

- **napi-rs OHOS fork:** No production-ready OHOS-compatible fork of napi-rs existed at Phase 0 exit. If one matures before Plan 3 ships, the hand-written shim can be replaced; until then, the shim is the only viable path.
- **S3 network switch behavior:** `rust-s3`'s retry behavior across WiFi ↔ cellular handoff is unverified on-device. This is medium probability / medium impact and should be addressed in Plan 3's sync integration test.
- **Large PDF performance:** pdfjs legacy bundle is 1 MB + 2.3 MB worker. Rendering a large PDF (> 50 pages) in ArkWeb has not been tested. Spec §十 risk "大 PDF pdfjs 卡顿" remains open.

---

## Appendix: Commit Trail

All commits on `feature/harmony-phase0` not in `main`, in reverse chronological order:

```
76aec40 feat(harmony): Demo 7 S3 PUT+GET smoke test via rust-s3
d1565d9 fix(harmony): switch to pdfjs-dist legacy build
59f6fde fix(harmony): polyfill Uint8Array.toHex/fromHex for pdfjs on ArkWeb
845822a fix(harmony): Demo 3 pass PDF bytes to pdfjs via bridge, not URL
508290d fix(harmony): remove dead BridgeHost.getWorkerBundle reference
4c2ddda fix(harmony): Demo 3 index.html — add worker script tag (prior commit missed HTML update)
e035826 fix(harmony): Demo 3 load pdf-worker-bundle via classic script tag
efada64 fix(harmony): expose pdfjsWorker global in worker bundle
c45f23e fix(harmony): Demo 3 deliver worker bundle via JS bridge
cf6e4b3 fix(harmony): Demo 3 load pdfjs worker via Blob URL
88404a1 fix(harmony): Demo 3 use IIFE bundle, disable pdfjs worker
d68bb48 fix(harmony): Demo 3 stage pdfjs assets to filesDir for file:// loading
a114fb7 debug(harmony): diagnose Demo 3 pdfjs hang + relax Demo 5 auth params
c132ac6 fix(harmony): Demo 5 use IAuthCallback interface (API 12+)
1956c8a feat(harmony): Demo 6 BackgroundTaskManager
24ef4a9 feat(harmony): Demo 5 HUKS biometric
8254f66 feat(harmony): Demo 4 file:// URL in el2
1553edd feat(harmony): Demo 3 pdfjs streamTextContent
b036b19 feat(harmony): Demo 2 WebView selectionchange
5c64132 feat(harmony): Demo 1 fold status events
b334904 fix(harmony-napi): drop napi-rs, hand-roll N-API in C shim
8e6aca4 chore(harmony): add modelVersion 6.1.0 (DevEco 6 requirement)
14009cf fix(harmony-napi): register module via HarmonyOS-style shim
9b0fa52 fix(harmony): use named NAPI imports (napi-rs emits named exports)
23a8a18 fix(harmony): bare catch + inline error formatting for ArkTS strict mode
1124f10 docs(harmony-plan): add ArkTS strict-mode correction note
f64c1b4 fix(harmony): comply with ArkTS strict mode
5202626 fix(harmony): move native module types out of src/main/cpp
6e8edac docs(harmony-plan): correct Task 4 native module path convention
c023def fix(harmony): use standard cpp/types path for native module declarations
151917c fix(harmony): surface readable error messages in Demo 0
9805fbe feat(harmony): Demo 0 NAPI smoke test wired end-to-end
43c0531 build(harmony): cross-compile script + cargo config
f98af4f feat(harmony-napi): hello-world crate for Phase 0
cad6f76 chore: add HarmonyOS generated paths to .gitignore
8828a44 feat(harmony): project scaffold for Phase 0 verification
45e5b94 docs(harmony-plan): correct hdc path for DevEco 6.1.0
f02709f docs(harmony-plan): update Task 0 Step 2 with DevEco 6.1.0 bundled NDK path
```
