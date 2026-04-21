//! Commands exported to ArkTS. Each `#[shibei_napi]`-annotated fn in this
//! file is picked up by `crates/shibei-napi-codegen` which generates the
//! C shim, Rust FFI bindings, and ArkTS `.d.ts` declarations.
//!
//! Supported attribute forms:
//!   #[shibei_napi]                    — synchronous; args/ret are scalars
//!   #[shibei_napi(async)]             — async fn; returns `Result<T, String>`
//!                                        → JS Promise<T> | rejection(string)
//!   #[shibei_napi(event)]             — takes `cb: ThreadsafeCallback<T>`;
//!                                        returns `Subscription`. ArkTS gets
//!                                        back an unsubscribe fn.
//!
//! After editing, run:
//!     cargo run -p shibei-napi-codegen
//! and commit both `commands.rs` AND the regenerated `generated/` /
//! `shibei-harmony/entry/types/libshibei_core/Index.d.ts` output.

use shibei_napi_macros::shibei_napi;

use crate::runtime::{Subscription, ThreadsafeCallback};

// ────────────────────────────────────────────────────────────
// Sync examples (migrated from Phase 0 hand-rolled shim)
// ────────────────────────────────────────────────────────────

#[shibei_napi]
pub fn hello() -> String {
    "hello from rust, os=ohos, arch=aarch64".to_string()
}

#[shibei_napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[shibei_napi]
pub fn s3_smoke_test(
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
) -> String {
    crate::s3_smoke::run(&endpoint, &region, &bucket, &access_key, &secret_key)
}

// ────────────────────────────────────────────────────────────
// Async example (new for Phase 2 / Track A1)
// ────────────────────────────────────────────────────────────

/// Sleeps briefly to prove the Promise threadsafe plumbing works end-to-end,
/// then echoes back the input. The sleep also exercises the tokio runtime.
#[shibei_napi(async)]
pub async fn echo_async(text: String) -> Result<String, String> {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    Ok(format!("echo:{}", text))
}

// ────────────────────────────────────────────────────────────
// Event example (new for Phase 2 / Track A1)
// ────────────────────────────────────────────────────────────

/// Emits the current tick counter every `interval_ms` milliseconds until the
/// ArkTS-side unsubscribe fn is invoked. Single threadsafe_function per
/// subscription; the Rust worker observes the cancel flag and exits.
#[shibei_napi(event)]
pub fn on_tick(interval_ms: i64, cb: ThreadsafeCallback<i64>) -> Subscription {
    let interval = std::time::Duration::from_millis(interval_ms.max(1) as u64);
    std::thread::spawn(move || {
        let mut n: i64 = 0;
        loop {
            if cb.is_cancelled() {
                break;
            }
            cb.call(n);
            n += 1;
            std::thread::sleep(interval);
        }
    });
    Subscription::new()
}
