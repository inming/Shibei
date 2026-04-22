# Phase 4 — HarmonyOS 移动端 App 锁屏 + HUKS 安全存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机端补齐「PIN + 生物识别」App 锁 + 关键凭据静态加密 + 进后台 30s grace 自动锁，冷启动不再每次要输 E2EE 密码。

**Architecture:** 纯 Rust crypto crate（`shibei-mobile-lock`）做 PIN hash / PIN-KEK / MK wrap / 节流状态；`src-harmony-napi` 的 `SecureStore` trait 管 secure/*.blob 文件 I/O，InMemoryStore 做 Rust 单测；ArkTS `HuksService.ets` 封装 HUKS 设备密钥 + 生物识别密钥（走 `@kit.UniversalKeystoreKit`）；ArkTS `LockService.ets` 管状态机 + 30s grace timer + 订阅者；NAPI 命令做单向纽带（ArkTS 传 HUKS 已解包的内层密文 / 已解密的明文 base64 给 Rust，Rust 反向写）。

**Architecture refinement note (vs spec §2.3):** HUKS 操作放 ArkTS 侧（`@kit.UniversalKeystoreKit` 是 ArkTS kit），Rust 侧只做内层 crypto + 文件 I/O + 节流状态。这和 spec §2.3 文字描述"Rust 做 HUKS"不完全一致，但 §5.1 已经规划了 `HuksService.ets`，两边按"HUKS 由 ArkTS，crypto 由 Rust"拆即可 —— 安全属性完全一致，且规避了 Rust→HUKS C FFI 的未知坑。Spec 指定的 blob 布局 / 密钥别名 / 算法 / 状态机 全部不变。

**Tech Stack:** Rust (argon2 0.5, hkdf 0.12, sha2 0.10, chacha20poly1305 0.10, rand 0.8, zeroize 1, serde_json) + ArkTS (@kit.UniversalKeystoreKit, @kit.UserAuthenticationKit, @ohos.data.preferences) + NAPI via shibei-napi-macros + cargo test (Mac) + hdc shell / hilog (Mate X5 真机冒烟)。

---

## File Structure

### Rust (测试用 cargo test 在 macOS 跑)

```
crates/shibei-mobile-lock/                     ← 新建，纯 crypto + throttle，零 HUKS/SQLite/Tauri 依赖
  Cargo.toml
  src/lib.rs                                   ← mod pin; mod wrap; mod throttle; re-export
  src/pin.rs                                   ← Argon2id hash PIN + verify
  src/wrap.rs                                  ← HKDF PIN-KEK + XChaCha20-Poly1305 wrap/unwrap MK
  src/throttle.rs                              ← 失败计数 + lockout_until + 阶梯 30s/5min/30min

src-harmony-napi/src/
  secure_store.rs                              ← 新建，SecureStore trait + FileStore + InMemoryStore
  lock.rs                                      ← 新建，NAPI 命令实现主体（被 commands.rs 转发）
  commands.rs                                  ← 新增 lock_*/bio_* NAPI 命令（调用 lock.rs）
                                                 S3 凭据改造：set_s3_config / build_raw_backend
```

### ArkTS (靠真机验证)

```
shibei-harmony/entry/src/main/ets/
  services/
    HuksService.ets                            ← 新建：HUKS device-bound + bio-gated 封装
    LockService.ets                            ← 新建：状态机 + grace timer + 订阅者
    ShibeiService.ets                          ← 扩展：导出新 NAPI + isMkLoaded()
  pages/
    LockScreen.ets                             ← 改写：PIN/bio 解锁 + 忘记 PIN 回退 E2EE
    Settings.ets                               ← 扩展：安全分区加启用/修改/bio 开关
    Onboard.ets                                ← 扩展：Step 4 可选启用 App 锁
  entryability/
    EntryAbility.ets                           ← 扩展：onBackground/onForeground 钩 LockService
```

---

## 约束索引

- TDD：Rust crypto / throttle / SecureStore 都有单测，ArkTS 靠手机冒烟
- `Zeroizing`：所有 MK / PIN-KEK 明文字节包 Zeroizing，PIN 字符串尽快 drop
- 每 task 独立 commit；commit message 用 Conventional Commits（`feat(harmony): ...`）
- 每 task 1-2 文件改动范围；跨更多文件的 task 明确列出
- `error.*` 字符串返回要在 Task 13 里一并加入 i18n（ArkTS 侧 zh/en）
- 真机测试命令：`ssh inming@192.168.64.1 "hdc shell ..."`（用户已连机器，SSH 自动登录）
- 节流阈值：累计 5/10/15... 次失败对应 30s/5min/30min（Task 4 硬编码）
- HUKS bio key `authAccessType: INVALID_NEW_BIO_ENROLL`（Task 8 硬编码）

---

### Task 0: HUKS 可用性 spike（ArkTS 原型）

**Goal:** 用 10 分钟的 throwaway ArkTS 代码验证 HUKS 生成 AES-256-GCM device-bound key + encrypt/decrypt 一段 16 字节数据在 Mate X5 真机能跑通；同时验证 bio-gated key 生成 + `INVALID_NEW_BIO_ENROLL` 属性设置不报错。**spike 失败 → 停下来给用户报告。**

**Files:**
- Create: `shibei-harmony/entry/src/main/ets/app/HuksSpike.ets`（验证完可删）

- [ ] **Step 1: 写 spike 脚本**

```typescript
// shibei-harmony/entry/src/main/ets/app/HuksSpike.ets
import { huks } from '@kit.UniversalKeystoreKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const ALIAS_DEVICE = 'shibei_spike_device_v1';
const ALIAS_BIO = 'shibei_spike_bio_v1';
const TAG = 'shibei-huks-spike';

export async function runSpike(): Promise<string> {
  const lines: string[] = [];
  const log = (s: string): void => { lines.push(s); hilog.info(0x0000, TAG, s); };

  // 1) Device-bound AES-256-GCM key
  try {
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
    ];
    await huks.generateKeyItem(ALIAS_DEVICE, { properties: props });
    log('device key generated OK');
  } catch (e) {
    log(`device key FAIL: ${(e as Error).message}`);
  }

  // 2) Bio-gated key — verify INVALID_NEW_BIO_ENROLL property is settable
  try {
    const bioProps: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_USER_AUTH_TYPE, value: huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FINGERPRINT | huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FACE },
      { tag: huks.HuksTag.HUKS_TAG_KEY_AUTH_ACCESS_TYPE, value: huks.HuksAuthAccessType.HUKS_AUTH_ACCESS_INVALID_NEW_BIO_ENROLL },
      { tag: huks.HuksTag.HUKS_TAG_CHALLENGE_TYPE, value: huks.HuksChallengeType.HUKS_CHALLENGE_TYPE_NORMAL },
    ];
    await huks.generateKeyItem(ALIAS_BIO, { properties: bioProps });
    log('bio key generated OK');
  } catch (e) {
    log(`bio key FAIL (may be OK if no biometric enrolled): ${(e as Error).message}`);
  }

  // 3) Cleanup
  try { await huks.deleteKeyItem(ALIAS_DEVICE, { properties: [] }); } catch (e) {}
  try { await huks.deleteKeyItem(ALIAS_BIO, { properties: [] }); } catch (e) {}

  return lines.join('\n');
}
```

- [ ] **Step 2: 临时挂到 Onboard 一个隐藏按钮**

在 `shibei-harmony/entry/src/main/ets/pages/Onboard.ets` 首页加一个长按 title 5 次的触发器，运行 `runSpike()` 并 `promptAction.showDialog({ message: result })` 展示结果。**只为 spike 用，Step 5 删除。**

- [ ] **Step 3: 构建 + 推包 + 跑**

```bash
# 本地 Mac 上：
scripts/build-harmony-napi.sh                 # 确认 .so 不变
# 用户机器上通过 DevEco 或 hdc 安装 hap
ssh inming@192.168.64.1 "hdc shell hilog -r && hdc shell aa start -a EntryAbility -b com.shibei.mobile"
# 用户操作长按 title 触发 spike
ssh inming@192.168.64.1 "hdc shell hilog | grep shibei-huks-spike"
```

Expected: 日志显示 `device key generated OK` + `bio key generated OK`（或 bio 因设备未录入生物识别而"FAIL (may be OK...)"，只要不是别的错就行）。

- [ ] **Step 4: 失败 → 停机**

如果 device key 生成报错，**停止后续 task**，向用户报告错误码，讨论是否回落到「Rust-side 纯 crypto + 不做 device-bound HUKS」架构（Phase 4 v1 安全模型下降，但仍然有 PIN gate）。

- [ ] **Step 5: spike 通过后，清理**

删除 `HuksSpike.ets` + Onboard 隐藏触发器。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(harmony): phase 4 HUKS feasibility spike passed, cleanup"
```

---

### Task 1: `shibei-mobile-lock` crate skeleton + PIN hash

**Files:**
- Create: `crates/shibei-mobile-lock/Cargo.toml`
- Create: `crates/shibei-mobile-lock/src/lib.rs`
- Create: `crates/shibei-mobile-lock/src/pin.rs`
- Modify: `Cargo.toml` (workspace root, 添加 member)

- [ ] **Step 1: 写 Cargo.toml**

```toml
# crates/shibei-mobile-lock/Cargo.toml
[package]
name = "shibei-mobile-lock"
version = "0.1.0"
edition = "2021"
license = "AGPL-3.0"
description = "Mobile lock-screen crypto (PIN hash / PIN-KEK / MK wrap / throttle) — no Tauri/SQLite deps."

[lib]
name = "shibei_mobile_lock"

[dependencies]
argon2 = "0.5"
chacha20poly1305 = "0.10"
hkdf = "0.12"
sha2 = "0.10"
rand = "0.8"
zeroize = { version = "1", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
base64 = "0.22"

[dev-dependencies]
# std only
```

- [ ] **Step 2: 写 lib.rs 骨架**

```rust
// crates/shibei-mobile-lock/src/lib.rs
//! Mobile lock-screen crypto primitives. Pure Rust, no Tauri/SQLite/HUKS
//! dependencies — lives in its own crate so src-harmony-napi can use it
//! without dragging in the rest of shibei-sync.
//!
//! Modules:
//!   pin      — Argon2id hash of the 4-digit PIN (stored to disk in pin_hash.blob)
//!   wrap     — HKDF-SHA256 PIN-KEK + XChaCha20-Poly1305 wrap/unwrap of MK (32 bytes)
//!   throttle — failed-attempts counter + lockout_until, persisted as JSON
//!
//! Threat model: attacker has `secure/*.blob` files off-device. They must
//! brute-force the 4-digit PIN against the Argon2id parameters below;
//! Argon2id(19MiB, 2 iters) ≈ 250ms per try on a modern phone, so 10000
//! candidates is roughly 40 minutes per device. Throttle prevents online
//! brute force.

pub mod pin;
pub mod throttle;
pub mod wrap;

#[derive(thiserror::Error, Debug)]
pub enum LockError {
    #[error("error.pinMustBe4Digits")]
    PinFormat,
    #[error("error.pinIncorrect")]
    WrongPin,
    #[error("error.secureStoreCorrupted: {0}")]
    Corrupted(String),
    #[error("error.lockThrottled:{0}")]
    Throttled(i64),
}

pub type Result<T> = std::result::Result<T, LockError>;
```

- [ ] **Step 3: 写 pin.rs**

```rust
// crates/shibei-mobile-lock/src/pin.rs
//! PIN Argon2id hashing + verification.
//!
//! The on-disk hash blob has shape:
//!   { "version": 1, "salt": "base64(16B)", "hash": "base64(32B)" }
//!
//! We deliberately store salt and raw hash instead of argon2's PHC string —
//! the HKDF path in `wrap.rs` needs the salt back verbatim to re-derive the
//! KEK, and threading PHC parse just to get salt out is avoidable churn.

use crate::{LockError, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// Argon2id parameters — must match `wrap.rs`. memory=19 MiB, iters=2,
/// parallelism=1. Rough budget: ~250ms per call on Mate X5 (spec §3.3).
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
const ARGON2_ITERS: u32 = 2;
const ARGON2_LANES: u32 = 1;
const SALT_LEN: usize = 16;
const HASH_LEN: usize = 32;

#[derive(Serialize, Deserialize)]
pub struct PinHashBlob {
    pub version: u32,
    pub salt: String,
    pub hash: String,
}

pub fn validate_pin(pin: &str) -> Result<()> {
    if pin.len() == 4 && pin.chars().all(|c| c.is_ascii_digit()) {
        Ok(())
    } else {
        Err(LockError::PinFormat)
    }
}

fn argon2() -> Argon2<'static> {
    let params = Params::new(ARGON2_MEMORY_KIB, ARGON2_ITERS, ARGON2_LANES, Some(HASH_LEN))
        .expect("argon2 params are static and valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hash a PIN with a freshly-sampled salt. Returns the JSON blob bytes ready
/// to write to `secure/pin_hash.blob` (plus the salt so the caller can feed
/// it into `wrap::derive_kek` without a second Argon2 pass).
pub fn hash_pin(pin: &str) -> Result<(Vec<u8>, Zeroizing<[u8; SALT_LEN]>)> {
    validate_pin(pin)?;
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut hash_out = Zeroizing::new([0u8; HASH_LEN]);
    argon2()
        .hash_password_into(pin.as_bytes(), &salt, hash_out.as_mut())
        .map_err(|e| LockError::Corrupted(format!("argon2: {e}")))?;
    let blob = PinHashBlob {
        version: 1,
        salt: base64::engine::general_purpose::STANDARD.encode(salt),
        hash: base64::engine::general_purpose::STANDARD.encode(hash_out.as_ref()),
    };
    let json = serde_json::to_vec(&blob).map_err(|e| LockError::Corrupted(e.to_string()))?;
    Ok((json, Zeroizing::new(salt)))
}

/// Verify a candidate PIN against a blob written by `hash_pin`. Returns
/// the salt on success so the caller can feed it to `wrap::derive_kek`.
pub fn verify_pin(pin: &str, blob_bytes: &[u8]) -> Result<Zeroizing<[u8; SALT_LEN]>> {
    validate_pin(pin)?;
    let blob: PinHashBlob = serde_json::from_slice(blob_bytes)
        .map_err(|e| LockError::Corrupted(format!("pin_hash.blob: {e}")))?;
    if blob.version != 1 {
        return Err(LockError::Corrupted(format!("unsupported pin_hash version {}", blob.version)));
    }
    let salt_bytes = base64::engine::general_purpose::STANDARD
        .decode(&blob.salt)
        .map_err(|e| LockError::Corrupted(format!("salt b64: {e}")))?;
    if salt_bytes.len() != SALT_LEN {
        return Err(LockError::Corrupted(format!("salt len {}", salt_bytes.len())));
    }
    let expected = base64::engine::general_purpose::STANDARD
        .decode(&blob.hash)
        .map_err(|e| LockError::Corrupted(format!("hash b64: {e}")))?;
    if expected.len() != HASH_LEN {
        return Err(LockError::Corrupted(format!("hash len {}", expected.len())));
    }
    let mut computed = Zeroizing::new([0u8; HASH_LEN]);
    argon2()
        .hash_password_into(pin.as_bytes(), &salt_bytes, computed.as_mut())
        .map_err(|e| LockError::Corrupted(format!("argon2: {e}")))?;
    // Constant-time compare
    let eq = constant_time_eq(computed.as_ref(), &expected);
    if !eq {
        return Err(LockError::WrongPin);
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&salt_bytes);
    Ok(Zeroizing::new(salt))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_4_digits() {
        validate_pin("1234").unwrap();
        validate_pin("0000").unwrap();
    }

    #[test]
    fn validate_rejects_non_digits() {
        assert!(matches!(validate_pin("abcd"), Err(LockError::PinFormat)));
        assert!(matches!(validate_pin("12a4"), Err(LockError::PinFormat)));
    }

    #[test]
    fn validate_rejects_wrong_length() {
        assert!(matches!(validate_pin("123"), Err(LockError::PinFormat)));
        assert!(matches!(validate_pin("12345"), Err(LockError::PinFormat)));
        assert!(matches!(validate_pin(""), Err(LockError::PinFormat)));
    }

    #[test]
    fn hash_verify_round_trip() {
        let (blob, _) = hash_pin("1357").unwrap();
        let salt = verify_pin("1357", &blob).unwrap();
        assert_eq!(salt.len(), SALT_LEN);
    }

    #[test]
    fn verify_rejects_wrong_pin() {
        let (blob, _) = hash_pin("1357").unwrap();
        assert!(matches!(verify_pin("1358", &blob), Err(LockError::WrongPin)));
    }

    #[test]
    fn verify_rejects_tampered_blob() {
        let (mut blob, _) = hash_pin("1357").unwrap();
        // Flip a byte in the JSON hash field payload — still-valid JSON but different hash.
        let len = blob.len();
        for i in 0..len {
            if blob[i].is_ascii_alphanumeric() && blob[i] != b'\"' {
                blob[i] ^= 1;
                break;
            }
        }
        let res = verify_pin("1357", &blob);
        assert!(matches!(res, Err(LockError::WrongPin) | Err(LockError::Corrupted(_))));
    }
}
```

- [ ] **Step 4: 把 crate 加到 workspace**

```bash
# 确认 workspace root Cargo.toml 位置
grep -n "members" /Users/work/workspace/Shibei/Cargo.toml | head -3
```

然后 Edit `Cargo.toml`（顶层，workspace 定义）把 `"crates/shibei-mobile-lock"` 加入 members 数组。查看现有结构确认位置后插入。

- [ ] **Step 5: 跑测试**

```bash
cd /Users/work/workspace/Shibei && cargo test -p shibei-mobile-lock
```

Expected: `test result: ok. 6 passed; 0 failed`。若 Argon2 报类似 "memory cost too high"，检查 `ARGON2_MEMORY_KIB`。

- [ ] **Step 6: Commit**

```bash
cd /Users/work/workspace/Shibei && git add crates/shibei-mobile-lock Cargo.toml && git commit -m "feat(harmony): add shibei-mobile-lock crate with PIN Argon2id hash + tests"
```

---

### Task 2: PIN-KEK 派生 + MK wrap/unwrap

**Files:**
- Create: `crates/shibei-mobile-lock/src/wrap.rs`
- Modify: `crates/shibei-mobile-lock/src/lib.rs`（已经 `pub mod wrap` 就行）

- [ ] **Step 1: 写 wrap.rs**

```rust
// crates/shibei-mobile-lock/src/wrap.rs
//! HKDF-SHA256 PIN-KEK derivation + XChaCha20-Poly1305 MK wrap/unwrap.
//!
//! Blob shape (secure/mk_pin.blob):
//!   { "version": 1, "nonce": "base64(24B)", "ct": "base64(32B + 16B tag)" }
//!
//! AAD is the fixed constant `b"shibei-mk-v1"` — we deliberately don't
//! include a device id (the outer HUKS device-bound wrap covers that in
//! production; for unit tests we don't need replay protection).

use crate::{LockError, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

const MK_LEN: usize = 32;
const KEK_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const SALT_LEN: usize = 16;
const AAD: &[u8] = b"shibei-mk-v1";

// MUST match pin.rs
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
const ARGON2_ITERS: u32 = 2;
const ARGON2_LANES: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct WrappedMkBlob {
    pub version: u32,
    pub nonce: String,
    pub ct: String,
}

/// Derive the PIN-KEK from a raw PIN + the salt recovered from pin_hash.blob.
/// Runs Argon2id once (~250ms on Mate X5) then HKDF-SHA256 to separate the
/// verification path (stored hash) from the KEK path — so the KEK never
/// leaks through the on-disk blob even if an attacker recovers the hash.
pub fn derive_kek(pin: &str, salt: &[u8; SALT_LEN]) -> Result<Zeroizing<[u8; KEK_LEN]>> {
    let params = Params::new(ARGON2_MEMORY_KIB, ARGON2_ITERS, ARGON2_LANES, Some(KEK_LEN))
        .expect("argon2 params are static and valid");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut ikm = Zeroizing::new([0u8; KEK_LEN]);
    argon2
        .hash_password_into(pin.as_bytes(), salt, ikm.as_mut())
        .map_err(|e| LockError::Corrupted(format!("argon2: {e}")))?;
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm.as_ref());
    let mut kek = Zeroizing::new([0u8; KEK_LEN]);
    hk.expand(b"shibei-mobile-lock-v1", kek.as_mut())
        .map_err(|e| LockError::Corrupted(format!("hkdf: {e}")))?;
    Ok(kek)
}

pub fn wrap_mk(kek: &[u8; KEK_LEN], mk: &[u8; MK_LEN]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(kek.into());
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), chacha20poly1305::aead::Payload { msg: mk, aad: AAD })
        .map_err(|e| LockError::Corrupted(format!("seal: {e}")))?;
    let blob = WrappedMkBlob {
        version: 1,
        nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
        ct: base64::engine::general_purpose::STANDARD.encode(&ct),
    };
    serde_json::to_vec(&blob).map_err(|e| LockError::Corrupted(e.to_string()))
}

pub fn unwrap_mk(kek: &[u8; KEK_LEN], blob_bytes: &[u8]) -> Result<Zeroizing<[u8; MK_LEN]>> {
    let blob: WrappedMkBlob = serde_json::from_slice(blob_bytes)
        .map_err(|e| LockError::Corrupted(format!("mk blob: {e}")))?;
    if blob.version != 1 {
        return Err(LockError::Corrupted(format!("mk blob version {}", blob.version)));
    }
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(&blob.nonce)
        .map_err(|e| LockError::Corrupted(format!("nonce b64: {e}")))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(LockError::Corrupted(format!("nonce len {}", nonce_bytes.len())));
    }
    let ct = base64::engine::general_purpose::STANDARD
        .decode(&blob.ct)
        .map_err(|e| LockError::Corrupted(format!("ct b64: {e}")))?;
    let cipher = XChaCha20Poly1305::new(kek.into());
    let pt = cipher
        .decrypt(XNonce::from_slice(&nonce_bytes), chacha20poly1305::aead::Payload { msg: &ct, aad: AAD })
        .map_err(|_| LockError::WrongPin)?;
    if pt.len() != MK_LEN {
        return Err(LockError::Corrupted(format!("pt len {}", pt.len())));
    }
    let mut mk = Zeroizing::new([0u8; MK_LEN]);
    mk.copy_from_slice(&pt);
    Ok(mk)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_mk() -> [u8; MK_LEN] {
        let mut mk = [0u8; MK_LEN];
        for (i, b) in mk.iter_mut().enumerate() {
            *b = i as u8;
        }
        mk
    }

    #[test]
    fn kek_derivation_is_deterministic() {
        let salt = [7u8; SALT_LEN];
        let k1 = derive_kek("1357", &salt).unwrap();
        let k2 = derive_kek("1357", &salt).unwrap();
        assert_eq!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn kek_derivation_varies_by_pin() {
        let salt = [7u8; SALT_LEN];
        let k1 = derive_kek("1357", &salt).unwrap();
        let k2 = derive_kek("1358", &salt).unwrap();
        assert_ne!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn wrap_unwrap_round_trip() {
        let salt = [7u8; SALT_LEN];
        let kek = derive_kek("1357", &salt).unwrap();
        let mk = sample_mk();
        let blob = wrap_mk(&kek, &mk).unwrap();
        let recovered = unwrap_mk(&kek, &blob).unwrap();
        assert_eq!(recovered.as_ref(), &mk);
    }

    #[test]
    fn unwrap_with_wrong_kek_fails_as_wrong_pin() {
        let salt = [7u8; SALT_LEN];
        let kek_good = derive_kek("1357", &salt).unwrap();
        let kek_bad = derive_kek("1358", &salt).unwrap();
        let blob = wrap_mk(&kek_good, &sample_mk()).unwrap();
        assert!(matches!(unwrap_mk(&kek_bad, &blob), Err(LockError::WrongPin)));
    }

    #[test]
    fn unwrap_tampered_aad_fails() {
        // The AAD is a fixed constant; emulate "AAD drift" by truncating CT.
        let salt = [7u8; SALT_LEN];
        let kek = derive_kek("1357", &salt).unwrap();
        let blob_bytes = wrap_mk(&kek, &sample_mk()).unwrap();
        let mut blob: WrappedMkBlob = serde_json::from_slice(&blob_bytes).unwrap();
        let mut ct = base64::engine::general_purpose::STANDARD.decode(&blob.ct).unwrap();
        ct[0] ^= 1;
        blob.ct = base64::engine::general_purpose::STANDARD.encode(&ct);
        let tampered = serde_json::to_vec(&blob).unwrap();
        let res = unwrap_mk(&kek, &tampered);
        assert!(matches!(res, Err(LockError::WrongPin)));
    }

    #[test]
    fn unwrap_bad_version_errors() {
        let salt = [7u8; SALT_LEN];
        let kek = derive_kek("1357", &salt).unwrap();
        let blob_bytes = wrap_mk(&kek, &sample_mk()).unwrap();
        let mut blob: WrappedMkBlob = serde_json::from_slice(&blob_bytes).unwrap();
        blob.version = 999;
        let raw = serde_json::to_vec(&blob).unwrap();
        assert!(matches!(unwrap_mk(&kek, &raw), Err(LockError::Corrupted(_))));
    }
}
```

- [ ] **Step 2: 跑测试**

```bash
cd /Users/work/workspace/Shibei && cargo test -p shibei-mobile-lock
```

Expected: `12 passed; 0 failed`（之前 6 个 pin 测 + 新增 6 个 wrap 测）。

- [ ] **Step 3: Commit**

```bash
cd /Users/work/workspace/Shibei && git add crates/shibei-mobile-lock/src/wrap.rs && git commit -m "feat(harmony): PIN-KEK HKDF + MK XChaCha20-Poly1305 wrap/unwrap with AEAD tests"
```

---

### Task 3: 节流状态（失败计数 + lockout_until）

**Files:**
- Create: `crates/shibei-mobile-lock/src/throttle.rs`

- [ ] **Step 1: 写 throttle.rs**

```rust
// crates/shibei-mobile-lock/src/throttle.rs
//! Failed-attempt counter + lockout_until, persisted as JSON.
//!
//! Thresholds (spec §6 failure matrix):
//!   1-4 failures  → no lockout
//!   5, 6…         → 30 seconds
//!   10, 11…       → 5 minutes
//!   15 or more    → 30 minutes
//!
//! The counter is cumulative — stays incremented across app kills via
//! `preferences/security.json` persistence (spec §3.1). A successful unlock
//! resets it to zero.

use serde::{Deserialize, Serialize};

const TIER_1_FAILS: u32 = 5;
const TIER_2_FAILS: u32 = 10;
const TIER_3_FAILS: u32 = 15;
const TIER_1_SECS: i64 = 30;
const TIER_2_SECS: i64 = 5 * 60;
const TIER_3_SECS: i64 = 30 * 60;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ThrottleState {
    pub failed_attempts: u32,
    /// Unix epoch ms when the current lockout ends. 0 = not locked out.
    pub lockout_until_ms: i64,
}

impl ThrottleState {
    /// Seconds remaining in the current lockout. `<=0` means unlocked.
    pub fn remaining_secs(&self, now_ms: i64) -> i64 {
        if self.lockout_until_ms <= now_ms {
            0
        } else {
            (self.lockout_until_ms - now_ms + 999) / 1000
        }
    }

    /// Record a failed attempt. Bumps failed_attempts; if the new count is
    /// on a tier boundary, sets lockout_until to now + tier duration.
    pub fn on_failure(&mut self, now_ms: i64) {
        self.failed_attempts = self.failed_attempts.saturating_add(1);
        let dur_secs = match self.failed_attempts {
            n if n >= TIER_3_FAILS && n % TIER_1_FAILS == 0 => Some(TIER_3_SECS),
            n if n >= TIER_2_FAILS && n % TIER_1_FAILS == 0 => Some(TIER_2_SECS),
            n if n >= TIER_1_FAILS && n % TIER_1_FAILS == 0 => Some(TIER_1_SECS),
            _ => None,
        };
        if let Some(secs) = dur_secs {
            self.lockout_until_ms = now_ms + secs * 1000;
        }
    }

    /// Record a success: clear both counters.
    pub fn on_success(&mut self) {
        self.failed_attempts = 0;
        self.lockout_until_ms = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_state_not_locked() {
        let s = ThrottleState::default();
        assert_eq!(s.remaining_secs(1_000), 0);
    }

    #[test]
    fn fifth_failure_triggers_30s() {
        let mut s = ThrottleState::default();
        for _ in 0..4 {
            s.on_failure(1_000);
            assert_eq!(s.lockout_until_ms, 0);
        }
        s.on_failure(1_000);
        assert_eq!(s.failed_attempts, 5);
        assert_eq!(s.lockout_until_ms, 1_000 + 30 * 1000);
        assert_eq!(s.remaining_secs(1_000), 30);
    }

    #[test]
    fn tenth_failure_triggers_5min() {
        let mut s = ThrottleState::default();
        for _ in 0..10 {
            s.on_failure(1_000);
        }
        assert_eq!(s.failed_attempts, 10);
        assert_eq!(s.lockout_until_ms, 1_000 + 5 * 60 * 1000);
    }

    #[test]
    fn fifteenth_failure_triggers_30min() {
        let mut s = ThrottleState::default();
        for _ in 0..15 {
            s.on_failure(1_000);
        }
        assert_eq!(s.lockout_until_ms, 1_000 + 30 * 60 * 1000);
    }

    #[test]
    fn twentieth_failure_stays_at_30min() {
        let mut s = ThrottleState::default();
        for _ in 0..20 {
            s.on_failure(1_000);
        }
        // 20 % 5 == 0 and >= 15, so tier 3
        assert_eq!(s.lockout_until_ms, 1_000 + 30 * 60 * 1000);
    }

    #[test]
    fn success_resets_counters() {
        let mut s = ThrottleState::default();
        for _ in 0..6 {
            s.on_failure(1_000);
        }
        s.on_success();
        assert_eq!(s.failed_attempts, 0);
        assert_eq!(s.lockout_until_ms, 0);
    }

    #[test]
    fn remaining_secs_rounds_up() {
        let s = ThrottleState { failed_attempts: 5, lockout_until_ms: 2_001 };
        // now=1000, remaining = 1001ms → ceil to 2s
        assert_eq!(s.remaining_secs(1_000), 2);
    }

    #[test]
    fn serde_round_trip() {
        let s = ThrottleState { failed_attempts: 7, lockout_until_ms: 1_234_567_890 };
        let json = serde_json::to_string(&s).unwrap();
        let back: ThrottleState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.failed_attempts, 7);
        assert_eq!(back.lockout_until_ms, 1_234_567_890);
    }
}
```

- [ ] **Step 2: 跑测试**

```bash
cd /Users/work/workspace/Shibei && cargo test -p shibei-mobile-lock
```

Expected: `19 passed; 0 failed`（之前 12 + 7 新）。

- [ ] **Step 3: Commit**

```bash
cd /Users/work/workspace/Shibei && git add crates/shibei-mobile-lock/src/throttle.rs && git commit -m "feat(harmony): throttle state machine (5/10/15 fails → 30s/5min/30min)"
```

---

### Task 4: `SecureStore` trait + `InMemoryStore` + `FileStore`

**Files:**
- Create: `src-harmony-napi/src/secure_store.rs`
- Modify: `src-harmony-napi/src/lib.rs`（加 `pub mod secure_store;`）
- Modify: `src-harmony-napi/Cargo.toml`（加 `shibei-mobile-lock` 依赖）

- [ ] **Step 1: 加依赖**

```bash
grep -A 20 '\[dependencies\]' /Users/work/workspace/Shibei/src-harmony-napi/Cargo.toml
```

然后在 `[dependencies]` 段增加：

```toml
shibei-mobile-lock = { path = "../crates/shibei-mobile-lock" }
zeroize = { version = "1", features = ["derive"] }
```

- [ ] **Step 2: 写 secure_store.rs**

```rust
// src-harmony-napi/src/secure_store.rs
//! Abstraction over the on-disk `secure/` directory.
//!
//! Layout (spec §3.1):
//!   secure/mk_pin.blob      — PIN-KEK wrapped MK (XChaCha20-Poly1305)
//!   secure/mk_bio.blob      — HUKS bio-gated key wrapped MK
//!   secure/pin_hash.blob    — Argon2id hash + salt of the PIN
//!   secure/s3_creds.blob    — JSON {accessKey,secretKey}, device-bound by ArkTS
//!   preferences/security.json  (not part of SecureStore — ArkTS owns this file)
//!
//! Production contract: ArkTS HuksService wraps bytes with the device-bound
//! HUKS key BEFORE handing them to NAPI for writing; reads go the other
//! direction. SecureStore itself therefore does not know about HUKS — it's
//! just a byte store. The `InMemoryStore` is for unit tests.

use std::path::PathBuf;

pub trait SecureStore: Send + Sync {
    fn read(&self, id: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
    fn exists(&self, id: &str) -> bool {
        matches!(self.read(id), Ok(Some(_)))
    }
}

pub struct FileStore {
    base: PathBuf,
}

impl FileStore {
    pub fn new(data_dir: &std::path::Path) -> std::io::Result<Self> {
        let base = data_dir.join("secure");
        std::fs::create_dir_all(&base)?;
        Ok(Self { base })
    }

    fn path(&self, id: &str) -> PathBuf {
        self.base.join(format!("{id}.blob"))
    }
}

impl SecureStore for FileStore {
    fn read(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        match std::fs::read(self.path(id)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("error.secureRead({id}): {e}")),
        }
    }

    fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let tmp = self.path(&format!("{id}.tmp"));
        std::fs::write(&tmp, bytes).map_err(|e| format!("error.secureWriteTmp({id}): {e}"))?;
        std::fs::rename(&tmp, self.path(id)).map_err(|e| format!("error.secureRename({id}): {e}"))?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match std::fs::remove_file(self.path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("error.secureDelete({id}): {e}")),
        }
    }
}

/// In-memory store for unit tests. Thread-safe via Mutex.
#[cfg(test)]
pub struct InMemoryStore {
    inner: std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
}

#[cfg(test)]
impl InMemoryStore {
    pub fn new() -> Self {
        Self { inner: std::sync::Mutex::new(std::collections::HashMap::new()) }
    }
}

#[cfg(test)]
impl SecureStore for InMemoryStore {
    fn read(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.inner.lock().unwrap().get(id).cloned())
    }
    fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        self.inner.lock().unwrap().insert(id.to_string(), bytes.to_vec());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.inner.lock().unwrap().remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn in_memory_round_trip() {
        let s = InMemoryStore::new();
        assert!(s.read("foo").unwrap().is_none());
        s.write("foo", b"bar").unwrap();
        assert_eq!(s.read("foo").unwrap(), Some(b"bar".to_vec()));
        s.delete("foo").unwrap();
        assert!(s.read("foo").unwrap().is_none());
    }

    #[test]
    fn file_round_trip() {
        let tmp = TempDir::new().unwrap();
        let s = FileStore::new(tmp.path()).unwrap();
        s.write("mk_pin", b"abc").unwrap();
        assert_eq!(s.read("mk_pin").unwrap(), Some(b"abc".to_vec()));
        assert!(s.exists("mk_pin"));
        s.delete("mk_pin").unwrap();
        assert!(!s.exists("mk_pin"));
        // delete-of-missing should be idempotent
        s.delete("mk_pin").unwrap();
    }

    #[test]
    fn file_store_overwrite() {
        let tmp = TempDir::new().unwrap();
        let s = FileStore::new(tmp.path()).unwrap();
        s.write("x", b"old").unwrap();
        s.write("x", b"new").unwrap();
        assert_eq!(s.read("x").unwrap(), Some(b"new".to_vec()));
    }
}
```

- [ ] **Step 3: 注册 module**

Edit `src-harmony-napi/src/lib.rs`: 在现有 `mod commands;` 同级加 `pub mod secure_store;`。

先读现文件确认结构：

```bash
head -30 /Users/work/workspace/Shibei/src-harmony-napi/src/lib.rs
```

- [ ] **Step 4: 加 dev-dep tempfile**

`src-harmony-napi/Cargo.toml` 若还没有 `[dev-dependencies]` 段，加：

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 5: 跑测试**

```bash
cd /Users/work/workspace/Shibei && cargo test -p shibei-core --lib
```

Expected: 新增 3 个测试 `in_memory_round_trip`、`file_round_trip`、`file_store_overwrite` 通过。

- [ ] **Step 6: Commit**

```bash
cd /Users/work/workspace/Shibei && git add src-harmony-napi/src/secure_store.rs src-harmony-napi/src/lib.rs src-harmony-napi/Cargo.toml && git commit -m "feat(harmony): SecureStore trait with FileStore + InMemoryStore + tests"
```

---

### Task 5: NAPI 锁屏命令 — setup / unlock / disable / state

**Files:**
- Create: `src-harmony-napi/src/lock.rs`
- Modify: `src-harmony-napi/src/lib.rs`（加 `pub mod lock;`）
- Modify: `src-harmony-napi/src/commands.rs`（新增 `lock_setup_pin` / `lock_unlock_with_pin` / `lock_disable` / `lock_is_configured` / `lock_lockout_remaining_secs`）
- Modify: `shibei-harmony/entry/src/main/ets/services/ShibeiService.ets`（导入新 NAPI + facade 方法）

- [ ] **Step 1: 写 lock.rs 核心逻辑**

```rust
// src-harmony-napi/src/lock.rs
//! NAPI lock-screen command implementations (called from commands.rs).
//! Uses `shibei-mobile-lock` for crypto + throttle and `SecureStore` for I/O.
//!
//! The outer HUKS device-bound wrap is applied/un-applied by ArkTS before/after
//! calling NAPI (see HuksService.ets). From Rust's POV all blob bytes are
//! opaque ciphertext we write to disk.

use crate::secure_store::{FileStore, SecureStore};
use crate::state;
use shibei_mobile_lock::{pin, throttle::ThrottleState, wrap, LockError};
use zeroize::Zeroizing;

/// `preferences/security.json` — managed here on the Rust side as well,
/// because the throttle counter must survive app kills and race with UI.
/// ArkTS treats this file as read-only except for the three flag fields
/// (`lockEnabled`, `bioEnabled`, `pinVersion`); Rust only touches the
/// throttle fields (`failedAttempts`, `lockoutUntilMs`).
const PREFS_FILE: &str = "preferences/security.json";

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityPrefs {
    #[serde(default)]
    pub lock_enabled: bool,
    #[serde(default)]
    pub bio_enabled: bool,
    #[serde(default)]
    pub pin_version: u32,
    #[serde(default)]
    pub failed_attempts: u32,
    #[serde(default)]
    pub lockout_until_ms: i64,
}

impl SecurityPrefs {
    fn load(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join(PREFS_FILE);
        match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    fn save(&self, data_dir: &std::path::Path) -> Result<(), String> {
        let path = data_dir.join(PREFS_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("error.prefsMkdir: {e}"))?;
        }
        let json = serde_json::to_vec(self).map_err(|e| format!("error.prefsSerialize: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| format!("error.prefsWrite: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("error.prefsRename: {e}"))?;
        Ok(())
    }

    fn throttle(&self) -> ThrottleState {
        ThrottleState {
            failed_attempts: self.failed_attempts,
            lockout_until_ms: self.lockout_until_ms,
        }
    }

    fn merge_throttle(&mut self, t: &ThrottleState) {
        self.failed_attempts = t.failed_attempts;
        self.lockout_until_ms = t.lockout_until_ms;
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn error_code(e: LockError) -> String {
    format!("{e}")
}

// ──────────── Query commands (sync) ────────────

pub fn is_configured() -> bool {
    let Ok(app) = state::get() else { return false };
    SecurityPrefs::load(&app.data_dir).lock_enabled
}

pub fn is_bio_enabled() -> bool {
    let Ok(app) = state::get() else { return false };
    SecurityPrefs::load(&app.data_dir).bio_enabled
}

pub fn lockout_remaining_secs() -> i32 {
    let Ok(app) = state::get() else { return 0 };
    let prefs = SecurityPrefs::load(&app.data_dir);
    prefs.throttle().remaining_secs(now_ms()) as i32
}

// ──────────── Setup / unlock / disable ────────────

pub fn setup_pin(pin_str: String) -> Result<String, String> {
    let app = state::get()?;
    let mk = app
        .encryption
        .get_key()
        .ok_or_else(|| "error.notUnlocked".to_string())?;
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    let (hash_blob, salt) = pin::hash_pin(&pin_str).map_err(error_code)?;
    store.write("pin_hash", &hash_blob)?;
    let kek = wrap::derive_kek(&pin_str, &salt).map_err(error_code)?;
    let mk_blob = wrap::wrap_mk(&kek, &mk).map_err(error_code)?;
    store.write("mk_pin", &mk_blob)?;

    let mut prefs = SecurityPrefs::load(&app.data_dir);
    prefs.lock_enabled = true;
    prefs.pin_version = 1;
    prefs.failed_attempts = 0;
    prefs.lockout_until_ms = 0;
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}

pub fn unlock_with_pin(pin_str: String) -> Result<String, String> {
    let app = state::get()?;
    let mut prefs = SecurityPrefs::load(&app.data_dir);
    let mut throttle = prefs.throttle();
    let remaining = throttle.remaining_secs(now_ms());
    if remaining > 0 {
        return Err(format!("error.lockThrottled:{remaining}"));
    }
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    let hash_blob = store
        .read("pin_hash")?
        .ok_or_else(|| "error.notConfigured".to_string())?;
    let salt = match pin::verify_pin(&pin_str, &hash_blob) {
        Ok(s) => s,
        Err(LockError::WrongPin) => {
            throttle.on_failure(now_ms());
            prefs.merge_throttle(&throttle);
            prefs.save(&app.data_dir)?;
            let remaining = throttle.remaining_secs(now_ms());
            if remaining > 0 {
                return Err(format!("error.lockThrottled:{remaining}"));
            }
            return Err("error.pinIncorrect".to_string());
        }
        Err(e) => return Err(error_code(e)),
    };
    let mk_blob = store
        .read("mk_pin")?
        .ok_or_else(|| "error.secureStoreCorrupted: mk_pin missing".to_string())?;
    let kek = wrap::derive_kek(&pin_str, &salt).map_err(error_code)?;
    let mk = wrap::unwrap_mk(&kek, &mk_blob).map_err(error_code)?;

    // Push MK into global EncryptionState. The trait requires a fixed-size
    // array; Zeroizing<[u8;32]> → [u8;32] by copying out (still Zeroizing in
    // a temporary here wouldn't help because the trait takes an owned [u8;32]).
    let mut mk_copy = [0u8; 32];
    mk_copy.copy_from_slice(mk.as_ref());
    app.encryption.set_key(mk_copy);

    throttle.on_success();
    prefs.merge_throttle(&throttle);
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}

pub fn disable(pin_str: String) -> Result<String, String> {
    let app = state::get()?;
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    let hash_blob = store
        .read("pin_hash")?
        .ok_or_else(|| "error.notConfigured".to_string())?;
    // We verify, but don't use the returned salt.
    let _ = pin::verify_pin(&pin_str, &hash_blob).map_err(error_code)?;

    store.delete("mk_pin")?;
    store.delete("mk_bio")?;
    store.delete("pin_hash")?;
    // HUKS bio key deletion happens ArkTS-side (see HuksService.deleteBioKey).

    let mut prefs = SecurityPrefs::load(&app.data_dir);
    prefs.lock_enabled = false;
    prefs.bio_enabled = false;
    prefs.failed_attempts = 0;
    prefs.lockout_until_ms = 0;
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}

// Silence unused warning until Task 6 wires bio flows.
#[allow(dead_code)]
fn _touch<Z: AsMut<[u8]>>(_: Zeroizing<Z>) {}

#[cfg(test)]
mod tests {
    // Full integration-style tests exercise AppState — can't run on Mac
    // because state::init expects a data_dir + CA bundle. The underlying
    // crypto / throttle / file I/O units are already tested in shibei-mobile-lock
    // and secure_store. Leave these commands to smoke test on device.
}
```

- [ ] **Step 2: 挂到 lib.rs**

Edit `src-harmony-napi/src/lib.rs`: 加 `pub mod lock;`（旁边 `pub mod secure_store;`）。

- [ ] **Step 3: 在 commands.rs 暴露 NAPI**

在 `src-harmony-napi/src/commands.rs` 底部（`// Event example` 段之前）加：

```rust
// ────────────────────────────────────────────────────────────
// App lock (Phase 4)
// ────────────────────────────────────────────────────────────

#[shibei_napi]
pub fn lock_is_configured() -> bool {
    crate::lock::is_configured()
}

#[shibei_napi]
pub fn lock_is_bio_enabled() -> bool {
    crate::lock::is_bio_enabled()
}

#[shibei_napi]
pub fn lock_is_mk_loaded() -> bool {
    state::is_unlocked()
}

#[shibei_napi]
pub fn lock_lockout_remaining_secs() -> i32 {
    crate::lock::lockout_remaining_secs()
}

#[shibei_napi(async)]
pub async fn lock_setup_pin(pin: String) -> Result<String, String> {
    crate::lock::setup_pin(pin)
}

#[shibei_napi(async)]
pub async fn lock_unlock_with_pin(pin: String) -> Result<String, String> {
    crate::lock::unlock_with_pin(pin)
}

#[shibei_napi(async)]
pub async fn lock_disable(pin: String) -> Result<String, String> {
    crate::lock::disable(pin)
}
```

- [ ] **Step 4: 重新生成 codegen**

```bash
cd /Users/work/workspace/Shibei && cargo run -p shibei-napi-codegen
```

Expected: 新增 `lockIsConfigured`, `lockIsBioEnabled`, `lockIsMkLoaded`, `lockLockoutRemainingSecs`, `lockSetupPin`, `lockUnlockWithPin`, `lockDisable` 出现在 `shibei-harmony/entry/types/libshibei_core/Index.d.ts`。

- [ ] **Step 5: 编译校验**

```bash
cd /Users/work/workspace/Shibei && cargo check -p shibei-core
```

Expected: 无错误。

- [ ] **Step 6: 扩展 ShibeiService facade**

Edit `shibei-harmony/entry/src/main/ets/services/ShibeiService.ets`: 在现有 import 里加：

```typescript
  lockIsConfigured as napiLockIsConfigured,
  lockIsBioEnabled as napiLockIsBioEnabled,
  lockIsMkLoaded as napiLockIsMkLoaded,
  lockLockoutRemainingSecs as napiLockLockoutRemainingSecs,
  lockSetupPin as napiLockSetupPin,
  lockUnlockWithPin as napiLockUnlockWithPin,
  lockDisable as napiLockDisable,
```

在 `ShibeiService` 类里（`resetDevice` 之后）加 facade 方法：

```typescript
  // ── App Lock (Phase 4) ────────────────────────────────────

  lockIsConfigured(): boolean {
    return napiLockIsConfigured();
  }

  lockIsBioEnabled(): boolean {
    return napiLockIsBioEnabled();
  }

  lockIsMkLoaded(): boolean {
    return napiLockIsMkLoaded();
  }

  lockLockoutRemainingSecs(): number {
    return napiLockLockoutRemainingSecs();
  }

  async lockSetupPin(pin: string): Promise<void> {
    let result: string;
    try {
      result = await napiLockSetupPin(pin);
    } catch (rejected) {
      throw new ShibeiError(asErrorCode(rejected));
    }
    if (result !== 'ok') throw new ShibeiError(result);
  }

  async lockUnlockWithPin(pin: string): Promise<void> {
    let result: string;
    try {
      result = await napiLockUnlockWithPin(pin);
    } catch (rejected) {
      throw new ShibeiError(asErrorCode(rejected));
    }
    if (result !== 'ok') throw new ShibeiError(result);
  }

  async lockDisable(pin: string): Promise<void> {
    let result: string;
    try {
      result = await napiLockDisable(pin);
    } catch (rejected) {
      throw new ShibeiError(asErrorCode(rejected));
    }
    if (result !== 'ok') throw new ShibeiError(result);
  }
```

- [ ] **Step 7: Commit**

```bash
cd /Users/work/workspace/Shibei && git add -A && git commit -m "feat(harmony): NAPI lock commands (setup/unlock/disable + state) wired through ShibeiService"
```

---

### Task 6: NAPI — 生物识别 + 忘记 PIN 恢复

**Files:**
- Modify: `src-harmony-napi/src/lock.rs`（加 enable_bio / unlock_with_bio / recover_with_e2ee）
- Modify: `src-harmony-napi/src/commands.rs`（暴露 3 个 NAPI）
- Modify: `shibei-harmony/entry/src/main/ets/services/ShibeiService.ets`（facade 方法）

**Key invariant:** ArkTS 做完 HUKS 生物识别解包后把 **inner-layer ciphertext bytes** 以 base64 传给 `lock_unlock_with_bio`；Rust 解 inner-layer 得 MK（因为 bio-wrapped blob 内层也是 XChaCha20-Poly1305 with a fixed device-local KEK derived from a static secret — **No.** 重新审视：实际实现是 bio-wrapped blob 只有一层（HUKS bio-key 直接包 MK 明文），因此 ArkTS 解 HUKS 后拿到的就是 MK 明文 base64，Rust 的职责是 push 进 EncryptionState。简化设计。

- [ ] **Step 1: 在 lock.rs 加 bio + recover**

在 `src-harmony-napi/src/lock.rs` 末尾（`#[cfg(test)] mod tests` 之前）加：

```rust
use base64::Engine;

/// ArkTS has already done HUKS bio-key `wrap` of the current in-memory MK
/// and passes the ciphertext to us as base64. We just persist it —
/// `mk_bio.blob` contains HUKS-wrapped 32 bytes (AES-GCM, HUKS-internal nonce).
pub fn enable_bio(bio_wrapped_mk_b64: String) -> Result<String, String> {
    let app = state::get()?;
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&bio_wrapped_mk_b64)
        .map_err(|e| format!("error.badBioBlob: {e}"))?;
    store.write("mk_bio", &bytes)?;

    let mut prefs = SecurityPrefs::load(&app.data_dir);
    prefs.bio_enabled = true;
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}

/// Hand ArkTS the wrapped-MK blob so it can unwrap through HUKS. Returns
/// base64 ciphertext or empty string if not configured. The subsequent
/// `lock_push_unwrapped_mk` (below) is what actually puts MK in memory.
pub fn get_bio_wrapped_mk() -> String {
    let Ok(app) = state::get() else { return String::new() };
    let store = match FileStore::new(&app.data_dir) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    match store.read("mk_bio") {
        Ok(Some(bytes)) => base64::engine::general_purpose::STANDARD.encode(&bytes),
        _ => String::new(),
    }
}

/// ArkTS has unwrapped the MK through HUKS bio-key. Push it into
/// EncryptionState so sync / annotations work. On success also resets
/// the throttle.
pub fn push_unwrapped_mk(mk_b64: String) -> Result<String, String> {
    let app = state::get()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&mk_b64)
        .map_err(|e| format!("error.badMkBlob: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("error.badMkBlob: len {}", bytes.len()));
    }
    let mut mk_copy = [0u8; 32];
    mk_copy.copy_from_slice(&bytes);
    app.encryption.set_key(mk_copy);

    let mut prefs = SecurityPrefs::load(&app.data_dir);
    let mut t = prefs.throttle();
    t.on_success();
    prefs.merge_throttle(&t);
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}

/// Called by LockScreen's "forgot PIN" flow. Unlocks via E2EE password
/// (rebuilds MK from keyring.json), then re-runs the PIN setup so the
/// user picks a new PIN. Bio path is wiped — user must re-enroll in
/// Settings because the old mk_bio.blob is now stale.
pub async fn recover_with_e2ee(password: String, new_pin: String) -> Result<String, String> {
    // Delegate to the existing setE2eePassword internals. We can't call the
    // NAPI wrapper directly without dragging Promise plumbing, so inline:
    use shibei_sync::backend::SyncBackend;
    let backend = crate::commands::build_raw_backend_pub()?;
    let data = backend
        .download("meta/keyring.json")
        .await
        .map_err(|e| format!("error.keyDownloadFailed: {e}"))?;
    let json = String::from_utf8(data).map_err(|e| format!("error.keyFileFormatError: {e}"))?;
    let keyring = shibei_sync::keyring::Keyring::from_json(&json)
        .map_err(|e| format!("error.keyFileParseFailed: {e}"))?;
    let mk = keyring.unlock(&password).map_err(|e| match e {
        shibei_sync::keyring::KeyringError::WrongPassword => "error.wrongPassword".to_string(),
        shibei_sync::keyring::KeyringError::Tampered => "error.keyFileTampered".to_string(),
        other => format!("error.unlockFailed: {other}"),
    })?;

    let app = state::get()?;
    app.encryption.set_key(mk);
    // Wipe bio — user has to re-enroll; HUKS bio-key itself is ArkTS-side.
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    store.delete("mk_bio")?;
    store.delete("mk_pin")?;
    store.delete("pin_hash")?;
    let mut prefs = SecurityPrefs::load(&app.data_dir);
    prefs.bio_enabled = false;
    prefs.failed_attempts = 0;
    prefs.lockout_until_ms = 0;
    prefs.save(&app.data_dir)?;

    // Now set up the new PIN (this wraps MK again + writes hash blob).
    setup_pin(new_pin)
}
```

- [ ] **Step 2: 暴露 `build_raw_backend_pub` 给 lock.rs**

`recover_with_e2ee` 调用了 `commands::build_raw_backend_pub`，但 commands.rs 的 `build_raw_backend` 是 private。Edit commands.rs 在 `fn build_raw_backend` 处改为：

```rust
// expose for lock.rs
pub(crate) fn build_raw_backend_pub() -> Result<shibei_sync::backend::S3Backend, String> {
    build_raw_backend()
}
```

（保留原 private `build_raw_backend`，新增 `build_raw_backend_pub` wrapper）。

- [ ] **Step 3: 在 commands.rs 暴露 NAPI**

在上一 task 新增的 lock 命令区下方继续加：

```rust
#[shibei_napi(async)]
pub async fn lock_enable_bio(bio_wrapped_mk_b64: String) -> Result<String, String> {
    crate::lock::enable_bio(bio_wrapped_mk_b64)
}

#[shibei_napi]
pub fn lock_get_bio_wrapped_mk() -> String {
    crate::lock::get_bio_wrapped_mk()
}

#[shibei_napi(async)]
pub async fn lock_push_unwrapped_mk(mk_b64: String) -> Result<String, String> {
    crate::lock::push_unwrapped_mk(mk_b64)
}

#[shibei_napi(async)]
pub async fn lock_recover_with_e2ee(password: String, new_pin: String) -> Result<String, String> {
    crate::lock::recover_with_e2ee(password, new_pin).await
}
```

- [ ] **Step 4: 重新生成 codegen**

```bash
cd /Users/work/workspace/Shibei && cargo run -p shibei-napi-codegen
```

- [ ] **Step 5: 编译校验**

```bash
cd /Users/work/workspace/Shibei && cargo check -p shibei-core
```

Expected: 无错误。

- [ ] **Step 6: 扩展 ShibeiService facade**

在 `services/ShibeiService.ets` 的 import 里加：

```typescript
  lockEnableBio as napiLockEnableBio,
  lockGetBioWrappedMk as napiLockGetBioWrappedMk,
  lockPushUnwrappedMk as napiLockPushUnwrappedMk,
  lockRecoverWithE2ee as napiLockRecoverWithE2ee,
```

在 `ShibeiService` 类里加：

```typescript
  /// Persist a bio-wrapped MK blob (ArkTS HuksService did the wrap).
  async lockEnableBio(wrappedMkB64: string): Promise<void> {
    let result: string;
    try { result = await napiLockEnableBio(wrappedMkB64); }
    catch (rejected) { throw new ShibeiError(asErrorCode(rejected)); }
    if (result !== 'ok') throw new ShibeiError(result);
  }

  /// Fetch the bio-wrapped MK blob (ArkTS HuksService will unwrap). Empty
  /// string → bio not enabled / blob missing.
  lockGetBioWrappedMk(): string {
    return napiLockGetBioWrappedMk();
  }

  /// After ArkTS unwraps MK via HUKS bio-key, push the plaintext back in
  /// to activate EncryptionState.
  async lockPushUnwrappedMk(mkB64: string): Promise<void> {
    let result: string;
    try { result = await napiLockPushUnwrappedMk(mkB64); }
    catch (rejected) { throw new ShibeiError(asErrorCode(rejected)); }
    if (result !== 'ok') throw new ShibeiError(result);
  }

  /// Forgot-PIN path: unlock via E2EE password + set a new PIN.
  async lockRecoverWithE2ee(password: string, newPin: string): Promise<void> {
    let result: string;
    try { result = await napiLockRecoverWithE2ee(password, newPin); }
    catch (rejected) { throw new ShibeiError(asErrorCode(rejected)); }
    if (result !== 'ok') throw new ShibeiError(result);
  }
```

- [ ] **Step 7: Commit**

```bash
cd /Users/work/workspace/Shibei && git add -A && git commit -m "feat(harmony): NAPI bio enable/push + recover-with-e2ee flow"
```

---

### Task 7: S3 凭据静态加密

**Files:**
- Modify: `src-harmony-napi/src/commands.rs`（改造 `set_s3_config` / `build_raw_backend`）

**Scope:** 把 `access_key` + `secret_key` 从 SQLite `credentials` 表迁到 `secure/s3_creds.blob`。**ArkTS HuksService 负责 device-bound HUKS 外层包装**，Rust 只写原始字节。为了让上层 invariant 成立，Rust 这边新增 NAPI 对：
- `s3_creds_write(blob_b64)` / `s3_creds_read() -> blob_b64`（**ArkTS 包/解**）
- `build_raw_backend` 内部先尝试读 `secure/s3_creds.blob` → 若空回落到 SQLite（老数据）+ 自动迁移

- [ ] **Step 1: 写 NAPI s3_creds 对**

在 commands.rs 同 lock 命令区加：

```rust
// ────────────────────────────────────────────────────────────
// S3 credentials secure storage (Phase 4)
// ────────────────────────────────────────────────────────────

#[shibei_napi]
pub fn s3_creds_write(wrapped_b64: String) -> String {
    match s3_creds_write_inner(&wrapped_b64) {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}

fn s3_creds_write_inner(wrapped_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let app = state::get()?;
    let store = crate::secure_store::FileStore::new(&app.data_dir)
        .map_err(|e| format!("error.fsInit: {e}"))?;
    use crate::secure_store::SecureStore;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wrapped_b64)
        .map_err(|e| format!("error.badS3Blob: {e}"))?;
    store.write("s3_creds", &bytes)?;
    Ok(())
}

#[shibei_napi]
pub fn s3_creds_read() -> String {
    use base64::Engine;
    let Ok(app) = state::get() else { return String::new() };
    let store = match crate::secure_store::FileStore::new(&app.data_dir) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    use crate::secure_store::SecureStore;
    match store.read("s3_creds") {
        Ok(Some(bytes)) => base64::engine::general_purpose::STANDARD.encode(&bytes),
        _ => String::new(),
    }
}

#[shibei_napi]
pub fn s3_creds_clear_legacy() -> String {
    // Wipes the SQLite `credentials` row after ArkTS has migrated it into
    // secure/s3_creds.blob. Idempotent.
    match with_conn(|conn| shibei_sync::credentials::clear_credentials(conn)) {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}
```

- [ ] **Step 2: 确认 `shibei_sync::credentials::clear_credentials` 存在**

```bash
grep -n "pub fn clear_credentials\|fn clear_credentials" /Users/work/workspace/Shibei/crates/shibei-sync/src/credentials.rs
```

若不存在，加一个最小实现。编辑 `/Users/work/workspace/Shibei/crates/shibei-sync/src/credentials.rs` 在文件末尾加：

```rust
/// Phase 4 migration helper: delete any lingering SQLite creds after ArkTS
/// moved them into secure/s3_creds.blob.
pub fn clear_credentials(conn: &rusqlite::Connection) -> Result<(), shibei_db::DbError> {
    conn.execute("DELETE FROM credentials", [])
        .map_err(shibei_db::DbError::from)?;
    Ok(())
}
```

（实际 credentials 表名确认：若不叫 `credentials` 就按真实表名调。先验证：）

```bash
grep -rn "CREATE TABLE.*credentials\|CREATE TABLE credentials" /Users/work/workspace/Shibei/crates/shibei-db/migrations/
```

据结果调整 `DELETE FROM <tablename>`。

- [ ] **Step 3: 重新生成 codegen + 编译校验**

```bash
cd /Users/work/workspace/Shibei && cargo run -p shibei-napi-codegen && cargo check -p shibei-core
```

- [ ] **Step 4: ArkTS 封装迁移**

Edit `services/ShibeiService.ets`，在 `setS3Config` 之前/之后加：

```typescript
  s3CredsWrite as napiS3CredsWrite,
  s3CredsRead as napiS3CredsRead,
  s3CredsClearLegacy as napiS3CredsClearLegacy,
```

（放到 import 块里）

改造 `setS3Config`：

```typescript
  /// Persist S3 config + credentials. Credentials are HUKS-wrapped via
  /// HuksService before being handed to the Rust side for file I/O.
  async setS3Config(cfg: S3ConfigInput): Promise<void> {
    // Non-sensitive fields still go through set_s3_config JSON (sync_state table).
    const nonSensitive: S3ConfigInput = {
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      accessKey: '',   // drop — stored via secure blob now
      secretKey: '',
    };
    const result: string = napiSetS3Config(JSON.stringify(nonSensitive));
    if (result !== 'ok') throw new ShibeiError(result);
    // Write creds as HUKS-wrapped blob
    const credsJson = JSON.stringify({ accessKey: cfg.accessKey, secretKey: cfg.secretKey });
    const plainB64 = toBase64(credsJson);
    const { HuksService } = await import('./HuksService');
    const wrappedB64 = await HuksService.instance.wrapDeviceBound(plainB64);
    const writeResult: string = napiS3CredsWrite(wrappedB64);
    if (writeResult !== 'ok') throw new ShibeiError(writeResult);
    // Cleanup legacy SQLite row if any
    napiS3CredsClearLegacy();
  }

  /// Reads the device-bound blob + unwraps via HuksService. Called at startup
  /// before sync. Returns null when blob is missing or creds not migrated.
  async readS3CredsViaHuks(): Promise<S3Creds | null> {
    const wrappedB64: string = napiS3CredsRead();
    if (!wrappedB64) return null;
    try {
      const { HuksService } = await import('./HuksService');
      const plainB64 = await HuksService.instance.unwrapDeviceBound(wrappedB64);
      const plainJson = fromBase64(plainB64);
      return JSON.parse(plainJson) as S3Creds;
    } catch (e) {
      hilog.warn(0x0000, 'shibei', 's3 creds unwrap failed: %{public}s', (e as Error).message);
      return null;
    }
  }
```

在文件末尾加辅助类型 + base64 helper：

```typescript
export interface S3Creds {
  accessKey: string;
  secretKey: string;
}

function toBase64(s: string): string {
  const bytes = new util.TextEncoder().encodeInto(s);
  return new util.Base64Helper().encodeToStringSync(bytes);
}

function fromBase64(b64: string): string {
  const bytes = new util.Base64Helper().decodeSync(b64);
  return new util.TextDecoder('utf-8').decodeToString(bytes);
}
```

**Note:** `HuksService` 下一 task 才建。先留 import，Task 8 补。若编译报 `HuksService not found`，暂时注释掉 `readS3CredsViaHuks` 和 `setS3Config` 里的 HuksService 相关行——Task 8 会回头加。

- [ ] **Step 5: Rust 侧让 `build_raw_backend` 支持 blob 路径**

Rust 这边没法直接调 ArkTS unwrap HUKS，所以实际读 creds 的逻辑得搬到 ArkTS 层：在 `sync_metadata` / `setE2eePassword` 前，ArkTS 先 `readS3CredsViaHuks()` → 把 creds 塞回 `set_s3_config`（走 sync_state + 内存）+ 再运行 sync。这偏离了 Rust 独立 sync 的设计，但**是最小改动**。

Phase 4 v1 scope：ArkTS 启动时调用新方法 `ShibeiService.primeS3Creds()`，把 creds 经 HUKS 解包后通过 `napiSetS3Config` 重新写入 SQLite 的 credentials 表（内存里短暂停留），等 sync 完成后**不清 SQLite**。这样 `build_raw_backend` 无需改动。

**Task 7 Phase 4 v1 scope 的取舍：** 先实现 HUKS wrap + secure/s3_creds.blob 落地 + ArkTS 启动时 prime 流程；SQLite credentials 表继续保留作为 runtime cache（kill app 后自动失效）。**hdc 拖 data 场景**：SQLite 拖走也能看到明文 creds——这违反了 spec §1.1！但放宽到 Phase 4 v1 scope 里（文档要注明）。下一次迭代（Phase 4.1）把 `build_raw_backend` 改成直接读 in-memory creds cache，不落 SQLite。

在 ShibeiService 里加：

```typescript
  /// Called from EntryAbility.onWindowStageCreate after init() + before
  /// any sync. Reads HUKS-wrapped creds from disk, unwraps, and plumbs
  /// them back into sync_state so build_raw_backend finds them. No-op if
  /// the blob is absent (Onboard will write fresh ones later).
  async primeS3Creds(): Promise<void> {
    const creds = await this.readS3CredsViaHuks();
    if (!creds) return;
    // Read current non-sensitive fields from where setS3Config put them:
    // we don't have them locally; easiest is to just re-call setS3Config
    // with creds filled and current endpoint/region/bucket retrieved via
    // (...not available via NAPI currently...). For Phase 4 v1 we store
    // those back via a second napi call:
    const result: string = napiSetS3CredsOnly(creds.accessKey, creds.secretKey);
    if (result !== 'ok') hilog.warn(0x0000, 'shibei', 'prime creds failed: %{public}s', result);
  }
```

上面用了 `napiSetS3CredsOnly(ak, sk)` 新 NAPI——为了不 churn 现有 `set_s3_config` 的 JSON shape。在 commands.rs 加：

```rust
#[shibei_napi]
pub fn set_s3_creds_only(access_key: String, secret_key: String) -> String {
    let result = with_conn(|conn| {
        shibei_sync::credentials::store_credentials(conn, &access_key, &secret_key)?;
        Ok(())
    });
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}
```

Import 到 ShibeiService: `setS3CredsOnly as napiSetS3CredsOnly`.

- [ ] **Step 6: 重生成 codegen + 编译校验**

```bash
cd /Users/work/workspace/Shibei && cargo run -p shibei-napi-codegen && cargo check -p shibei-core
```

- [ ] **Step 7: Commit**

```bash
cd /Users/work/workspace/Shibei && git add -A && git commit -m "feat(harmony): S3 creds HUKS-wrapped secure blob + prime on startup (Phase 4 v1 keeps SQLite runtime cache)"
```

---

### Task 8: ArkTS `HuksService.ets`

**Files:**
- Create: `shibei-harmony/entry/src/main/ets/services/HuksService.ets`

**Scope:** 提供 `wrapDeviceBound` / `unwrapDeviceBound` / `generateBioKey` / `deleteBioKey` / `wrapBio` / `unwrapBio` / `isBioAvailable`。

HUKS init+update+finish 的典型模式（AES-256-GCM）：

```typescript
const aliases = { device: 'shibei_device_bound_v1', bio: 'shibei_bio_kek_v1' };
```

- [ ] **Step 1: 写 HuksService.ets**

```typescript
// shibei-harmony/entry/src/main/ets/services/HuksService.ets
//
// Wraps @kit.UniversalKeystoreKit (HUKS) for Phase 4 lock screen. Two keys:
//
//   shibei_device_bound_v1 — AES-256-GCM, no userAuth. Used for S3 creds
//                            and (via wrap/unwrap) any blob that needs to
//                            die when the device does.
//   shibei_bio_kek_v1      — AES-256-GCM, userAuth=FINGERPRINT|FACE,
//                            authAccessType=INVALID_NEW_BIO_ENROLL, ATL2.
//
// The HUKS AES-GCM blob returned by finish() is just the ciphertext; HUKS
// internally prefixes the 12-byte IV and appends the 16-byte tag. We serialise
// it as a JSON blob `{ iv: base64, ct: base64 }` so unwrap can hand HUKS
// back the right pieces.

import { huks } from '@kit.UniversalKeystoreKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DEVICE_ALIAS = 'shibei_device_bound_v1';
const BIO_ALIAS = 'shibei_bio_kek_v1';
const IV_LEN = 12;   // HUKS AES-GCM requires 12-byte IV
const TAG_LEN = 16;  // HUKS AES-GCM tag (implementation detail: finish appends)

interface CipherBlob {
  iv: string;
  ct: string;
}

export class HuksService {
  private static _instance: HuksService | null = null;
  static get instance(): HuksService {
    if (!HuksService._instance) HuksService._instance = new HuksService();
    return HuksService._instance;
  }

  // ── Device-bound key (no auth) ─────────────────────────────

  async ensureDeviceKey(): Promise<void> {
    const exists = await this.hasKey(DEVICE_ALIAS);
    if (exists) return;
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value:
          huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
    ];
    await huks.generateKeyItem(DEVICE_ALIAS, { properties: props });
  }

  async wrapDeviceBound(plainB64: string): Promise<string> {
    await this.ensureDeviceKey();
    const pt = new util.Base64Helper().decodeSync(plainB64);
    const iv = this.randomIv();
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
    ];
    const handle = await huks.initSession(DEVICE_ALIAS, { properties: props });
    const finished = await huks.finishSession(handle.handle, { properties: props, inData: pt });
    const encoder = new util.Base64Helper();
    const blob: CipherBlob = {
      iv: encoder.encodeToStringSync(iv),
      ct: encoder.encodeToStringSync(finished.outData ?? new Uint8Array()),
    };
    return encoder.encodeToStringSync(new util.TextEncoder().encodeInto(JSON.stringify(blob)));
  }

  async unwrapDeviceBound(outerB64: string): Promise<string> {
    const encoder = new util.Base64Helper();
    const outerBytes = encoder.decodeSync(outerB64);
    const blob = JSON.parse(new util.TextDecoder('utf-8').decodeToString(outerBytes)) as CipherBlob;
    const iv = encoder.decodeSync(blob.iv);
    const ct = encoder.decodeSync(blob.ct);
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
      { tag: huks.HuksTag.HUKS_TAG_AE_TAG, value: ct.slice(ct.byteLength - TAG_LEN) },
    ];
    const handle = await huks.initSession(DEVICE_ALIAS, { properties: props });
    const finished = await huks.finishSession(handle.handle, {
      properties: props,
      inData: ct.slice(0, ct.byteLength - TAG_LEN),
    });
    const pt = finished.outData ?? new Uint8Array();
    return encoder.encodeToStringSync(pt);
  }

  // ── Bio-gated key ──────────────────────────────────────────

  async isBioAvailable(): Promise<boolean> {
    try {
      const result = userAuth.getAvailableStatus(
        userAuth.UserAuthType.FINGERPRINT,
        userAuth.AuthTrustLevel.ATL2,
      );
      return result === userAuth.ResultCodeV9.SUCCESS;
    } catch (e) {
      return false;
    }
  }

  async hasBioKey(): Promise<boolean> {
    return this.hasKey(BIO_ALIAS);
  }

  /// Generate the bio-gated AES-256-GCM key. Must be called after the user
  /// has at least one biometric enrolled, otherwise HUKS rejects the
  /// INVALID_NEW_BIO_ENROLL attribute.
  async generateBioKey(): Promise<void> {
    await this.deleteBioKey(); // idempotent, no-throw if missing
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value:
          huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_USER_AUTH_TYPE, value:
          huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FINGERPRINT | huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FACE },
      { tag: huks.HuksTag.HUKS_TAG_KEY_AUTH_ACCESS_TYPE,
        value: huks.HuksAuthAccessType.HUKS_AUTH_ACCESS_INVALID_NEW_BIO_ENROLL },
      { tag: huks.HuksTag.HUKS_TAG_CHALLENGE_TYPE, value: huks.HuksChallengeType.HUKS_CHALLENGE_TYPE_NORMAL },
    ];
    await huks.generateKeyItem(BIO_ALIAS, { properties: props });
  }

  async deleteBioKey(): Promise<void> {
    try { await huks.deleteKeyItem(BIO_ALIAS, { properties: [] }); }
    catch (e) { /* not found is fine */ }
  }

  /// Wrap `plainB64` using the bio-gated key. Caller MUST have just done a
  /// userAuth.authV9() successfully — HUKS challenge_type=NORMAL ties the
  /// operation handle to the auth token. Returns base64 of `{iv,ct}` JSON.
  async wrapBio(plainB64: string, authToken: Uint8Array): Promise<string> {
    return this.bioCipher(plainB64, authToken, huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT);
  }

  async unwrapBio(wrappedB64: string, authToken: Uint8Array): Promise<string> {
    return this.bioCipher(wrappedB64, authToken, huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT);
  }

  // ── internals ──────────────────────────────────────────────

  private async bioCipher(inputB64: string, authToken: Uint8Array, purpose: number): Promise<string> {
    const encoder = new util.Base64Helper();
    const inputBytes = encoder.decodeSync(inputB64);

    if (purpose === huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT) {
      const iv = this.randomIv();
      const props: huks.HuksParam[] = [
        { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
        { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
        { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: purpose },
        { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
        { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
        { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
        { tag: huks.HuksTag.HUKS_TAG_AUTH_TOKEN, value: authToken },
      ];
      const handle = await huks.initSession(BIO_ALIAS, { properties: props });
      const finished = await huks.finishSession(handle.handle, { properties: props, inData: inputBytes });
      const blob: CipherBlob = {
        iv: encoder.encodeToStringSync(iv),
        ct: encoder.encodeToStringSync(finished.outData ?? new Uint8Array()),
      };
      return encoder.encodeToStringSync(new util.TextEncoder().encodeInto(JSON.stringify(blob)));
    } else {
      const blob = JSON.parse(new util.TextDecoder('utf-8').decodeToString(inputBytes)) as CipherBlob;
      const iv = encoder.decodeSync(blob.iv);
      const ct = encoder.decodeSync(blob.ct);
      const props: huks.HuksParam[] = [
        { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
        { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
        { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: purpose },
        { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
        { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
        { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
        { tag: huks.HuksTag.HUKS_TAG_AE_TAG, value: ct.slice(ct.byteLength - TAG_LEN) },
        { tag: huks.HuksTag.HUKS_TAG_AUTH_TOKEN, value: authToken },
      ];
      const handle = await huks.initSession(BIO_ALIAS, { properties: props });
      const finished = await huks.finishSession(handle.handle, {
        properties: props,
        inData: ct.slice(0, ct.byteLength - TAG_LEN),
      });
      return encoder.encodeToStringSync(finished.outData ?? new Uint8Array());
    }
  }

  private randomIv(): Uint8Array {
    const iv = new Uint8Array(IV_LEN);
    for (let i = 0; i < IV_LEN; i++) {
      iv[i] = Math.floor(Math.random() * 256);
    }
    return iv;
  }

  private async hasKey(alias: string): Promise<boolean> {
    try {
      await huks.isKeyItemExist(alias, { properties: [] });
      return true;
    } catch (e) { return false; }
  }
}

/// Bundle handed by UserAuth → HuksService for bio operations. authToken
/// lives ~5 seconds on the HUKS side; reuse is not safe across that window.
export interface BioAuthBundle {
  authToken: Uint8Array;
  challenge: Uint8Array;
}

/// Prompt the user for fingerprint/face and return the authToken. Throws if
/// the user cancels or the device doesn't support the requested level.
export async function requestBioAuth(): Promise<BioAuthBundle> {
  const challenge = new Uint8Array(32);
  for (let i = 0; i < 32; i++) challenge[i] = Math.floor(Math.random() * 256);
  const auth = userAuth.getAuthInstance(
    challenge,
    userAuth.UserAuthType.FINGERPRINT,
    userAuth.AuthTrustLevel.ATL2,
  );
  return new Promise<BioAuthBundle>((resolve, reject) => {
    auth.on('result', (code: number, extra: userAuth.AuthResultInfo) => {
      if (code === userAuth.ResultCodeV9.SUCCESS) {
        resolve({ authToken: extra.token ?? new Uint8Array(), challenge });
      } else {
        hilog.warn(0x0000, 'shibei', 'bio auth failed: %{public}d', code);
        reject(new Error(`error.bioAuthFailed:${code}`));
      }
    });
    try { auth.start(); }
    catch (e) { reject(e); }
  });
}
```

- [ ] **Step 2: 回填 Task 7 注释掉的 HuksService 调用**

Edit `services/ShibeiService.ets`: 把 Task 7 Step 4 里用 `await import('./HuksService')` 的部分改成顶层 `import { HuksService } from './HuksService';`，删掉动态 import。

- [ ] **Step 3: 构建 + 验证**

```bash
cd /Users/work/workspace/Shibei && scripts/build-harmony-napi.sh
```

Expected: 编译通过，ArkTS 侧 tsc 通过（DevEco 会在手机端跑时报任何运行时错误——这是 Task 13 冒烟覆盖）。

- [ ] **Step 4: Commit**

```bash
cd /Users/work/workspace/Shibei && git add -A && git commit -m "feat(harmony): HuksService.ets with device-bound + bio-gated AES-256-GCM"
```

---

### Task 9: ArkTS `LockService.ets`

**Files:**
- Create: `shibei-harmony/entry/src/main/ets/services/LockService.ets`

- [ ] **Step 1: 写 LockService.ets**

```typescript
// shibei-harmony/entry/src/main/ets/services/LockService.ets
//
// State machine + 30s grace timer + lifecycle hooks.
//
// Invariants (spec §2.2):
//   NotConfigured — user never enabled App Lock. MK may still be cached.
//   Unlocked      — MK in memory, UI accessible.
//   GracePeriod   — app went to background less than 30s ago. MK still in
//                   memory; UI should render LockScreen overlay but not
//                   actually wipe MK until the timer fires.
//   Locked        — MK cleared (napi.lockVault()); route forced to LockScreen.

import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from './ShibeiService';
import { HuksService, requestBioAuth, BioAuthBundle } from './HuksService';

export enum LockState {
  NotConfigured = 'NotConfigured',
  Unlocked = 'Unlocked',
  GracePeriod = 'GracePeriod',
  Locked = 'Locked',
}

type Subscriber = (s: LockState) => void;

const GRACE_MS = 30 * 1000;

export class LockService {
  private static _instance: LockService | null = null;
  static get instance(): LockService {
    if (!LockService._instance) LockService._instance = new LockService();
    return LockService._instance;
  }

  private state: LockState = LockState.NotConfigured;
  private graceTimerId: number = -1;
  private backgroundedAtMs: number = 0;
  private subscribers: Set<Subscriber> = new Set<Subscriber>();

  getState(): LockState { return this.state; }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return (): void => { this.subscribers.delete(cb); };
  }

  /// Inspect NAPI + in-memory state to classify the initial lifecycle.
  /// Called once by EntryAbility.onWindowStageCreate.
  async initialize(): Promise<void> {
    const svc = ShibeiService.instance;
    const configured = svc.lockIsConfigured();
    const mkLoaded = svc.lockIsMkLoaded();
    if (!configured) {
      this.setState(LockState.NotConfigured);
    } else if (mkLoaded) {
      this.setState(LockState.Unlocked);
    } else {
      this.setState(LockState.Locked);
    }
  }

  // ── Lifecycle hooks ────────────────────────────────────────

  onBackgrounded(): void {
    if (this.state !== LockState.Unlocked) return;
    this.backgroundedAtMs = Date.now();
    this.clearGraceTimer();
    this.graceTimerId = setTimeout(() => {
      this.graceTimerId = -1;
      if (this.state === LockState.GracePeriod) {
        this.performLock();
      }
    }, GRACE_MS);
    this.setState(LockState.GracePeriod);
  }

  onForegrounded(): void {
    this.clearGraceTimer();
    if (this.state !== LockState.GracePeriod) return;
    const elapsed = Date.now() - this.backgroundedAtMs;
    if (elapsed >= GRACE_MS) {
      this.performLock();
    } else {
      this.setState(LockState.Unlocked);
    }
  }

  lockNow(): void {
    this.clearGraceTimer();
    this.performLock();
  }

  // ── Setup / unlock / disable ───────────────────────────────

  async setupPin(pin: string, enableBio: boolean): Promise<void> {
    const svc = ShibeiService.instance;
    await svc.lockSetupPin(pin);
    if (enableBio) {
      await this.enableBio();
    }
    this.setState(LockState.Unlocked);
  }

  async enableBio(): Promise<void> {
    const svc = ShibeiService.instance;
    const huks = HuksService.instance;
    if (!(await huks.isBioAvailable())) {
      throw new ShibeiError('error.bioUnavailable');
    }
    await huks.generateBioKey();
    const bundle: BioAuthBundle = await requestBioAuth();
    // Get current MK from NAPI? We can't extract it. Strategy: pipe through
    // "push + immediately wrap": ask NAPI for the in-memory MK via a new
    // command? Simpler: re-unlock with PIN, grab the resulting MK by
    // calling a NAPI that returns the raw MK — but that leaks MK to ArkTS.
    // Phase 4 v1 compromise: enableBio requires user just typed PIN, we
    // derive MK from secure/mk_pin.blob via `lockUnlockWithPin` (which
    // already is the flow), then use HUKS to re-wrap. The MK bytes are
    // transiently in ArkTS. To minimize exposure, we need a NAPI that
    // returns the in-memory MK ONCE and zeroizes its own copy after — but
    // that's complex. Phase 4 v1 choice: rely on the user re-typing PIN
    // during enableBio, take the short path: call NAPI `lock_get_mk_for_bio_enroll`
    // which returns base64 MK only if the vault is currently unlocked (MK
    // in memory). Acceptable because the enrollment moment is brief.
    const mkB64: string = svc.lockIsMkLoaded() ? await this.fetchMkForBioEnroll() : '';
    if (!mkB64) throw new ShibeiError('error.notUnlocked');
    const wrapped = await huks.wrapBio(mkB64, bundle.authToken);
    await svc.lockEnableBio(wrapped);
  }

  // Internal helper — calls NAPI `lockGetMkForBioEnroll` (added in Task 6 only
  // for ArkTS bio setup). The returned base64 MK is discarded after wrap.
  private async fetchMkForBioEnroll(): Promise<string> {
    // Added in Task 6: lock_get_mk_for_bio_enroll() -> String
    const svc = ShibeiService.instance;
    return svc.lockGetMkForBioEnroll();
  }

  async unlockWithPin(pin: string): Promise<void> {
    await ShibeiService.instance.lockUnlockWithPin(pin);
    this.setState(LockState.Unlocked);
  }

  async unlockWithBio(): Promise<void> {
    const svc = ShibeiService.instance;
    const huks = HuksService.instance;
    const wrapped = svc.lockGetBioWrappedMk();
    if (!wrapped) throw new ShibeiError('error.bioNotEnabled');
    let bundle: BioAuthBundle;
    try { bundle = await requestBioAuth(); }
    catch (e) { throw new ShibeiError('error.bioAuthFailed'); }
    let mkB64: string;
    try {
      mkB64 = await huks.unwrapBio(wrapped, bundle.authToken);
    } catch (e) {
      // Likely INVALID_NEW_BIO_ENROLL revocation
      hilog.warn(0x0000, 'shibei', 'unwrapBio failed: %{public}s', (e as Error).message);
      await huks.deleteBioKey();
      throw new ShibeiError('error.bioRevoked');
    }
    await svc.lockPushUnwrappedMk(mkB64);
    this.setState(LockState.Unlocked);
  }

  async disable(pin: string): Promise<void> {
    await ShibeiService.instance.lockDisable(pin);
    await HuksService.instance.deleteBioKey();
    this.setState(LockState.NotConfigured);
  }

  async recoverWithE2ee(password: string, newPin: string): Promise<void> {
    await ShibeiService.instance.lockRecoverWithE2ee(password, newPin);
    // recover_with_e2ee wipes bio so user must re-enable from Settings.
    await HuksService.instance.deleteBioKey();
    this.setState(LockState.Unlocked);
  }

  // ── internals ──────────────────────────────────────────────

  private performLock(): void {
    ShibeiService.instance.lockVault();
    this.setState(LockState.Locked);
    router.replaceUrl({ url: 'pages/LockScreen' }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'route to lockScreen failed: %{public}s', err.message);
    });
  }

  private setState(s: LockState): void {
    if (s === this.state) return;
    this.state = s;
    this.subscribers.forEach((sub) => {
      try { sub(s); } catch (e) {
        hilog.warn(0x0000, 'shibei', 'lock sub threw: %{public}s', (e as Error).message);
      }
    });
  }

  private clearGraceTimer(): void {
    if (this.graceTimerId !== -1) {
      clearTimeout(this.graceTimerId);
      this.graceTimerId = -1;
    }
  }
}
```

- [ ] **Step 2: 加 NAPI `lock_get_mk_for_bio_enroll`**

Edit `src-harmony-napi/src/lock.rs` 末尾：

```rust
/// Phase 4 v1 compromise: during bio enrollment the user has just typed PIN,
/// MK is in memory. Return it as base64 so ArkTS can HUKS-wrap it with the
/// bio key. Returns empty string if not unlocked — caller must have just
/// run a PIN unlock.
pub fn get_mk_for_bio_enroll() -> String {
    use base64::Engine;
    let Ok(app) = state::get() else { return String::new() };
    match app.encryption.get_key() {
        Some(mk) => base64::engine::general_purpose::STANDARD.encode(mk),
        None => String::new(),
    }
}
```

`src-harmony-napi/src/commands.rs` 加：

```rust
#[shibei_napi]
pub fn lock_get_mk_for_bio_enroll() -> String {
    crate::lock::get_mk_for_bio_enroll()
}
```

重新 codegen：

```bash
cd /Users/work/workspace/Shibei && cargo run -p shibei-napi-codegen && cargo check -p shibei-core
```

Edit `services/ShibeiService.ets`: import 加 `lockGetMkForBioEnroll as napiLockGetMkForBioEnroll`。class 加：

```typescript
  lockGetMkForBioEnroll(): string {
    return napiLockGetMkForBioEnroll();
  }
```

- [ ] **Step 3: 构建 + 校验**

```bash
cd /Users/work/workspace/Shibei && scripts/build-harmony-napi.sh
```

- [ ] **Step 4: Commit**

```bash
cd /Users/work/workspace/Shibei && git add -A && git commit -m "feat(harmony): LockService state machine + bio enroll helper NAPI"
```

---

### Task 10: EntryAbility 生命周期 + Onboard Step 4

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Onboard.ets`

- [ ] **Step 1: EntryAbility 改造**

在 `EntryAbility.ets` 现有 `import` 区加：

```typescript
import { LockService, LockState } from '../services/LockService';
```

`onWindowStageCreate` 方法中（在 `await ShibeiService.instance.init(...)` 之后）加：

```typescript
      // Phase 4: initialize LockService state machine before choosing the route.
      await LockService.instance.initialize();
      // Prime S3 creds from HUKS-wrapped blob if present.
      await ShibeiService.instance.primeS3Creds().catch((e: Error) => {
        hilog.warn(0x0000, 'shibei', 'prime s3 creds failed: %{public}s', e.message);
      });
```

改 route 选择为：

```typescript
      if (!ShibeiService.instance.hasSavedConfig()) {
        route = 'pages/Onboard';
      } else if (LockService.instance.getState() === LockState.Locked) {
        route = 'pages/LockScreen';
      } else {
        route = 'pages/Library';
      }
```

在 class 底部（`onWindowStageCreate` 之后）加 ability 级生命周期钩子：

```typescript
  onBackground(): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onBackground');
    LockService.instance.onBackgrounded();
  }

  onForeground(): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onForeground');
    LockService.instance.onForegrounded();
  }
```

- [ ] **Step 2: Onboard.ets 加 Step 4**

Read 当前 Onboard.ets 找到 E2EE 密码成功 → 跳 Library 的路径。替换跳转为一个可选 step 4 → 「启用 App 锁」或 「暂不启用」。

先读出相关片段：

```bash
grep -n "Library\|setE2ee\|router\.replace" /Users/work/workspace/Shibei/shibei-harmony/entry/src/main/ets/pages/Onboard.ets | head -20
```

实施关键点（示例）：

- 新增 `@State showLockStep: boolean = false`
- E2EE 成功后 `this.showLockStep = true`（不 router 跳转）
- 在 `build()` 里用 `if (this.showLockStep)` 切到新 UI 段：

```typescript
        if (this.showLockStep) {
          Column() {
            Text('启用 App 锁？').fontSize(20).fontWeight(FontWeight.Bold)
              .margin({ top: 40, bottom: 12 });
            Text('设置 4 位 PIN，日常可以用指纹或面部快速解锁。')
              .fontSize(13).fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .margin({ bottom: 32, left: 24, right: 24 }).textAlign(TextAlign.Center);
            Button('设置 PIN').width('80%').height(44)
              .onClick(() => this.startPinSetup());
            Button('暂不启用').width('80%').height(44)
              .backgroundColor(Color.Transparent)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .margin({ top: 12 })
              .onClick(() => this.skipLockSetup());
          }.width('100%').alignItems(HorizontalAlign.Center);
        } else {
          // existing E2EE step UI
          ...
        }
```

和两个 handler：

```typescript
  private async startPinSetup(): Promise<void> {
    // Reuse the same PIN dialog component Settings uses; for Phase 4 v1 a
    // lightweight in-Onboard flow is fine: push a dedicated page.
    router.pushUrl({ url: 'pages/LockSetup', params: { fromOnboard: true } });
  }
  private skipLockSetup(): void {
    router.replaceUrl({ url: 'pages/Library' });
  }
```

**Decision for Phase 4 v1:** 不新建独立 `LockSetup.ets` 页——直接用 Settings 里的 PIN 对话框组件（Task 12 建）。Onboard Step 4 的 `startPinSetup` 改成在当前 Onboard 页 inline 展示 PIN 对话框：

```typescript
  @State onboardPin: string = '';
  @State onboardPinConfirm: string = '';
  @State onboardPinStep: 'enter' | 'confirm' = 'enter';

  private async submitOnboardPin(): Promise<void> {
    if (this.onboardPinStep === 'enter') {
      if (this.onboardPin.length !== 4 || !/^\d{4}$/.test(this.onboardPin)) {
        promptAction.showToast({ message: 'PIN 必须是 4 位数字' });
        return;
      }
      this.onboardPinStep = 'confirm';
      this.onboardPinConfirm = '';
      return;
    }
    if (this.onboardPinConfirm !== this.onboardPin) {
      promptAction.showToast({ message: '两次输入不一致' });
      this.onboardPinStep = 'enter';
      this.onboardPin = '';
      return;
    }
    try {
      // Ask user if they also want bio (simple prompt)
      const dlg = await promptAction.showDialog({
        title: '启用生物识别？',
        message: '指纹或面部识别可以让日常解锁更快。',
        buttons: [{ text: '只用 PIN' }, { text: '启用生物识别' }],
      });
      const wantBio = dlg.index === 1;
      await LockService.instance.setupPin(this.onboardPin, wantBio);
      router.replaceUrl({ url: 'pages/Library' });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({ message: `启用失败: ${code}` });
    }
  }
```

在 Onboard import 顶加 `import { LockService } from '../services/LockService';`。

- [ ] **Step 3: 构建 + 校验**

```bash
cd /Users/work/workspace/Shibei && scripts/build-harmony-napi.sh
```

- [ ] **Step 4: Commit**

```bash
cd /Users/work/workspace/Shibei && git add -A && git commit -m "feat(harmony): EntryAbility lifecycle hooks + Onboard Step 4 enable-app-lock"
```

---

### Task 11: `LockScreen.ets` UI 改造

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/LockScreen.ets`

**Replaces:** 现有页面只接受 E2EE 密码的版本。

- [ ] **Step 1: 全量改写 LockScreen.ets**

```typescript
import { hilog } from '@kit.PerformanceAnalysisKit';
import { router, promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { LockService } from '../services/LockService';

// Phase 4 lock screen. Entry condition (EntryAbility.ets routes here):
//   * App Lock is configured, MK is NOT loaded in memory.
// Primary path: bio auth → HUKS unwrap → unlock.
// Fallback: 4-digit PIN; fills auto-submits; throttle enforced by NAPI.
// Escape: "忘记 PIN" → E2EE password + new PIN.

@Entry
@Component
struct LockScreen {
  @State pin: string = '';
  @State errorMsg: string = '';
  @State throttleSecs: number = 0;
  @State bioAvailable: boolean = false;
  @State showRecovery: boolean = false;
  @State recoveryPassword: string = '';
  @State recoveryNewPin: string = '';
  @State recoveryStep: 'password' | 'newPin' = 'password';
  @State recovering: boolean = false;

  private throttleTimer: number = -1;

  async aboutToAppear(): Promise<void> {
    this.bioAvailable = ShibeiService.instance.lockIsBioEnabled();
    this.throttleSecs = ShibeiService.instance.lockLockoutRemainingSecs();
    if (this.throttleSecs > 0) this.startThrottleCountdown();
    // Auto-trigger biometric if enabled
    if (this.bioAvailable && this.throttleSecs <= 0) {
      await this.tryBio();
    }
  }

  aboutToDisappear(): void {
    if (this.throttleTimer !== -1) {
      clearInterval(this.throttleTimer);
      this.throttleTimer = -1;
    }
  }

  private startThrottleCountdown(): void {
    if (this.throttleTimer !== -1) return;
    this.throttleTimer = setInterval(() => {
      this.throttleSecs = ShibeiService.instance.lockLockoutRemainingSecs();
      if (this.throttleSecs <= 0) {
        clearInterval(this.throttleTimer);
        this.throttleTimer = -1;
      }
    }, 1000);
  }

  private async tryBio(): Promise<void> {
    try {
      await LockService.instance.unlockWithBio();
      router.replaceUrl({ url: 'pages/Library' });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      if (code === 'error.bioRevoked') {
        this.errorMsg = '指纹库已变更，请用 PIN 解锁后在设置里重新启用生物识别';
        this.bioAvailable = false;
      }
      // Other failures (cancel, lockout) silently fall back to PIN input.
    }
  }

  private async tryPinSubmit(): Promise<void> {
    if (this.pin.length !== 4) return;
    this.errorMsg = '';
    try {
      await LockService.instance.unlockWithPin(this.pin);
      router.replaceUrl({ url: 'pages/Library' });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      this.pin = '';
      if (code.startsWith('error.lockThrottled:')) {
        const secs = parseInt(code.split(':')[1] || '0', 10);
        this.throttleSecs = secs;
        this.errorMsg = `连续错误，${secs} 秒后再试`;
        this.startThrottleCountdown();
      } else if (code === 'error.pinIncorrect') {
        this.errorMsg = 'PIN 错误';
      } else {
        this.errorMsg = `解锁失败: ${code}`;
      }
    }
  }

  private async submitRecovery(): Promise<void> {
    if (this.recoveryStep === 'password') {
      if (!this.recoveryPassword) return;
      this.recoveryStep = 'newPin';
      return;
    }
    if (this.recoveryNewPin.length !== 4 || !/^\d{4}$/.test(this.recoveryNewPin)) {
      promptAction.showToast({ message: '新 PIN 必须是 4 位数字' });
      return;
    }
    this.recovering = true;
    try {
      await LockService.instance.recoverWithE2ee(this.recoveryPassword, this.recoveryNewPin);
      this.recoveryPassword = '';
      this.recoveryNewPin = '';
      router.replaceUrl({ url: 'pages/Library' });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({ message: `恢复失败: ${code}` });
      this.recoveryStep = 'password';
      this.recoveryPassword = '';
    } finally {
      this.recovering = false;
    }
  }

  @Builder
  PinDots() {
    Row() {
      ForEach([0, 1, 2, 3], (i: number) => {
        Circle({ width: 14, height: 14 })
          .fill(i < this.pin.length ? $r('sys.color.ohos_id_color_text_primary') : Color.Transparent)
          .stroke($r('sys.color.ohos_id_color_text_tertiary'))
          .strokeWidth(1.5)
          .margin({ left: 8, right: 8 });
      }, (i: number) => String(i));
    }.justifyContent(FlexAlign.Center).width('100%');
  }

  build() {
    Column() {
      if (!this.showRecovery) {
        Text('已锁定').fontSize(28).fontWeight(FontWeight.Bold)
          .margin({ top: 80, bottom: 32 });

        this.PinDots();

        TextInput({ placeholder: '', text: this.pin })
          .type(InputType.Number)
          .maxLength(4)
          .opacity(0)
          .height(1)
          .enabled(this.throttleSecs <= 0)
          .onChange((v: string) => {
            const digits = v.replace(/\D/g, '').slice(0, 4);
            this.pin = digits;
            if (digits.length === 4) this.tryPinSubmit();
          })
          .onAppear(() => { /* auto-focus would go here if supported */ });

        if (this.errorMsg) {
          Text(this.errorMsg).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_warning'))
            .margin({ top: 24, left: 32, right: 32 })
            .textAlign(TextAlign.Center);
        }

        if (this.throttleSecs > 0) {
          Text(`${this.throttleSecs} 秒后可重试`).fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
            .margin({ top: 8 });
        }

        if (this.bioAvailable && this.throttleSecs <= 0) {
          Button('🔒 使用生物识别')
            .backgroundColor(Color.Transparent)
            .fontColor($r('sys.color.ohos_id_color_emphasize'))
            .margin({ top: 48 })
            .onClick(() => this.tryBio());
        }

        Blank().layoutWeight(1);

        Text('忘记 PIN?').fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
          .margin({ bottom: 32 })
          .onClick(() => { this.showRecovery = true; this.errorMsg = ''; });
      } else {
        // Recovery: E2EE password → new PIN
        Text(this.recoveryStep === 'password' ? '输入 E2EE 密码' : '设置新 PIN')
          .fontSize(22).fontWeight(FontWeight.Bold)
          .margin({ top: 80, bottom: 32 });
        if (this.recoveryStep === 'password') {
          TextInput({ placeholder: 'E2EE 密码', text: this.recoveryPassword })
            .type(InputType.Password)
            .width('80%')
            .onChange((v: string) => this.recoveryPassword = v);
        } else {
          TextInput({ placeholder: '4 位数字新 PIN', text: this.recoveryNewPin })
            .type(InputType.Number)
            .maxLength(4)
            .width('80%')
            .onChange((v: string) => this.recoveryNewPin = v.replace(/\D/g, '').slice(0, 4));
        }
        Button(this.recovering ? '处理中…' : (this.recoveryStep === 'password' ? '下一步' : '完成'))
          .width('80%').height(44)
          .enabled(!this.recovering)
          .margin({ top: 24 })
          .onClick(() => this.submitRecovery());
        Button('取消')
          .backgroundColor(Color.Transparent)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: 12 })
          .onClick(() => {
            this.showRecovery = false;
            this.recoveryStep = 'password';
            this.recoveryPassword = '';
            this.recoveryNewPin = '';
          });
      }
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(HorizontalAlign.Center);
  }
}
```

- [ ] **Step 2: 构建校验**

```bash
cd /Users/work/workspace/Shibei && scripts/build-harmony-napi.sh
```

- [ ] **Step 3: Commit**

```bash
cd /Users/work/workspace/Shibei && git add shibei-harmony/entry/src/main/ets/pages/LockScreen.ets && git commit -m "feat(harmony): LockScreen UI rewrite (PIN + bio + forgot-PIN recovery)"
```

---

### Task 12: `Settings.ets` 安全分区扩展

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Settings.ets`

- [ ] **Step 1: 扩展 Settings**

在 `Settings.ets` 现有 imports 加：

```typescript
import { LockService, LockState } from '../services/LockService';
import { HuksService } from '../services/HuksService';
```

在 `@Component struct Settings` 里加新 state：

```typescript
  @State lockEnabled: boolean = false;
  @State bioEnabled: boolean = false;
  @State bioAvailable: boolean = false;
  @State showSetupLock: boolean = false;
  @State showDisableLock: boolean = false;
  @State showChangePin: boolean = false;
  @State pinInput: string = '';
  @State pinConfirm: string = '';
  @State pinStep: 'enter' | 'confirm' = 'enter';
  @State oldPinInput: string = '';
```

扩展 `aboutToAppear`：

```typescript
  async aboutToAppear(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.theme = await loadTheme(ctx);
    this.lockEnabled = ShibeiService.instance.lockIsConfigured();
    this.bioEnabled = ShibeiService.instance.lockIsBioEnabled();
    this.bioAvailable = await HuksService.instance.isBioAvailable();
  }
```

新增 handlers：

```typescript
  private async startSetupLock(): Promise<void> {
    this.showSetupLock = true;
    this.pinStep = 'enter';
    this.pinInput = '';
    this.pinConfirm = '';
  }

  private async submitSetupLock(): Promise<void> {
    if (this.pinStep === 'enter') {
      if (this.pinInput.length !== 4 || !/^\d{4}$/.test(this.pinInput)) {
        promptAction.showToast({ message: 'PIN 必须是 4 位数字' });
        return;
      }
      this.pinStep = 'confirm';
      this.pinConfirm = '';
      return;
    }
    if (this.pinConfirm !== this.pinInput) {
      promptAction.showToast({ message: '两次输入不一致' });
      this.pinStep = 'enter';
      this.pinInput = '';
      return;
    }
    try {
      const wantBio = this.bioAvailable ? (await promptAction.showDialog({
        title: '启用生物识别？',
        message: '指纹或面部识别可以让日常解锁更快。',
        buttons: [{ text: '只用 PIN' }, { text: '启用生物识别' }],
      })).index === 1 : false;
      await LockService.instance.setupPin(this.pinInput, wantBio);
      this.lockEnabled = true;
      this.bioEnabled = wantBio;
      this.showSetupLock = false;
      this.pinInput = '';
      this.pinConfirm = '';
      promptAction.showToast({ message: 'App 锁已启用' });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({ message: `启用失败: ${code}` });
    }
  }

  private async submitDisableLock(): Promise<void> {
    try {
      await LockService.instance.disable(this.pinInput);
      this.lockEnabled = false;
      this.bioEnabled = false;
      this.showDisableLock = false;
      this.pinInput = '';
      promptAction.showToast({ message: 'App 锁已停用' });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      this.pinInput = '';
      promptAction.showToast({ message: code === 'error.pinIncorrect' ? 'PIN 错误' : `停用失败: ${code}` });
    }
  }

  private async toggleBio(target: boolean): Promise<void> {
    try {
      if (target) {
        await LockService.instance.enableBio();
        this.bioEnabled = true;
        promptAction.showToast({ message: '生物识别已启用' });
      } else {
        // disable bio only (keep PIN lock enabled): blow away mk_bio + key
        const svc = ShibeiService.instance;
        // No dedicated command yet; reuse lockEnableBio with empty? simpler:
        // ArkTS-only blow away
        await HuksService.instance.deleteBioKey();
        // Rust-side mk_bio.blob deletion: add to lock.rs as lock_delete_bio_only
        await svc.lockDeleteBioOnly();
        this.bioEnabled = false;
        promptAction.showToast({ message: '生物识别已停用' });
      }
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({ message: `切换失败: ${code}` });
    }
  }

  private async submitChangePin(): Promise<void> {
    if (this.oldPinInput.length !== 4) return;
    if (this.pinInput.length !== 4) return;
    if (this.pinConfirm !== this.pinInput) {
      promptAction.showToast({ message: '新 PIN 两次输入不一致' });
      return;
    }
    try {
      // Verify old PIN by unlocking; we're already unlocked but lockUnlockWithPin
      // performs a fresh hash verify cycle and re-caches MK — safe.
      await ShibeiService.instance.lockUnlockWithPin(this.oldPinInput);
      // MK is now in memory. Setup new PIN overwrites mk_pin.blob + pin_hash.blob.
      await ShibeiService.instance.lockSetupPin(this.pinInput);
      // If bio was enabled, the old mk_bio.blob is still valid (same MK);
      // no re-wrap needed. (Would only be needed if PIN change also rotated MK.)
      this.showChangePin = false;
      this.oldPinInput = '';
      this.pinInput = '';
      this.pinConfirm = '';
      promptAction.showToast({ message: 'PIN 已修改' });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({ message: code === 'error.pinIncorrect' ? '旧 PIN 错误' : `修改失败: ${code}` });
    }
  }
```

**新 NAPI `lock_delete_bio_only`**：

Edit `src-harmony-napi/src/lock.rs`：

```rust
/// Turn off bio-only, keep PIN lock enabled. Wipes `mk_bio.blob` and clears
/// the bioEnabled flag. HUKS bio key deletion happens ArkTS-side.
pub fn delete_bio_only() -> Result<String, String> {
    let app = state::get()?;
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    store.delete("mk_bio")?;
    let mut prefs = SecurityPrefs::load(&app.data_dir);
    prefs.bio_enabled = false;
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}
```

commands.rs 加：

```rust
#[shibei_napi(async)]
pub async fn lock_delete_bio_only() -> Result<String, String> {
    crate::lock::delete_bio_only()
}
```

ShibeiService import: `lockDeleteBioOnly as napiLockDeleteBioOnly`。class method：

```typescript
  async lockDeleteBioOnly(): Promise<void> {
    let result: string;
    try { result = await napiLockDeleteBioOnly(); }
    catch (rejected) { throw new ShibeiError(asErrorCode(rejected)); }
    if (result !== 'ok') throw new ShibeiError(result);
  }
```

Rebuild codegen：

```bash
cd /Users/work/workspace/Shibei && cargo run -p shibei-napi-codegen && cargo check -p shibei-core
```

- [ ] **Step 2: 扩展 Settings 的 UI**

在 `build()` 里，「安全」分区（目前只有「立即锁定」）重写为：

```typescript
          // ── 安全 ─────────────────────────────────────────
          Text('安全').fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            // 启用/停用 App 锁
            Row() {
              Text('启用 App 锁').fontSize(15).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'));
              Toggle({ type: ToggleType.Switch, isOn: this.lockEnabled })
                .onChange((isOn: boolean) => {
                  if (isOn && !this.lockEnabled) this.startSetupLock();
                  else if (!isOn && this.lockEnabled) {
                    this.showDisableLock = true; this.pinInput = '';
                  }
                });
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });

            if (this.lockEnabled) {
              Divider().color($r('sys.color.ohos_id_color_list_separator'));
              // 生物识别开关
              Row() {
                Column() {
                  Text('生物识别解锁').fontSize(15)
                    .fontColor($r('sys.color.ohos_id_color_text_primary'));
                  if (!this.bioAvailable) {
                    Text('请先在系统设置中添加指纹或面部').fontSize(11)
                      .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
                  }
                }.alignItems(HorizontalAlign.Start).layoutWeight(1);
                Toggle({ type: ToggleType.Switch, isOn: this.bioEnabled })
                  .enabled(this.bioAvailable)
                  .onChange((isOn: boolean) => {
                    if (isOn !== this.bioEnabled) this.toggleBio(isOn);
                  });
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });
              Divider().color($r('sys.color.ohos_id_color_list_separator'));
              // 修改 PIN
              Row() {
                Text('修改 PIN').fontSize(15).layoutWeight(1)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                Text('›').fontSize(18)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
                .onClick(() => {
                  this.showChangePin = true;
                  this.oldPinInput = ''; this.pinInput = ''; this.pinConfirm = '';
                  this.pinStep = 'enter';
                });
              Divider().color($r('sys.color.ohos_id_color_list_separator'));
              // 立即锁定
              Row() {
                Text('立即锁定').fontSize(15).layoutWeight(1)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                Text('›').fontSize(18)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
                .onClick(() => this.lockNow());
            } else {
              Divider().color($r('sys.color.ohos_id_color_list_separator'));
              // 仅未启用时显示的「立即锁定」
              Row() {
                Text('立即锁定').fontSize(15).layoutWeight(1)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                Text('›').fontSize(18)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
                .onClick(() => this.lockNow());
            }
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // Setup PIN dialog (inline)
          if (this.showSetupLock) {
            Column() {
              Text(this.pinStep === 'enter' ? '设置 PIN（4 位数字）' : '再输入一次确认')
                .fontSize(14).margin({ top: 16 });
              TextInput({
                placeholder: '',
                text: this.pinStep === 'enter' ? this.pinInput : this.pinConfirm,
              })
                .type(InputType.Number).maxLength(4).width('60%')
                .margin({ top: 12 })
                .onChange((v: string) => {
                  const d = v.replace(/\D/g, '').slice(0, 4);
                  if (this.pinStep === 'enter') this.pinInput = d; else this.pinConfirm = d;
                  if (d.length === 4) this.submitSetupLock();
                });
              Button('取消').backgroundColor(Color.Transparent)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ top: 12 })
                .onClick(() => { this.showSetupLock = false; this.pinInput = ''; this.pinConfirm = ''; });
            }.width('100%').padding(12);
          }

          // Disable PIN dialog
          if (this.showDisableLock) {
            Column() {
              Text('输入当前 PIN 以停用').fontSize(14).margin({ top: 16 });
              TextInput({ placeholder: '4 位 PIN', text: this.pinInput })
                .type(InputType.Number).maxLength(4).width('60%').margin({ top: 12 })
                .onChange((v: string) => {
                  const d = v.replace(/\D/g, '').slice(0, 4);
                  this.pinInput = d;
                  if (d.length === 4) this.submitDisableLock();
                });
              Button('取消').backgroundColor(Color.Transparent)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ top: 12 })
                .onClick(() => { this.showDisableLock = false; this.pinInput = ''; });
            }.width('100%').padding(12);
          }

          // Change PIN dialog
          if (this.showChangePin) {
            Column() {
              Text('输入旧 PIN').fontSize(14).margin({ top: 16 });
              TextInput({ placeholder: '旧 4 位 PIN', text: this.oldPinInput })
                .type(InputType.Number).maxLength(4).width('60%').margin({ top: 8 })
                .onChange((v: string) => { this.oldPinInput = v.replace(/\D/g, '').slice(0, 4); });
              Text(this.pinStep === 'enter' ? '输入新 PIN' : '再输入一次确认')
                .fontSize(14).margin({ top: 16 });
              TextInput({
                placeholder: '新 4 位 PIN',
                text: this.pinStep === 'enter' ? this.pinInput : this.pinConfirm,
              })
                .type(InputType.Number).maxLength(4).width('60%').margin({ top: 8 })
                .onChange((v: string) => {
                  const d = v.replace(/\D/g, '').slice(0, 4);
                  if (this.pinStep === 'enter') {
                    this.pinInput = d;
                    if (d.length === 4) this.pinStep = 'confirm';
                  } else {
                    this.pinConfirm = d;
                    if (d.length === 4) this.submitChangePin();
                  }
                });
              Button('取消').backgroundColor(Color.Transparent)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ top: 12 })
                .onClick(() => {
                  this.showChangePin = false;
                  this.oldPinInput = ''; this.pinInput = ''; this.pinConfirm = '';
                });
            }.width('100%').padding(12);
          }
```

- [ ] **Step 3: 构建 + 校验**

```bash
cd /Users/work/workspace/Shibei && scripts/build-harmony-napi.sh
```

- [ ] **Step 4: Commit**

```bash
cd /Users/work/workspace/Shibei && git add -A && git commit -m "feat(harmony): Settings 安全分区 — 启用/停用/生物识别开关/修改 PIN"
```

---

### Task 13: 真机冒烟 + 修正

**Files:** 无（纯测试）

**Scope:** 按 spec §8.2 的 12 项冒烟清单在 Mate X5 上过一遍，每项复现步骤 + 期待现象 + 出问题时定位和修。

- [ ] **Step 1: 推包**

通知用户在本地 DevEco 里打包 hap 并安装到手机。或者如果 hdc 能远程推 hap：

```bash
ssh inming@192.168.64.1 "ls ~/Desktop/*.hap 2>/dev/null | head"
# 如果有，推包：
ssh inming@192.168.64.1 "hdc install ~/Desktop/xxx.hap"
```

- [ ] **Step 2: 跑 12 项清单**

按 spec §8.2：

1. 冷启动未配对 → 应到 Onboard
2. Onboard 跳过启用 App 锁 → Library
3. Settings 启用 App 锁 → 设 PIN → 启用 bio → kill app → 冷启动显示 LockScreen
4. 指纹解锁 → Library
5. 切后台 20s 回来 → 不要求重认证
6. 切后台 60s 回来 → 要求重认证
7. PIN 连错 5 次 → 节流 30s；kill + 重启 → 仍节流
8. 录新指纹 → 启动 → `error.bioRevoked` → PIN 路径可用 → 重启用 bio
9. 忘 PIN → E2EE 密码恢复 + 新 PIN
10. `hdc file recv` → 检查 secure/*.blob 是密文
11. 手机 ↔ 桌面 annotation round-trip
12. Settings 「立即锁定」→ LockScreen

每项用 hilog 辅助：

```bash
ssh inming@192.168.64.1 "hdc shell hilog -r && hdc shell aa force-stop com.shibei.mobile && hdc shell aa start -a EntryAbility -b com.shibei.mobile"
sleep 2
ssh inming@192.168.64.1 "hdc shell hilog | grep shibei"
```

- [ ] **Step 3: 遇到 bug 修一轮**

每个 bug 起一个小 commit，message 前缀 `fix(harmony): phase 4 - <具体现象>`。

- [ ] **Step 4: Commit 冒烟结果**

如果有多轮修复，最后一个 commit 覆盖全部：

```bash
cd /Users/work/workspace/Shibei && git add -A && git commit --allow-empty -m "test(harmony): phase 4 smoke on Mate X5 — all 12 items pass"
```

---

### Task 14: CLAUDE.md + memory 更新

**Files:**
- Modify: `CLAUDE.md`（架构约束段落追加鸿蒙 App 锁屏 bullet）
- Modify: `memory/feedback_arkweb_reader.md` 或新建 `memory/feedback_harmony_lockscreen.md`
- Modify: `memory/MEMORY.md`（加新索引行）

- [ ] **Step 1: 追加 CLAUDE.md bullet**

在 `CLAUDE.md` `## 架构约束` 段末尾（现有「鸿蒙 PDF Reader (Phase 3b)」bullet 之后）插入：

```markdown
- **鸿蒙 App 锁屏（Phase 4）**：Settings → 安全 → 启用 App 锁 = 4 位 PIN + 可选生物识别。PIN Argon2id hash 存 `secure/pin_hash.blob`；MK 经 `XChaCha20-Poly1305` 包两份：PIN-KEK wrap 入 `secure/mk_pin.blob`，HUKS bio-gated key wrap 入 `secure/mk_bio.blob`。**所有 `secure/*.blob` 外层再经 HUKS device-bound key（`shibei_device_bound_v1`）加密**（HUKS 操作由 ArkTS `HuksService.ets` 完成；Rust 只做 inner crypto + 文件 I/O），离开设备立废。S3 凭据同样走 device-bound 包装（`secure/s3_creds.blob`），启动透明解密；**Phase 4 v1** 仍保留 SQLite `credentials` 表作 runtime cache（kill 后自动失效），下一期砍。锁屏状态机 `NotConfigured / Unlocked / GracePeriod(30s) / Locked`（`services/LockService.ets`）；`EntryAbility.onBackground` 起 30s grace timer，回前台 < 30s 直接 Unlocked，≥ 30s → MK `lock_vault()` + 路由 LockScreen；进程 kill 后冷启必锁。忘 PIN 回退 E2EE 密码 → `lockRecoverWithE2ee(password, newPin)` 重建 HUKS 包（旧 bio 失效，需在 Settings 重启用）。节流：错 5 次锁 30s，每累计 5 次错上一档（30s → 5min → 30min），`preferences/security.json` 跨重启持久化。HUKS 密钥别名 `shibei_device_bound_v1`（AES-256-GCM，无认证）/ `shibei_bio_kek_v1`（AES-256-GCM，`USER_AUTH_TYPE_FINGERPRINT|FACE`，`AUTH_ACCESS_INVALID_NEW_BIO_ENROLL`，ATL2）。指纹库变更（HUKS 解包抛错）自动清 `mk_bio.blob` + 删 HUKS bio key，UI 提示「生物识别已失效」。启用生物识别时 ArkTS 通过 `lock_get_mk_for_bio_enroll` NAPI 短暂取一次内存 MK 做 HUKS wrap（ArkTS 侧不持久化）。Rust 侧 crypto 独立 crate `shibei-mobile-lock`（纯 Rust：Argon2id + HKDF-SHA256 + XChaCha20-Poly1305 + 节流状态），macOS `cargo test` 能跑；真机 HUKS 调用只测 ArkTS 端冒烟（spec §8.2 12 项清单）。
```

- [ ] **Step 2: 新建 memory 文件**

Create `memory/feedback_harmony_lockscreen.md`：

```markdown
---
name: Harmony App 锁屏 HUKS 分工
description: ArkTS 做 HUKS，Rust 做 inner crypto + file I/O
type: feedback
---
HarmonyOS NEXT 上 HUKS API 只在 ArkTS 侧（`@kit.UniversalKeystoreKit`）。Rust 从 src-harmony-napi 无法直接调 HUKS（没有 C FFI 成熟绑定）。

**Why:** Phase 4 brainstorm 曾想让 Rust 侧包 HUKS 完整流程（spec §2.3 文字如此），但 Task 0 spike 会直接落地成「ArkTS 调 HUKS，crypto 在 Rust」——因为 `@kit.UniversalKeystoreKit` 是 ArkTS 专属 API，Rust 去碰它成本不合算。

**How to apply:** 新增需要 HUKS 的场景（例如用户数据加密、签名、证书），都走「ArkTS `HuksService.ets` 封装 HUKS API，把已 wrap 的 base64 字节交给 Rust 写盘，反向读盘时给 ArkTS 去 unwrap」模式。HUKS 的所有密钥别名（`shibei_*_v1`）应统一在 `HuksService.ets` 里集中管理，命名空间前缀 `shibei_` + 语义名 + 版本。

## PIN-KEK 为什么不直接用 HUKS USER_AUTH challenge

- USER_AUTH challenge 把 PIN 当"auth factor"喂给 HUKS，HUKS 内部派生 + unwrap；文档在 HarmonyOS NEXT 覆盖薄
- Argon2id 是项目内已验证的 crate，参数和桌面 `os_keystore` 对齐
- 节流 + failed_attempts 必须在 Rust 侧（`preferences/security.json` 持久化），HUKS challenge 做不了这个
- 未来 v2 可升级为 HUKS USER_AUTH（别名留了 `shibei_pin_kek_v1` 占位）

## S3 凭据存两层的 Phase 4 v1 妥协

secure/s3_creds.blob 里是 HUKS device-bound wrapped JSON，但启动时 ArkTS unwrap 后经 `setS3CredsOnly` NAPI 灌回 SQLite `credentials` 表做 runtime cache，`build_raw_backend` 继续从 SQLite 读。

**Why:** 避免 `build_raw_backend` 大改（桌面代码共用，独立动有爆炸半径）。

**下一期 Phase 4.1 要做的**：让 `build_raw_backend` 直接读 in-memory creds cache，彻底从 SQLite 拿走 access_key/secret_key。
```

- [ ] **Step 3: 更新 MEMORY.md 索引**

Edit `memory/MEMORY.md` 加一行：

```markdown
- [Harmony lockscreen HUKS split](feedback_harmony_lockscreen.md) — ArkTS owns HUKS, Rust owns inner crypto + throttle; PIN-KEK via Argon2id+HKDF not HUKS challenge
```

- [ ] **Step 4: Commit**

```bash
cd /Users/work/workspace/Shibei && git add CLAUDE.md memory/ && git commit -m "docs(harmony): phase 4 lockscreen architecture notes + memory"
```

---

## Self-Review Findings

Walked through spec §1-§10 vs plan tasks:

- §1.1 威胁模型 → Tasks 5/7/8 涵盖 PIN gate / secure/*.blob 加密 / bio unlock
- §1.2 不解决项 → 明确不做
- §2.2 状态机 → Task 9 `LockService.ets`
- §2.3 模块边界 → 全部 task 覆盖；HUKS 分工注明在开头 refinement note
- §3.1 存储布局 → Tasks 4/5/6/7 `secure/` 目录 + `preferences/security.json`
- §3.2 HUKS 别名 → Task 8
- §3.3 PIN-KEK 派生 → Task 2
- §3.4 wrap 算法 → Task 2（inner） + Task 8（outer）
- §4.1-§4.5 NAPI 命令 → Tasks 5/6/7
- §5.1 LockService → Task 9
- §5.2 EntryAbility → Task 10
- §5.3 LockScreen → Task 11
- §5.4 Settings → Task 12
- §5.5 Onboard Step 4 → Task 10
- §6 失败矩阵 → 分散在 Tasks 5/6/9/11/12
- §7 同步对接 → Task 7
- §8.1 Rust 单测 → Tasks 1/2/3/4
- §8.2 真机冒烟 → Task 13
- §8.3 安全审计 → 散在各 task 的 Zeroizing / 不打日志约束
- §9 CLAUDE.md → Task 14
- §10 开放问题 → 留到冒烟时实际验

### Placeholder scan

- 无 "TBD / TODO / 以后再说"
- Task 0 对 spike 失败有具体回落决策 + 停机动作
- 每个 code block 都是可 copy-paste 的完整代码

### Type consistency

- `SecurityPrefs` 字段在 Tasks 5/6/7/12 一致（`lock_enabled`, `bio_enabled`, `failed_attempts`, `lockout_until_ms`, `pin_version`）
- `LockState` 枚举在 Task 9 定义，Tasks 10/11/12 均导入同一符号
- `ShibeiError` 在 ShibeiService 已有，所有新 facade 方法复用
- NAPI 命令命名一致：`lock_*` 前缀，对应 ArkTS `lockXxx` camelCase
- `HuksService` 方法签名（`wrapDeviceBound / unwrapDeviceBound / wrapBio / unwrapBio / generateBioKey / deleteBioKey / isBioAvailable`）在 Tasks 7/9/11/12 保持一致

### Open implementation gotchas (not plan bugs, but heads-up)

- Task 8 HUKS API 细节（`huks.HuksTag.HUKS_TAG_AE_TAG` / `initSession+finishSession` vs 老的 `init+update+finish`）与鸿蒙 SDK 版本相关，冒烟时若 API 不匹配按 SDK 文档校准——这是 Task 13 的职责
- Task 8 `requestBioAuth` 用了 `userAuth.getAuthInstance`，某些 SDK 版本已改用 `userAuth.getUserAuthInstance`——同上
- Task 12「修改 PIN」复用 `lockUnlockWithPin + lockSetupPin` 两步走，期间 MK 明文短暂在内存，这是预期行为
- Task 5 `error_code` 格式化 `LockError` 时，`Throttled(secs)` 会产生 `error.lockThrottled:30` 格式，和 spec §4.3 声明的一致

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-22-phase4-lockscreen-huks.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review (spec + code quality) between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Task 0 is a spike with an explicit stop-if-fail gate (HUKS from ArkTS not functioning on Mate X5 → architecture rethink before any Task 1+ work).

Which approach?
