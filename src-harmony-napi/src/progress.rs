//! Global sync-progress sink.
//!
//! The event ABI (see `runtime::ThreadsafeCallback`) gives each subscriber
//! its own callback handle, but `syncMetadata` is a plain async command —
//! it doesn't know at call-time whether ArkTS has subscribed. This module
//! bridges the two: ArkTS calls `subscribeSyncProgress(cb)` once, which
//! stashes the callback here; `syncMetadata` reads the stash and feeds
//! `shibei_sync::engine::ProgressCallback` into it.
//!
//! Lifetime: a new subscribe replaces the stash (last-subscriber-wins —
//! only Demo 12 + Onboard will ever subscribe, and only one at a time).
//! When ArkTS invokes the returned unsubscribe fn, the codegen's cancel
//! flag flips and `ThreadsafeCallback::call` becomes a silent no-op, so
//! we don't have to actively clear the stash.

use std::sync::{Arc, Mutex, OnceLock};

use crate::runtime::ThreadsafeCallback;

type Sink = Arc<ThreadsafeCallback<String>>;

static SINK: OnceLock<Mutex<Option<Sink>>> = OnceLock::new();

fn cell() -> &'static Mutex<Option<Sink>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// Called by `subscribeSyncProgress` to register the active listener.
pub fn set(cb: Sink) {
    if let Ok(mut slot) = cell().lock() {
        *slot = Some(cb);
    }
}

/// Emit a progress tick. Silently drops if nothing is subscribed.
pub fn emit(phase: &str, current: usize, total: usize) {
    let Ok(slot) = cell().lock() else { return };
    if let Some(cb) = slot.as_ref() {
        let json = format!(r#"{{"phase":"{phase}","current":{current},"total":{total}}}"#);
        cb.call(json);
    }
}
