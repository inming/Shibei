# HarmonyOS Phase 0 — Toolchain & Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Rust→HarmonyOS NAPI toolchain works end-to-end and validate 7 platform-specific API behaviors on a Mate X5 physical device, producing a go/no-go report that gates Phase 2+ design.

**Architecture:** A standalone HarmonyOS project `shibei-harmony/` + an independent Rust NAPI crate `src-harmony-napi/` + 7 isolated ArkTS demo pages. No production code is wired up — every artifact in this phase is disposable once the report is signed off.

**Tech Stack:** ArkTS / ArkUI (API ≥ 12), `napi-rs` v2 (with raw N-API fallback), HarmonyOS NDK (clang toolchain), DevEco Studio, Mate X5 physical device.

**Design Spec:** `docs/superpowers/specs/2026-04-20-harmony-mobile-mvp-design.md`

---

## Verification Targets

Seven real-device questions Phase 0 must answer:

1. `display.on('foldStatusChange')` trigger timing on Mate X5 (is 250ms debounce sufficient? does it fire during animation?)
2. ArkWeb `selectionchange` with touch selection handles (does event fire cleanly on drag? how frequent?)
3. PDF.js `streamTextContent()` inside ArkWeb (works? warns about readableStream?)
4. `file:///data/storage/el2/...` URLs in WebView (loadable with `fileAccess(true)`? blocked by sandbox?)
5. HUKS biometric-bound key auth timeout behaviour (default 60s prompt? reusable across app cold start?)
6. `BackgroundTaskManager` short task (suspension / resumption during long-running sync)
7. S3 upload/download across WiFi ↔ cellular network switch (does `rust-s3` tolerate this? retry behaviour?)

Each demo captures observed behaviour into the final `harmony-phase0-verification-report.md`.

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `shibei-harmony/AppScope/app.json5` | HarmonyOS app-level config |
| `shibei-harmony/AppScope/resources/base/element/string.json` | App display name |
| `shibei-harmony/build-profile.json5` | Project-level build profile |
| `shibei-harmony/hvigorfile.ts` | Build pipeline entry |
| `shibei-harmony/oh-package.json5` | Project package metadata |
| `shibei-harmony/entry/build-profile.json5` | Entry module build profile (signing + abi filter) |
| `shibei-harmony/entry/hvigorfile.ts` | Entry module build |
| `shibei-harmony/entry/oh-package.json5` | Entry package + native lib dep |
| `shibei-harmony/entry/src/main/module.json5` | Entry module manifest (permissions, abilities) |
| `shibei-harmony/entry/src/main/resources/base/element/string.json` | Entry strings |
| `shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets` | UIAbility lifecycle |
| `shibei-harmony/entry/src/main/ets/pages/Index.ets` | Demo index (buttons to each demo page) |
| `shibei-harmony/entry/src/main/ets/pages/Demo0Napi.ets` | NAPI smoke test |
| `shibei-harmony/entry/src/main/ets/pages/Demo1FoldStatus.ets` | Demo 1: fold status events |
| `shibei-harmony/entry/src/main/ets/pages/Demo2WebSelection.ets` | Demo 2: ArkWeb selectionchange |
| `shibei-harmony/entry/src/main/ets/pages/Demo3PdfJs.ets` | Demo 3: pdfjs-dist streamTextContent |
| `shibei-harmony/entry/src/main/ets/pages/Demo4FileProtocol.ets` | Demo 4: file:// URL access |
| `shibei-harmony/entry/src/main/ets/pages/Demo5Biometric.ets` | Demo 5: HUKS biometric auth |
| `shibei-harmony/entry/src/main/ets/pages/Demo6BackgroundTask.ets` | Demo 6: BackgroundTaskManager |
| `shibei-harmony/entry/src/main/ets/pages/Demo7NetworkSwitch.ets` | Demo 7: rust-s3 over network switch |
| `shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/index.html` | Static HTML for Demo 3 |
| `shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/sample.pdf` | Sample PDF (copied from desktop fixtures) |
| `shibei-harmony/entry/src/main/resources/rawfile/select-demo.html` | Static HTML with paragraphs for Demo 2 |
| `shibei-harmony/entry/types/libshibei_core/index.d.ts` | TypeScript declarations for the NAPI module |
| `src-harmony-napi/Cargo.toml` | NAPI Rust crate manifest |
| `src-harmony-napi/build.rs` | napi-build hook |
| `src-harmony-napi/src/lib.rs` | Hello-world + S3 smoke NAPI exports |
| `src-harmony-napi/.cargo/config.toml` | Target + linker config for ohos-abi |
| `scripts/build-harmony-napi.sh` | Build script: cargo → .so → copy into entry/libs |
| `docs/superpowers/reports/2026-04-20-harmony-phase0-verification-report.md` | Final report template filled in across tasks |

### Modified Files

None. Phase 0 is purely additive — no existing desktop code is touched.

---

## Task 0: Environment Prerequisites (Manual, user executes)

**Files:** none (environment setup)

- [ ] **Step 1: Install DevEco Studio**

Download DevEco Studio 5.x or later from <https://developer.huawei.com/consumer/cn/deveco-studio/>.
Install, launch, and let it auto-download HarmonyOS SDK **API level ≥ 12** (HarmonyOS NEXT compatible).

Verify by running in terminal:
```bash
ls "$HOME/Library/Huawei/Sdk" 2>/dev/null || ls "$USERPROFILE/AppData/Local/Huawei/Sdk"
# Expected: a folder named something like "HarmonyOS-NEXT-DB1"
```

- [ ] **Step 2: Set HarmonyOS NDK environment variable**

**DevEco Studio 6.x (macOS)** bundles the entire SDK inside the app package. The NDK root is:
```
/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native
```

(DevEco 5.x used `~/Library/Huawei/Sdk/HarmonyOS-NEXT-DB*/openharmony/native` — if you happen to be on the older version, use that path instead.)

Add to `~/.zshrc`:
```bash
export OHOS_NDK_HOME="/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native"
export PATH="$OHOS_NDK_HOME/llvm/bin:$PATH"
```

Verify:
```bash
source ~/.zshrc
which aarch64-unknown-linux-ohos-clang
# Expected: /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native/llvm/bin/aarch64-unknown-linux-ohos-clang
```

On DevEco 6.1.0 the binary is exactly `aarch64-unknown-linux-ohos-clang` (confirmed 2026-04-20). If a future SDK renames it, check `ls $OHOS_NDK_HOME/llvm/bin/aarch64-*` and update `.cargo/config.toml` accordingly.

- [ ] **Step 3: Install Rust ohos target**

```bash
rustup target add aarch64-unknown-linux-ohos
# Expected: already installed (via stable) OR a successful download
rustup target list --installed | grep ohos
# Expected: aarch64-unknown-linux-ohos
```

If rustup reports the target is not available for your channel, ensure you're on stable (`rustup default stable`). If still unavailable, the target is still gated — use nightly temporarily: `rustup toolchain install nightly && rustup +nightly target add aarch64-unknown-linux-ohos`.

- [ ] **Step 4: Register Huawei developer account + device**

1. Register at <https://developer.huawei.com/>.
2. In AGC (AppGallery Connect) create a new HarmonyOS app (you can use placeholder bundle ID like `com.shibei.harmony.phase0`).
3. Enable developer mode on Mate X5: Settings → 关于手机 → tap 版本号 7 times.
4. Connect Mate X5 via USB and run `hdc list targets` — should print device serial.

`hdc` binary on DevEco 6.1.0 is at `$OHOS_SDK_HOME/toolchains/hdc` where `OHOS_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony`. Add `$OHOS_SDK_HOME/toolchains` to PATH alongside the NDK llvm bin.

- [ ] **Step 5: Record environment snapshot in the report template**

Create the report skeleton (filled in later tasks):
```bash
mkdir -p docs/superpowers/reports
```
The report file is created and filled in Task 12 — for now, just verify the directory exists.

Expected: no errors.

---

## Task 1: Create HarmonyOS Project Scaffold

**Files:**
- Create: `shibei-harmony/AppScope/app.json5`
- Create: `shibei-harmony/AppScope/resources/base/element/string.json`
- Create: `shibei-harmony/build-profile.json5`
- Create: `shibei-harmony/hvigorfile.ts`
- Create: `shibei-harmony/oh-package.json5`
- Create: `shibei-harmony/entry/build-profile.json5`
- Create: `shibei-harmony/entry/hvigorfile.ts`
- Create: `shibei-harmony/entry/oh-package.json5`
- Create: `shibei-harmony/entry/src/main/module.json5`
- Create: `shibei-harmony/entry/src/main/resources/base/element/string.json`
- Create: `shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets`
- Create: `shibei-harmony/entry/src/main/ets/pages/Index.ets`

- [ ] **Step 1: Write `shibei-harmony/AppScope/app.json5`**

```json5
{
  "app": {
    "bundleName": "com.shibei.harmony.phase0",
    "vendor": "shibei",
    "versionCode": 1,
    "versionName": "0.0.1",
    "icon": "$media:app_icon",
    "label": "$string:app_name"
  }
}
```

- [ ] **Step 2: Write `shibei-harmony/AppScope/resources/base/element/string.json`**

```json
{
  "string": [
    { "name": "app_name", "value": "拾贝 Phase 0" }
  ]
}
```

Place a placeholder icon at `shibei-harmony/AppScope/resources/base/media/app_icon.png` — a 1024×1024 PNG will do; reuse `app_icon_v5.png` from repo root:
```bash
mkdir -p shibei-harmony/AppScope/resources/base/media
cp app_icon_v5.png shibei-harmony/AppScope/resources/base/media/app_icon.png
```

- [ ] **Step 3: Write `shibei-harmony/build-profile.json5`**

```json5
{
  "app": {
    "signingConfigs": [],
    "products": [
      {
        "name": "default",
        "signingConfig": "default",
        "compatibleSdkVersion": "5.0.0(12)",
        "runtimeOS": "HarmonyOS"
      }
    ]
  },
  "modules": [
    { "name": "entry", "srcPath": "./entry", "targets": [{ "name": "default", "applyToProducts": ["default"] }] }
  ]
}
```

- [ ] **Step 4: Write `shibei-harmony/hvigorfile.ts`**

```typescript
import { appTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: appTasks,
  plugins: []
};
```

- [ ] **Step 5: Write `shibei-harmony/oh-package.json5`**

```json5
{
  "name": "shibei-harmony",
  "version": "1.0.0",
  "description": "Shibei HarmonyOS Phase 0 verification",
  "main": "",
  "author": "",
  "license": "AGPL-3.0",
  "dependencies": {}
}
```

- [ ] **Step 6: Write `shibei-harmony/entry/build-profile.json5`**

```json5
{
  "apiType": "stageMode",
  "buildOption": {
    "externalNativeOptions": {
      "abiFilters": ["arm64-v8a"]
    }
  },
  "targets": [
    { "name": "default", "runtimeOS": "HarmonyOS" }
  ]
}
```

- [ ] **Step 7: Write `shibei-harmony/entry/hvigorfile.ts`**

```typescript
import { hapTasks } from '@ohos/hvigor-ohos-plugin';
export default { system: hapTasks, plugins: [] };
```

- [ ] **Step 8: Write `shibei-harmony/entry/oh-package.json5`**

```json5
{
  "name": "entry",
  "version": "1.0.0",
  "description": "Phase 0 verification entry module",
  "main": "",
  "author": "",
  "license": "AGPL-3.0",
  "dependencies": {
    "libshibei_core.so": "file:./libs/arm64-v8a/libshibei_core.so"
  }
}
```

- [ ] **Step 9: Write `shibei-harmony/entry/src/main/module.json5`**

```json5
{
  "module": {
    "name": "entry",
    "type": "entry",
    "description": "Phase 0 verification ability",
    "mainElement": "EntryAbility",
    "deviceTypes": ["phone", "tablet"],
    "deliveryWithInstall": true,
    "installationFree": false,
    "pages": "$profile:main_pages",
    "abilities": [
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        "description": "$string:entry_desc",
        "icon": "$media:entry_icon",
        "label": "$string:entry_label",
        "startWindowIcon": "$media:entry_icon",
        "startWindowBackground": "$color:start_window_background",
        "exported": true,
        "skills": [
          { "entities": ["entity.system.home"], "actions": ["action.system.home"] }
        ]
      }
    ],
    "requestPermissions": [
      { "name": "ohos.permission.INTERNET" },
      { "name": "ohos.permission.GET_NETWORK_INFO" },
      { "name": "ohos.permission.ACCESS_BIOMETRIC" },
      { "name": "ohos.permission.KEEP_BACKGROUND_RUNNING" }
    ]
  }
}
```

- [ ] **Step 10: Write `shibei-harmony/entry/src/main/resources/base/element/string.json`**

```json
{
  "string": [
    { "name": "entry_desc", "value": "Shibei Phase 0 Entry" },
    { "name": "entry_label", "value": "拾贝 Phase 0" }
  ]
}
```

Also create minimal supporting resources so DevEco Studio can compile:
```bash
mkdir -p shibei-harmony/entry/src/main/resources/base/media
mkdir -p shibei-harmony/entry/src/main/resources/base/profile
cp app_icon_v5.png shibei-harmony/entry/src/main/resources/base/media/entry_icon.png
```

Write `shibei-harmony/entry/src/main/resources/base/profile/main_pages.json`:
```json
{
  "src": [
    "pages/Index",
    "pages/Demo0Napi",
    "pages/Demo1FoldStatus",
    "pages/Demo2WebSelection",
    "pages/Demo3PdfJs",
    "pages/Demo4FileProtocol",
    "pages/Demo5Biometric",
    "pages/Demo6BackgroundTask",
    "pages/Demo7NetworkSwitch"
  ]
}
```

Write `shibei-harmony/entry/src/main/resources/base/element/color.json`:
```json
{
  "color": [
    { "name": "start_window_background", "value": "#FFFFFF" }
  ]
}
```

- [ ] **Step 11: Write `shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets`**

```typescript
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, 'shibei', 'loadContent failed: %{public}s', JSON.stringify(err));
      }
    });
  }
}
```

- [ ] **Step 12: Write `shibei-harmony/entry/src/main/ets/pages/Index.ets`**

```typescript
import { router } from '@kit.ArkUI';

@Entry
@Component
struct Index {
  private demos: Array<{ title: string; url: string }> = [
    { title: '0. NAPI smoke test', url: 'pages/Demo0Napi' },
    { title: '1. Fold status', url: 'pages/Demo1FoldStatus' },
    { title: '2. Web selection', url: 'pages/Demo2WebSelection' },
    { title: '3. pdfjs streamTextContent', url: 'pages/Demo3PdfJs' },
    { title: '4. file:// URL', url: 'pages/Demo4FileProtocol' },
    { title: '5. HUKS biometric', url: 'pages/Demo5Biometric' },
    { title: '6. Background task', url: 'pages/Demo6BackgroundTask' },
    { title: '7. S3 network switch', url: 'pages/Demo7NetworkSwitch' }
  ];

  build() {
    Column() {
      Text('拾贝 Phase 0').fontSize(24).margin({ top: 24, bottom: 16 });
      ForEach(this.demos, (d: { title: string; url: string }) => {
        Button(d.title)
          .width('90%').margin({ top: 8 })
          .onClick(() => router.pushUrl({ url: d.url }));
      }, (d: { title: string; url: string }) => d.title);
    }
    .width('100%').height('100%');
  }
}
```

- [ ] **Step 13: Open project in DevEco Studio, sync, and verify compile**

Open `shibei-harmony/` in DevEco Studio → wait for indexing → click "Sync Now" when prompted → Build → Make Module entry.
Expected: compiles with no errors (all 8 demo pages are empty placeholders at this stage — see Task 3 onward for NAPI wire-up, Tasks 5-11 for each demo's body).

If the build fails because demo pages don't yet exist, create empty placeholders now to unblock compilation:
```bash
for name in Demo0Napi Demo1FoldStatus Demo2WebSelection Demo3PdfJs Demo4FileProtocol Demo5Biometric Demo6BackgroundTask Demo7NetworkSwitch; do
  cat > "shibei-harmony/entry/src/main/ets/pages/$name.ets" <<EOF
@Entry
@Component
struct ${name} {
  build() {
    Column() { Text('${name} — placeholder'); }.width('100%').height('100%');
  }
}
EOF
done
```

- [ ] **Step 14: Run on Mate X5 and record**

Run → app launches → Index page shows 8 buttons → tap each → placeholder page opens → back → repeat.

Record in report under "Task 1":
- DevEco Studio version
- HarmonyOS SDK API level used
- Mate X5 system version
- Build time
- Any warnings

- [ ] **Step 15: Commit**

```bash
git add shibei-harmony/
git commit -m "feat(harmony): project scaffold for Phase 0 verification"
```

---

## Task 2: Create NAPI Rust Crate (Hello World)

**Files:**
- Create: `src-harmony-napi/Cargo.toml`
- Create: `src-harmony-napi/build.rs`
- Create: `src-harmony-napi/src/lib.rs`
- Create: `src-harmony-napi/.cargo/config.toml`

- [ ] **Step 1: Write `src-harmony-napi/Cargo.toml`**

```toml
[package]
name = "shibei-core"
version = "0.1.0"
edition = "2021"
license = "AGPL-3.0"

[lib]
crate-type = ["cdylib"]
name = "shibei_core"

[dependencies]
napi = { version = "2", default-features = false, features = ["napi4"] }
napi-derive = "2"

[build-dependencies]
napi-build = "2"

[profile.release]
lto = true
opt-level = "s"
codegen-units = 1
strip = true
```

- [ ] **Step 2: Write `src-harmony-napi/build.rs`**

```rust
fn main() {
    napi_build::setup();
}
```

- [ ] **Step 3: Write `src-harmony-napi/src/lib.rs`**

```rust
#![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    format!("hello from rust, os={}, arch={}", std::env::consts::OS, std::env::consts::ARCH)
}

#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

- [ ] **Step 4: Write `src-harmony-napi/.cargo/config.toml`**

```toml
[target.aarch64-unknown-linux-ohos]
linker = "aarch64-unknown-linux-ohos-clang"
ar = "llvm-ar"
rustflags = [
  "-C", "link-arg=-fuse-ld=lld",
  "-C", "link-arg=--target=aarch64-unknown-linux-ohos"
]
```

Note: the linker binary name may differ per SDK version. If Task 0 Step 2 showed a different name (e.g. `aarch64-linux-ohos-clang` without `unknown`), use that name here and throughout.

- [ ] **Step 5: Verify host build first (sanity check)**

```bash
cd src-harmony-napi
cargo build
# Expected: compiles for host target (macOS x86_64/arm64)
```

Purpose: catch Cargo.toml / src/lib.rs syntax errors without involving cross-compile complexity.

- [ ] **Step 6: Commit**

```bash
git add src-harmony-napi/
git commit -m "feat(harmony-napi): hello-world crate for Phase 0"
```

---

## Task 3: Configure ohos-abi Cross-Compile + Build Script

**Files:**
- Create: `scripts/build-harmony-napi.sh`

- [ ] **Step 1: Write `scripts/build-harmony-napi.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC2155
export SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPO_ROOT="$SCRIPT_DIR/.."

: "${OHOS_NDK_HOME:?OHOS_NDK_HOME must point to the HarmonyOS NDK root (contains llvm/ sysroot/...)}"

PROFILE="${1:-release}"
TARGET="aarch64-unknown-linux-ohos"

export PATH="$OHOS_NDK_HOME/llvm/bin:$PATH"
export CC_aarch64_unknown_linux_ohos="aarch64-unknown-linux-ohos-clang"
export CXX_aarch64_unknown_linux_ohos="aarch64-unknown-linux-ohos-clang++"
export AR_aarch64_unknown_linux_ohos="llvm-ar"

cd "$REPO_ROOT/src-harmony-napi"
if [ "$PROFILE" = "release" ]; then
  cargo build --target "$TARGET" --release
  SO="target/$TARGET/release/libshibei_core.so"
else
  cargo build --target "$TARGET"
  SO="target/$TARGET/debug/libshibei_core.so"
fi

DEST="$REPO_ROOT/shibei-harmony/entry/libs/arm64-v8a"
mkdir -p "$DEST"
cp "$SO" "$DEST/"
ls -la "$DEST/libshibei_core.so"
echo "→ copied to $DEST/libshibei_core.so"
```

Make executable:
```bash
chmod +x scripts/build-harmony-napi.sh
```

- [ ] **Step 2: Run cross-compile**

```bash
./scripts/build-harmony-napi.sh debug
```

Expected (success path):
- Rust compiles against ohos target
- Output file `target/aarch64-unknown-linux-ohos/debug/libshibei_core.so` exists
- Copied into `shibei-harmony/entry/libs/arm64-v8a/`
- Final `ls -la` prints a .so file

**Failure paths & fallbacks** (this is Phase 0 — all fallbacks must be tried before declaring go/no-go):

| Symptom | Fix |
|---|---|
| `linker 'aarch64-unknown-linux-ohos-clang' not found` | Linker binary name differs per SDK. `ls $OHOS_NDK_HOME/llvm/bin/aarch64-*` to find actual name. Update `.cargo/config.toml` + script. |
| `error: cannot find -lgcc_s` or similar libc errors | Add to rustflags: `"-C", "link-arg=--sysroot=$OHOS_NDK_HOME/sysroot"`. |
| `napi-build` errors re node_api.h missing | napi-rs v2 generates bindings from bundled node_api_headers; if it fails, pin `napi-build = "=2.1.0"`. If still broken, use raw N-API — see Step 3. |
| Linker succeeds but .so is huge (>5MB for hello world) | Expected due to napi runtime; release profile with `strip = true` should get ~500KB-1MB. OK. |
| napi-rs fundamentally incompatible with ohos | Raw N-API fallback (Step 3). |

- [ ] **Step 3: Fallback — raw N-API if napi-rs fails**

Only execute if Step 2 cannot produce a .so despite all table fixes. Replace `src-harmony-napi/src/lib.rs` with hand-written N-API:

```rust
#![deny(clippy::all)]

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};

// Minimal N-API types (a subset; full bindings come from sys crate)
type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type NapiStatus = c_int;
type NapiCallback = extern "C" fn(env: NapiEnv, info: *mut c_void) -> NapiValue;

#[link(name = "ace_napi", kind = "dylib")]
extern "C" {
    fn napi_create_string_utf8(env: NapiEnv, str: *const c_char, length: usize, result: *mut NapiValue) -> NapiStatus;
    fn napi_create_function(env: NapiEnv, utf8name: *const c_char, length: usize, cb: NapiCallback, data: *mut c_void, result: *mut NapiValue) -> NapiStatus;
    fn napi_set_named_property(env: NapiEnv, object: NapiValue, utf8name: *const c_char, value: NapiValue) -> NapiStatus;
}

extern "C" fn hello_cb(env: NapiEnv, _info: *mut c_void) -> NapiValue {
    let msg = CString::new("hello raw napi").unwrap();
    let mut result: NapiValue = std::ptr::null_mut();
    unsafe { napi_create_string_utf8(env, msg.as_ptr(), msg.as_bytes().len(), &mut result); }
    result
}

#[no_mangle]
pub extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    let mut hello_fn: NapiValue = std::ptr::null_mut();
    let name = CString::new("hello").unwrap();
    unsafe {
        napi_create_function(env, name.as_ptr(), 5, hello_cb, std::ptr::null_mut(), &mut hello_fn);
        napi_set_named_property(env, exports, name.as_ptr(), hello_fn);
    }
    exports
}
```

Update `Cargo.toml` to remove `napi` and `napi-derive` deps. This is the escape hatch — record in report that we took it.

- [ ] **Step 4: Record outcome in report**

In the report template (Task 12), fill section "Toolchain": which path worked (napi-rs stock / napi-rs with config tweaks / raw N-API), final .so size, any warnings.

- [ ] **Step 5: Update .gitignore and commit**

Add a line to `.gitignore` (the existing `target/` pattern already covers `src-harmony-napi/target/`, so only the .so output path needs ignoring):

```
shibei-harmony/entry/libs/*/libshibei_core.so
```

Then:
```bash
git add scripts/build-harmony-napi.sh .gitignore
git commit -m "build(harmony): cross-compile script + cargo config"
```

---

## Task 4: Load NAPI from ArkTS (Demo 0 — Smoke Test)

> **Correction (2026-04-20)**: the original paths below were wrong. HarmonyOS ohpm requires native module declarations to live under `entry/src/main/cpp/types/<libname>/Index.d.ts` (capital `Index`) with a matching `oh-package.json5` declaring it as a package. `entry/oh-package.json5` then points `dependencies.libshibei_core.so` at **that types folder** (not at the `.so` file). The steps below are the corrected version; refer to commit `c023def` for the concrete fix applied.

**Files:**
- Create: `shibei-harmony/entry/src/main/cpp/types/libshibei_core/Index.d.ts`
- Create: `shibei-harmony/entry/src/main/cpp/types/libshibei_core/oh-package.json5` (declares the types folder as a local ohpm package named `libshibei_core.so`)
- Modify: `shibei-harmony/entry/oh-package.json5` (dependency target → the types folder, no top-level `types` field)
- Modify: `shibei-harmony/entry/src/main/ets/pages/Demo0Napi.ets`

- [ ] **Step 1: Write type declarations `shibei-harmony/entry/types/libshibei_core/index.d.ts`**

```typescript
export const hello: () => string;
export const add: (a: number, b: number) => number;
```

- [ ] **Step 2: Register types in `shibei-harmony/entry/oh-package.json5`**

Append `types` field (if not present already):
```json5
{
  "name": "entry",
  "version": "1.0.0",
  "description": "Phase 0 verification entry module",
  "main": "",
  "author": "",
  "license": "AGPL-3.0",
  "types": "./types/libshibei_core/index.d.ts",
  "dependencies": {
    "libshibei_core.so": "file:./libs/arm64-v8a/libshibei_core.so"
  }
}
```

- [ ] **Step 3: Rewrite `shibei-harmony/entry/src/main/ets/pages/Demo0Napi.ets`**

```typescript
import { hilog } from '@kit.PerformanceAnalysisKit';
import testNapi from 'libshibei_core.so';

@Entry
@Component
struct Demo0Napi {
  @State status: string = 'pressing button will call hello() + add(3, 4)';
  @State result: string = '';

  private run(): void {
    try {
      const greet: string = testNapi.hello();
      const sum: number = testNapi.add(3, 4);
      this.result = `hello: ${greet}\nadd(3,4): ${sum}`;
      this.status = 'OK';
      hilog.info(0x0000, 'shibei', 'demo0 hello: %{public}s, sum=%{public}d', greet, sum);
    } catch (err) {
      this.status = 'ERROR';
      this.result = JSON.stringify(err);
      hilog.error(0x0000, 'shibei', 'demo0 fail: %{public}s', JSON.stringify(err));
    }
  }

  build() {
    Column() {
      Text('Demo 0: NAPI smoke test').fontSize(20).margin({ top: 24 });
      Button('run').margin({ top: 16 }).onClick(() => this.run());
      Text(this.status).margin({ top: 16 });
      Text(this.result).margin({ top: 8 }).textAlign(TextAlign.Start);
    }
    .width('100%').height('100%').padding(16);
  }
}
```

- [ ] **Step 4: Rebuild Rust + HarmonyOS**

```bash
./scripts/build-harmony-napi.sh release
```
Then in DevEco Studio: Build → Rebuild Project → Run on Mate X5.

- [ ] **Step 5: On-device verification**

1. Open app → Index → tap "0. NAPI smoke test".
2. Tap "run" button.
3. Expected:
   - Status: `OK`
   - Result: `hello: hello from rust, os=..., arch=aarch64`
   - Result: `add(3,4): 7`

Record in report under "Task 4":
- Did the .so load? (yes/no)
- Did `hello()` return a string? (yes/no; actual value)
- Did `add()` return 7? (yes/no)
- hilog output (paste from DevEco log panel)
- Time to first call (cold start)

- [ ] **Step 6: Commit**

```bash
git add shibei-harmony/entry/types shibei-harmony/entry/src/main/ets/pages/Demo0Napi.ets shibei-harmony/entry/oh-package.json5
git commit -m "feat(harmony): Demo 0 NAPI smoke test wired end-to-end"
```

---

## Task 5: Demo 1 — Fold Status Events

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Demo1FoldStatus.ets`

- [ ] **Step 1: Write `Demo1FoldStatus.ets`**

```typescript
import { display } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo1FoldStatus {
  @State current: string = '(unknown)';
  @State events: Array<string> = [];
  @State lastEventAt: number = 0;

  aboutToAppear(): void {
    try {
      const initial = display.getFoldStatus();
      this.current = this.toLabel(initial);
      display.on('foldStatusChange', (s: display.FoldStatus) => {
        const now = Date.now();
        const delta = this.lastEventAt ? now - this.lastEventAt : 0;
        this.lastEventAt = now;
        const label = this.toLabel(s);
        const entry = `${new Date(now).toISOString().substring(11, 23)} ${label} (+${delta}ms)`;
        this.events = [entry, ...this.events].slice(0, 30);
        this.current = label;
        hilog.info(0x0000, 'shibei', 'foldStatus: %{public}s delta=%{public}dms', label, delta);
      });
    } catch (err) {
      this.current = `ERROR: ${JSON.stringify(err)}`;
      hilog.error(0x0000, 'shibei', 'fold demo fail: %{public}s', JSON.stringify(err));
    }
  }

  aboutToDisappear(): void {
    display.off('foldStatusChange');
  }

  private toLabel(s: display.FoldStatus): string {
    switch (s) {
      case display.FoldStatus.FOLD_STATUS_EXPANDED: return 'EXPANDED';
      case display.FoldStatus.FOLD_STATUS_FOLDED: return 'FOLDED';
      case display.FoldStatus.FOLD_STATUS_HALF_FOLDED: return 'HALF_FOLDED';
      default: return `UNKNOWN(${s})`;
    }
  }

  build() {
    Column() {
      Text('Demo 1: Fold status').fontSize(20).margin({ top: 24 });
      Text(`current: ${this.current}`).fontSize(16).margin({ top: 16 });
      Text('fold / unfold the device and observe event log:')
        .fontSize(14).margin({ top: 16 });
      Scroll() {
        Column() {
          ForEach(this.events, (e: string) => {
            Text(e).fontSize(12).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('70%').width('100%').margin({ top: 8 });
    }
    .width('100%').height('100%').padding(16);
  }
}
```

- [ ] **Step 2: Build and run**

```bash
./scripts/build-harmony-napi.sh release
```
DevEco: Run on Mate X5.

- [ ] **Step 3: Device verification**

1. Open app → Demo 1.
2. Initial state should show `FOLDED` or `EXPANDED` depending on current form.
3. Slowly fold the device (half-way, then fully) — watch events.
4. Fully fold → fully unfold rapidly — observe if duplicate events during animation.

Record in report under "Demo 1":
- Initial value of `getFoldStatus()`
- Events observed during single slow fold: list all with deltas
- Events observed during rapid fold/unfold (animation mid-flight): how many events, minimum delta
- Does `HALF_FOLDED` ever appear on Mate X5? (spec assumes no — verify)
- **Decision input:** is 250ms debounce enough? (Yes if max event frequency ≤ 4/sec; no if higher)

- [ ] **Step 4: Commit**

```bash
git add shibei-harmony/entry/src/main/ets/pages/Demo1FoldStatus.ets
git commit -m "feat(harmony): Demo 1 fold status events"
```

---

## Task 6: Demo 2 — ArkWeb `selectionchange`

**Files:**
- Create: `shibei-harmony/entry/src/main/resources/rawfile/select-demo.html`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Demo2WebSelection.ets`

- [ ] **Step 1: Write `shibei-harmony/entry/src/main/resources/rawfile/select-demo.html`**

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px -apple-system, sans-serif; padding: 16px; line-height: 1.6; }
  p { margin-bottom: 12px; }
</style>
</head>
<body>
<h1>拾贝 选词测试</h1>
<p>这是第一段用于测试长按选词交互的中文文本。拾贝项目旨在帮助用户建立一个个人的只读资料库。</p>
<p>The second paragraph is in English for multi-language selection testing. Select any span of these words and drag the handles.</p>
<p>第三段混合 Mixed Chinese and English 在同一个句子里面，测试边界。</p>
<p>更多内容用于滚动测试。更多内容用于滚动测试。更多内容用于滚动测试。更多内容用于滚动测试。更多内容用于滚动测试。</p>
<script>
(function() {
  let lastFired = 0;
  const host = (window).shibeiHost;
  document.addEventListener('selectionchange', () => {
    const now = Date.now();
    const delta = lastFired ? now - lastFired : 0;
    lastFired = now;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      host && host.onEvent(JSON.stringify({ kind: 'empty', delta }));
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    host && host.onEvent(JSON.stringify({
      kind: 'selection',
      text: sel.toString().substring(0, 40),
      len: sel.toString().length,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      delta
    }));
  });
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Write `Demo2WebSelection.ets`**

```typescript
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo2WebSelection {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State events: Array<string> = [];
  @State count: number = 0;

  private bridge = {
    onEvent: (payload: string) => {
      this.count += 1;
      const line = `#${this.count} ${payload.substring(0, 120)}`;
      this.events = [line, ...this.events].slice(0, 50);
      hilog.info(0x0000, 'shibei', 'sel: %{public}s', payload);
    }
  };

  aboutToAppear(): void {
    // proxy registered before page load; the webview injects it on load finish
  }

  build() {
    Column() {
      Text('Demo 2: Web selectionchange').fontSize(18).margin({ top: 16 });
      Text(`total events: ${this.count}`).fontSize(14);

      Web({
        src: $rawfile('select-demo.html'),
        controller: this.controller
      })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .javaScriptProxy({
        object: this.bridge,
        name: 'shibeiHost',
        methodList: ['onEvent'],
        controller: this.controller
      })
      .height('50%')
      .onPageEnd(() => {
        hilog.info(0x0000, 'shibei', 'page loaded');
      });

      Scroll() {
        Column() {
          ForEach(this.events, (e: string) => {
            Text(e).fontSize(11).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('40%');
    }
    .width('100%').height('100%').padding(8);
  }
}
```

- [ ] **Step 3: Build and run**

Rebuild and Run.

- [ ] **Step 4: Device verification**

1. Demo 2 → wait for page to load.
2. Long-press on any paragraph → system selection handles appear.
3. Drag handles slowly — observe event stream.
4. Drag rapidly — count events per second.
5. Release → verify "empty" event when selection collapses.
6. Switch between Chinese and English paragraph selection.

Record in report:
- Does `selectionchange` fire at all? (yes/no)
- Per-drag event frequency (events/sec under rapid drag)
- Does `rect` show view-relative or document-relative coordinates?
- Mixed-language selection: any oddities?
- **Decision input:** is 250ms debounce reasonable? (yes if peak > 4/sec; otherwise use rAF-based throttle)

- [ ] **Step 5: Commit**

```bash
git add shibei-harmony/entry/src/main/resources/rawfile/select-demo.html shibei-harmony/entry/src/main/ets/pages/Demo2WebSelection.ets
git commit -m "feat(harmony): Demo 2 WebView selectionchange"
```

---

## Task 7: Demo 3 — PDF.js `streamTextContent` in ArkWeb

**Files:**
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/index.html`
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/sample.pdf`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Demo3PdfJs.ets`

- [ ] **Step 1: Copy pdfjs-dist files into rawfile**

```bash
mkdir -p shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo
# pdfjs-dist is already in desktop node_modules
cp node_modules/pdfjs-dist/build/pdf.mjs shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/
cp node_modules/pdfjs-dist/build/pdf.worker.mjs shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/
# Sample PDF — any small PDF under 1MB works; copy from desktop test fixtures if any
# If no fixture available, download a generic small PDF (user step, manual)
```

Place a small PDF at `shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/sample.pdf` (user: any short PDF, 1-3 pages).

- [ ] **Step 2: Write `shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/index.html`**

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font: 14px -apple-system, sans-serif; padding: 8px; }
  pre { max-height: 50vh; overflow: auto; background: #f0f0f0; padding: 8px; font-size: 11px; }
  canvas { width: 100%; border: 1px solid #ccc; }
</style>
</head>
<body>
<h3>pdfjs-dist Demo</h3>
<div id="status">loading…</div>
<canvas id="page"></canvas>
<h4>Extracted text (streamTextContent):</h4>
<pre id="text">—</pre>
<script type="module">
import * as pdfjs from './pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

const host = (window).shibeiHost;
function log(msg) {
  host && host.onEvent(JSON.stringify({ kind: 'log', msg }));
  console.log(msg);
}

async function run() {
  try {
    const url = './sample.pdf';
    log(`loading ${url}`);
    const task = pdfjs.getDocument(url);
    const pdf = await task.promise;
    log(`loaded, pages=${pdf.numPages}`);

    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.0 });
    const canvas = document.getElementById('page');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    log(`page 1 rendered ${viewport.width}x${viewport.height}`);

    // streamTextContent — the critical API for Shibei's plain_text extraction
    const textStream = page.streamTextContent({ includeMarkedContent: false });
    const reader = textStream.getReader();
    let pieces = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.items) {
        for (const it of value.items) {
          if (typeof it.str === 'string') pieces.push(it.str);
        }
      }
    }
    const full = pieces.join(' ');
    document.getElementById('text').textContent = full || '(empty)';
    document.getElementById('status').textContent = `extracted ${full.length} chars`;
    host && host.onEvent(JSON.stringify({ kind: 'done', chars: full.length, sample: full.substring(0, 80) }));
  } catch (err) {
    const e = String(err && err.message || err);
    document.getElementById('status').textContent = 'ERR: ' + e;
    host && host.onEvent(JSON.stringify({ kind: 'error', message: e }));
  }
}
run();
</script>
</body>
</html>
```

- [ ] **Step 3: Write `Demo3PdfJs.ets`**

```typescript
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo3PdfJs {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State log: Array<string> = [];

  private bridge = {
    onEvent: (payload: string) => {
      this.log = [payload, ...this.log].slice(0, 40);
      hilog.info(0x0000, 'shibei', 'pdfjs: %{public}s', payload);
    }
  };

  build() {
    Column() {
      Text('Demo 3: pdfjs streamTextContent').fontSize(18).margin({ top: 16 });
      Web({
        src: $rawfile('pdfjs-demo/index.html'),
        controller: this.controller
      })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(true)
      .javaScriptProxy({
        object: this.bridge,
        name: 'shibeiHost',
        methodList: ['onEvent'],
        controller: this.controller
      })
      .height('60%');

      Scroll() {
        Column() {
          ForEach(this.log, (e: string) => {
            Text(e).fontSize(10).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('35%');
    }
    .width('100%').height('100%').padding(8);
  }
}
```

- [ ] **Step 4: Build and run**

Rebuild, Run on Mate X5.

- [ ] **Step 5: Device verification**

1. Open Demo 3.
2. Expected: status shows `extracted N chars`, pre block shows extracted text, canvas shows page 1.
3. Failure modes to watch:
   - "ReadableStream is not defined" — means `streamTextContent` path unsupported in ArkWeb → fallback to `getTextContent()`
   - CSP errors — worker may need inline-script permission
   - CORS for `.pdf` via relative URL inside rawfile

Record in report:
- Did it render page 1? (yes/no + resolution)
- Did `streamTextContent` complete? (yes/no + char count)
- Any console errors (check DevEco log panel with `--level=D`)
- **Decision input:** can we use `streamTextContent` (spec assumed yes) or must we fall back?

- [ ] **Step 6: Commit**

```bash
git add shibei-harmony/entry/src/main/resources/rawfile/pdfjs-demo/ shibei-harmony/entry/src/main/ets/pages/Demo3PdfJs.ets
git commit -m "feat(harmony): Demo 3 pdfjs streamTextContent"
```

---

## Task 8: Demo 4 — `file://` URL in el2 Sandbox

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Demo4FileProtocol.ets`

- [ ] **Step 1: Write `Demo4FileProtocol.ets`**

```typescript
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import fs from '@ohos.file.fs';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo4FileProtocol {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State status: string = 'preparing…';
  @State filePath: string = '';

  aboutToAppear(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const dir = ctx.filesDir;
      const path = `${dir}/demo4.html`;
      const html = `<!DOCTYPE html><html><body>
        <h1>hello from file://</h1>
        <p>path: ${path}</p>
        <p>time: ${new Date().toISOString()}</p>
      </body></html>`;
      const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.READ_WRITE);
      fs.writeSync(file.fd, html);
      fs.closeSync(file);
      this.filePath = path;
      this.status = `wrote ${html.length} bytes → ${path}`;
      hilog.info(0x0000, 'shibei', 'demo4 wrote %{public}s', path);
    } catch (err) {
      this.status = `write fail: ${JSON.stringify(err)}`;
      hilog.error(0x0000, 'shibei', 'demo4 fail: %{public}s', JSON.stringify(err));
    }
  }

  build() {
    Column() {
      Text('Demo 4: file:// in el2').fontSize(18).margin({ top: 16 });
      Text(this.status).fontSize(12).margin({ top: 8 });
      if (this.filePath) {
        Web({
          src: `file://${this.filePath}`,
          controller: this.controller
        })
        .javaScriptAccess(true)
        .fileAccess(true)
        .domStorageAccess(true)
        .height('70%')
        .onErrorReceive((event) => {
          hilog.error(0x0000, 'shibei', 'web error: %{public}s', JSON.stringify(event.error));
        });
      }
    }
    .width('100%').height('100%').padding(8);
  }
}
```

- [ ] **Step 2: Build and run**

- [ ] **Step 3: Device verification**

1. Demo 4 → status shows "wrote N bytes → /data/storage/el2/base/haps/entry/files/demo4.html".
2. WebView should render "hello from file://" with path and timestamp.

Record in report:
- Was the file written? (yes/no)
- Did WebView load via `file://`? (yes/no)
- If blocked, error message from `onErrorReceive`
- **Decision input:** can we use direct `file://` URL (spec assumed yes) or must we fall back to an in-app HTTP server?

- [ ] **Step 4: Commit**

```bash
git add shibei-harmony/entry/src/main/ets/pages/Demo4FileProtocol.ets
git commit -m "feat(harmony): Demo 4 file:// URL in el2"
```

---

## Task 9: Demo 5 — HUKS Biometric-Bound Key

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Demo5Biometric.ets`

- [ ] **Step 1: Write `Demo5Biometric.ets`**

```typescript
import { huks } from '@kit.UniversalKeystoreKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const ALIAS = 'shibei_demo5_key';

@Entry
@Component
struct Demo5Biometric {
  @State log: Array<string> = [];

  private appendLog(s: string): void {
    this.log = [`${new Date().toISOString().substring(11, 23)} ${s}`, ...this.log].slice(0, 40);
    hilog.info(0x0000, 'shibei', 'demo5 %{public}s', s);
  }

  private async generateKey(): Promise<void> {
    try {
      const options: huks.HuksOptions = {
        properties: [
          { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
          { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
          { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
          { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
          { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
          { tag: huks.HuksTag.HUKS_TAG_USER_AUTH_TYPE, value: huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FINGERPRINT | huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FACE },
          { tag: huks.HuksTag.HUKS_TAG_KEY_AUTH_ACCESS_TYPE, value: huks.HuksAuthAccessType.HUKS_AUTH_ACCESS_INVALID_CLEAR_PASSWORD },
          { tag: huks.HuksTag.HUKS_TAG_CHALLENGE_TYPE, value: huks.HuksChallengeType.HUKS_CHALLENGE_TYPE_NORMAL }
        ]
      };
      await huks.generateKeyItem(ALIAS, options);
      this.appendLog('key generated');
    } catch (err) {
      this.appendLog(`generate error: ${JSON.stringify(err)}`);
    }
  }

  private async authAndUse(): Promise<void> {
    try {
      const t0 = Date.now();
      const auth = userAuth.getUserAuthInstance(
        { challenge: new Uint8Array(32), authType: [userAuth.UserAuthType.FACE, userAuth.UserAuthType.FINGERPRINT], authTrustLevel: userAuth.AuthTrustLevel.ATL3 },
        { title: '解锁 Demo 5 密钥' }
      );
      await new Promise<void>((resolve, reject) => {
        auth.on('result', (result) => {
          this.appendLog(`auth result: code=${result.result} token=${result.token ? 'yes' : 'no'}`);
          if (result.result === userAuth.UserAuthResultCode.SUCCESS) resolve();
          else reject(new Error(`auth failed code=${result.result}`));
        });
        auth.start();
      });
      const t1 = Date.now();
      this.appendLog(`auth ok in ${t1 - t0}ms`);
    } catch (err) {
      this.appendLog(`auth error: ${JSON.stringify(err)}`);
    }
  }

  private async deleteKey(): Promise<void> {
    try {
      await huks.deleteKeyItem(ALIAS, { properties: [] });
      this.appendLog('key deleted');
    } catch (err) {
      this.appendLog(`delete error: ${JSON.stringify(err)}`);
    }
  }

  build() {
    Column() {
      Text('Demo 5: HUKS biometric key').fontSize(18).margin({ top: 16 });
      Button('1. generate biometric-bound key').margin({ top: 8 })
        .onClick(() => this.generateKey());
      Button('2. authenticate (biometric prompt)').margin({ top: 8 })
        .onClick(() => this.authAndUse());
      Button('3. delete key').margin({ top: 8 })
        .onClick(() => this.deleteKey());
      Scroll() {
        Column() {
          ForEach(this.log, (e: string) => {
            Text(e).fontSize(11).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('60%').margin({ top: 16 });
    }
    .width('100%').height('100%').padding(16);
  }
}
```

- [ ] **Step 2: Build and run**

- [ ] **Step 3: Device verification**

1. Demo 5 → tap "generate" → expect "key generated".
2. Tap "authenticate" → system biometric prompt appears.
3. Cancel prompt → observe timeout (measure how long before auto-cancel).
4. Authenticate successfully → observe timing.
5. Repeat "authenticate" multiple times in a row → does it re-prompt each time or cache session?
6. Tap "delete" → verify no errors.
7. Kill app → cold-start → re-generate (old should be gone on `delete`).

Record in report:
- Key generation latency
- Biometric prompt default timeout (is it 60s or different?)
- Between two consecutive auth calls within 5s — does prompt show both times?
- Any error codes that indicate Mate X5 version-specific behavior
- **Decision input:** is the spec's biometric UX assumption realistic? (each session one biometric check)

- [ ] **Step 4: Commit**

```bash
git add shibei-harmony/entry/src/main/ets/pages/Demo5Biometric.ets
git commit -m "feat(harmony): Demo 5 HUKS biometric"
```

---

## Task 10: Demo 6 — BackgroundTaskManager Short Task

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Demo6BackgroundTask.ets`

- [ ] **Step 1: Write `Demo6BackgroundTask.ets`**

```typescript
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo6BackgroundTask {
  @State log: Array<string> = [];
  @State running: boolean = false;
  private tickTimer: number | null = null;

  private append(s: string): void {
    this.log = [`${new Date().toISOString().substring(11, 23)} ${s}`, ...this.log].slice(0, 60);
    hilog.info(0x0000, 'shibei', 'demo6 %{public}s', s);
  }

  private async startShortTask(): Promise<void> {
    if (this.running) return;
    try {
      await backgroundTaskManager.requestSuspendDelay('shibei sync simulation', () => {
        this.append('→ system wants us to stop (delayInfo expired)');
      });
      this.running = true;
      this.append('short task requested');

      let tick = 0;
      this.tickTimer = setInterval(() => {
        tick += 1;
        this.append(`tick ${tick} (${tick * 2}s)`);
      }, 2000);
    } catch (err) {
      this.append(`request fail: ${JSON.stringify(err)}`);
    }
  }

  private async stopShortTask(): Promise<void> {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.running = false;
    this.append('stopped');
  }

  build() {
    Column() {
      Text('Demo 6: BackgroundTaskManager').fontSize(18).margin({ top: 16 });
      Button(this.running ? 'stop' : 'start short task').margin({ top: 8 })
        .onClick(() => this.running ? this.stopShortTask() : this.startShortTask());
      Text('After "start", press home to background app; reopen; observe log.')
        .fontSize(12).margin({ top: 8 });
      Scroll() {
        Column() {
          ForEach(this.log, (e: string) => {
            Text(e).fontSize(11).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('70%').margin({ top: 16 });
    }
    .width('100%').height('100%').padding(16);
  }
}
```

- [ ] **Step 2: Build and run**

- [ ] **Step 3: Device verification**

1. Demo 6 → tap "start".
2. Keep app in foreground 10s → watch ticks every 2s (5 ticks).
3. Press home → wait 30s → reopen app.
4. Observe: did ticks continue in background? When did they pause? When did the "expired" callback fire?
5. Tap "stop" → clean up.

Record in report:
- Does the short task actually keep timers alive when backgrounded? (expected: few minutes max)
- What is the observed expiration time before the callback fires?
- **Decision input:** is spec's "only foreground-triggered sync" realistic, or can we lean on short tasks for small sync completions?

- [ ] **Step 4: Commit**

```bash
git add shibei-harmony/entry/src/main/ets/pages/Demo6BackgroundTask.ets
git commit -m "feat(harmony): Demo 6 BackgroundTaskManager"
```

---

## Task 11: Demo 7 — S3 Upload/Download Across Network Switch (via Rust)

**Files:**
- Modify: `src-harmony-napi/Cargo.toml`
- Modify: `src-harmony-napi/src/lib.rs`
- Modify: `shibei-harmony/entry/types/libshibei_core/index.d.ts`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Demo7NetworkSwitch.ets`

- [ ] **Step 1: Add rust-s3 + tokio to `src-harmony-napi/Cargo.toml`**

```toml
[package]
name = "shibei-core"
version = "0.1.0"
edition = "2021"
license = "AGPL-3.0"

[lib]
crate-type = ["cdylib"]
name = "shibei_core"

[dependencies]
napi = { version = "2", default-features = false, features = ["napi4", "tokio_rt"] }
napi-derive = "2"
tokio = { version = "1", features = ["rt-multi-thread", "time", "sync"] }
rust-s3 = { version = "0.35", default-features = false, features = ["tokio-rustls-tls"] }

[build-dependencies]
napi-build = "2"

[profile.release]
lto = true
opt-level = "s"
codegen-units = 1
strip = true
```

- [ ] **Step 2: Extend `src-harmony-napi/src/lib.rs`**

```rust
#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use s3::creds::Credentials;
use s3::{Bucket, Region};

#[napi]
pub fn hello() -> String {
    format!("hello from rust, os={}, arch={}", std::env::consts::OS, std::env::consts::ARCH)
}

#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[napi(object)]
pub struct S3TestConfig {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub path_style: bool,
}

#[napi]
pub async fn s3_put_bytes(cfg: S3TestConfig, key: String, payload: Buffer) -> Result<String> {
    let credentials = Credentials::new(Some(&cfg.access_key), Some(&cfg.secret_key), None, None, None)
        .map_err(|e| Error::from_reason(format!("creds: {e}")))?;
    let region = Region::Custom { region: cfg.region.clone(), endpoint: cfg.endpoint.clone() };
    let mut bucket = Bucket::new(&cfg.bucket, region, credentials)
        .map_err(|e| Error::from_reason(format!("bucket: {e}")))?;
    if cfg.path_style { bucket = bucket.with_path_style(); }

    let bytes: Vec<u8> = payload.into();
    let resp = bucket.put_object(&key, &bytes).await
        .map_err(|e| Error::from_reason(format!("put: {e}")))?;
    Ok(format!("put ok, status={}, bytes={}", resp.status_code(), bytes.len()))
}

#[napi]
pub async fn s3_get_bytes(cfg: S3TestConfig, key: String) -> Result<Buffer> {
    let credentials = Credentials::new(Some(&cfg.access_key), Some(&cfg.secret_key), None, None, None)
        .map_err(|e| Error::from_reason(format!("creds: {e}")))?;
    let region = Region::Custom { region: cfg.region.clone(), endpoint: cfg.endpoint.clone() };
    let mut bucket = Bucket::new(&cfg.bucket, region, credentials)
        .map_err(|e| Error::from_reason(format!("bucket: {e}")))?;
    if cfg.path_style { bucket = bucket.with_path_style(); }

    let resp = bucket.get_object(&key).await
        .map_err(|e| Error::from_reason(format!("get: {e}")))?;
    Ok(resp.bytes().to_vec().into())
}
```

- [ ] **Step 3: Extend `shibei-harmony/entry/types/libshibei_core/index.d.ts`**

```typescript
export const hello: () => string;
export const add: (a: number, b: number) => number;

export interface S3TestConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
}

export const s3PutBytes: (cfg: S3TestConfig, key: string, payload: Uint8Array) => Promise<string>;
export const s3GetBytes: (cfg: S3TestConfig, key: string) => Promise<Uint8Array>;
```

- [ ] **Step 4: Write `Demo7NetworkSwitch.ets`**

```typescript
import testNapi from 'libshibei_core.so';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo7NetworkSwitch {
  @State log: Array<string> = [];
  @State endpoint: string = 'https://s3.example.com';
  @State bucket: string = 'shibei-phase0-test';
  @State accessKey: string = '';
  @State secretKey: string = '';
  @State region: string = 'us-east-1';

  private append(s: string): void {
    this.log = [`${new Date().toISOString().substring(11, 23)} ${s}`, ...this.log].slice(0, 60);
    hilog.info(0x0000, 'shibei', 'demo7 %{public}s', s);
  }

  private async runPutThenGet(): Promise<void> {
    const cfg = {
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      pathStyle: true
    };
    const key = `phase0/probe-${Date.now()}.txt`;
    const payload = new TextEncoder().encode(`hello ${new Date().toISOString()}`);
    try {
      this.append(`PUT ${key} …`);
      const put = await testNapi.s3PutBytes(cfg, key, payload);
      this.append(`PUT ok: ${put}`);

      this.append(`GET ${key} …`);
      const bytes = await testNapi.s3GetBytes(cfg, key);
      this.append(`GET ok: ${new TextDecoder().decode(bytes)}`);
    } catch (err) {
      this.append(`ERROR: ${JSON.stringify(err)}`);
    }
  }

  build() {
    Column() {
      Text('Demo 7: S3 put/get via Rust').fontSize(18).margin({ top: 16 });
      TextInput({ placeholder: 'endpoint', text: this.endpoint })
        .onChange((v: string) => { this.endpoint = v; });
      TextInput({ placeholder: 'region', text: this.region })
        .onChange((v: string) => { this.region = v; });
      TextInput({ placeholder: 'bucket', text: this.bucket })
        .onChange((v: string) => { this.bucket = v; });
      TextInput({ placeholder: 'access key' })
        .onChange((v: string) => { this.accessKey = v; });
      TextInput({ placeholder: 'secret key' }).type(InputType.Password)
        .onChange((v: string) => { this.secretKey = v; });
      Button('PUT then GET').margin({ top: 12 })
        .onClick(() => this.runPutThenGet());
      Scroll() {
        Column() {
          ForEach(this.log, (e: string) => {
            Text(e).fontSize(11).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('40%').margin({ top: 16 });
    }
    .width('100%').height('100%').padding(16);
  }
}
```

- [ ] **Step 5: Rebuild and run**

```bash
./scripts/build-harmony-napi.sh release
```

Build in DevEco Studio. The cross-compile may now take substantially longer (tokio + rust-s3 + TLS).

- [ ] **Step 6: Device verification (test bucket required)**

**User action:** create a throwaway S3 bucket (on any provider: AWS / Aliyun OSS / MinIO). Paste credentials into the form.

1. On WiFi: tap PUT-then-GET → expect two "ok" lines.
2. Disable WiFi, switch to cellular → tap PUT-then-GET → expect success.
3. During a slow PUT, toggle WiFi off ↔ on → observe whether the request recovers or errors.
4. Turn off both WiFi and cellular → tap PUT-then-GET → expect clear error.

Record in report:
- WiFi-only success: rtt of PUT + GET
- Cellular-only success: same
- Mid-request network toggle: failure mode (connection reset / timeout / hang)
- No-network: error message
- **Decision input:** does `rust-s3` handle the real-world flakiness, or do we need retries in NAPI layer?

- [ ] **Step 7: Commit**

```bash
git add src-harmony-napi/ shibei-harmony/entry/types/libshibei_core/index.d.ts shibei-harmony/entry/src/main/ets/pages/Demo7NetworkSwitch.ets
git commit -m "feat(harmony): Demo 7 S3 put/get via rust-s3 under network switch"
```

---

## Task 12: Write Verification Report Template

**Files:**
- Create: `docs/superpowers/reports/2026-04-20-harmony-phase0-verification-report.md`

- [ ] **Step 1: Write report template**

```markdown
# HarmonyOS Phase 0 — Verification Report

- Date: 2026-04-20
- Device: Huawei Mate X5 (HarmonyOS NEXT version: ___)
- DevEco Studio: version ___
- HarmonyOS SDK API level: ___
- Rust toolchain: ___ (stable/nightly, version ___)
- NDK path: ___
- Filled in by: ___

## Toolchain (Tasks 2–4)

- Rust → ohos-abi path taken:
  - [ ] napi-rs stock
  - [ ] napi-rs with tweaks (describe: ___)
  - [ ] raw N-API fallback
- Linker binary name used: ___
- Release .so size: ___ KB
- Cold first-call latency (hello()): ___ ms
- Blockers / notes: ___

## Demo 1 — Fold Status

- Initial getFoldStatus: ___
- Single slow fold event sequence: ___
- Rapid fold events per second (worst case): ___
- HALF_FOLDED observed: yes / no
- 250ms debounce sufficient: yes / no
- Notes: ___

## Demo 2 — Web Selection

- selectionchange fires on handle drag: yes / no
- Events per second under rapid drag: ___
- Rect coordinate system (viewport / document): ___
- Mixed-language selection issues: ___
- 250ms debounce sufficient: yes / no
- Notes: ___

## Demo 3 — pdfjs streamTextContent

- page render succeeded: yes / no
- streamTextContent completed: yes / no
- Character count extracted from sample.pdf: ___
- Console errors (paste): ___
- Use streamTextContent in MVP: yes / no (if no, use getTextContent instead)
- Notes: ___

## Demo 4 — file:// URL in el2

- File written to filesDir: yes / no
- WebView loaded file:// URL: yes / no
- Errors (paste onErrorReceive): ___
- Use file:// in MVP: yes / no (if no, fall back to in-app HTTP)
- Notes: ___

## Demo 5 — HUKS Biometric

- Key generation latency: ___ ms
- Biometric prompt timeout: ___ s
- Consecutive auth (<5s apart) re-prompts: yes / no
- Mate X5 firmware version tested: ___
- MVP biometric UX assumption holds: yes / no
- Notes: ___

## Demo 6 — BackgroundTaskManager

- Foreground tick stable: yes / no
- Background continuation duration before expiration callback: ___ s
- MVP "foreground-only sync" assumption holds: yes / no
- Notes: ___

## Demo 7 — S3 Network Switch

- WiFi PUT + GET round-trip: ___ ms
- Cellular PUT + GET round-trip: ___ ms
- Mid-request network toggle failure mode: ___
- rust-s3 requires wrapper retry: yes / no
- Notes: ___

## Go / No-Go Decision

- Overall: [ GO to Phase 1 ] [ NO-GO — design revision needed ]
- Design changes required (if any): ___
- Scope cuts (if any): ___
- Next action: ___
```

- [ ] **Step 2: Fill in cross-references**

The template above has `___` placeholders for each question. Each previous task's "record in report" step dictates which fields to fill. The engineer running the plan fills values as each demo completes.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/reports/2026-04-20-harmony-phase0-verification-report.md
git commit -m "docs(harmony): Phase 0 verification report template"
```

---

## Task 13: Go / No-Go Review

**Files:** none (decision artifact)

- [ ] **Step 1: Review filled report**

With the filled-in report from Task 12, review each decision input in a focused session:

1. Toolchain succeeded (any path): proceed
2. Demo 1 debounce sufficient: proceed
3. Demo 2 selectionchange usable: proceed
4. Demo 3 streamTextContent works or getTextContent fallback works: proceed
5. Demo 4 file:// works OR decide on in-app HTTP fallback now: proceed
6. Demo 5 biometric UX matches spec: proceed
7. Demo 6: if foreground-only sync is confirmed viable, proceed; if background short task works cleanly, record as bonus for v2
8. Demo 7 rust-s3 functional: proceed

- [ ] **Step 2: Update design spec if any decisions changed**

If any demo forced a design revision (e.g. falling back to in-app HTTP instead of `file://`), edit:
`docs/superpowers/specs/2026-04-20-harmony-mobile-mvp-design.md`

Apply targeted edits to the affected sections (§5.1 for file:// fallback, §5.7 for pdfjs fallback, §6.4 for biometric changes, etc.). Commit:

```bash
git add docs/superpowers/specs/2026-04-20-harmony-mobile-mvp-design.md
git commit -m "docs(harmony): revise design based on Phase 0 findings (${area})"
```

- [ ] **Step 3: Record go/no-go in report file**

Fill the final "Go / No-Go Decision" section. Commit the updated report:

```bash
git add docs/superpowers/reports/2026-04-20-harmony-phase0-verification-report.md
git commit -m "docs(harmony): Phase 0 go/no-go decision recorded"
```

- [ ] **Step 4: Tag the Phase 0 completion**

```bash
git tag harmony-phase0
```

---

## Test Execution Summary

Unlike typical TDD plans, Phase 0 is **verification-driven**, not test-driven. The "tests" for Demos 1–7 are physical-device observations recorded in a report — they cannot be automated in this phase because they exercise platform APIs that only exist on real hardware.

The one genuinely automated test is Task 2 Step 5 (`cargo build` sanity check on host). Everything else is structured as:

1. Write code
2. Build (Rust + DevEco)
3. Run on Mate X5
4. Observe behavior against expected outcome
5. Record observations in report
6. Commit (code only — report fills incrementally)

This is appropriate because the goal is not correctness of our code (which is disposable) but **characterization of the platform's behavior**. The report is the permanent artifact, not the demos themselves.

## Phase 0 Exit Criteria

- [ ] All 7 demos compile and launch on Mate X5
- [ ] Verification report populated for every demo
- [ ] Go / No-Go decision recorded
- [ ] Any design spec revisions committed
- [ ] Tag `harmony-phase0` pushed

When these are all checked, Phase 0 is complete and Plan 2 (desktop pairing QR) or Plan 3 (Phase 2 skeleton) can begin.
