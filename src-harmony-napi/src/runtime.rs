//! Minimal runtime types that `#[shibei_napi(event)]` commands reference.
//!
//! The codegen-produced `generated/bindings.rs` constructs a
//! `ThreadsafeCallback<T>::new(ctx, cancel, emit_fn)` for each call and passes
//! it into the user fn. The user fn owns the callback + the returned
//! `Subscription`; background workers periodically call `cb.call(value)`
//! which delegates to the injected `emit_fn` (a C shim function such as
//! `shibei_event_emit_i64`). When ArkTS invokes the unsubscribe fn the C
//! shim flips the shared cancel flag, and the Rust background worker
//! observes it on the next tick to stop emitting.

use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Handle the user fn uses to deliver a value to ArkTS.
pub struct ThreadsafeCallback<T> {
    ctx: *mut c_void,
    cancel: Arc<AtomicBool>,
    emit: unsafe fn(*mut c_void, T),
}

// Safety: the C-side tsfn handle and the cancel flag are both thread-safe;
// crossing a tokio thread boundary is required for every event use case.
unsafe impl<T: Send> Send for ThreadsafeCallback<T> {}
unsafe impl<T: Send> Sync for ThreadsafeCallback<T> {}

impl<T: Send> ThreadsafeCallback<T> {
    /// Constructed by generated FFI bindings. Do not call from user code.
    pub fn new(
        ctx: *mut c_void,
        cancel: Arc<AtomicBool>,
        emit: unsafe fn(*mut c_void, T),
    ) -> Self {
        Self { ctx, cancel, emit }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Schedules `payload` for delivery on the ArkTS thread. Non-blocking.
    /// For `T = String` the emit closure converts to a CString which is
    /// strdup'd by C before returning, so the caller's String is safely
    /// dropped when this fn unwinds.
    pub fn call(&self, payload: T) {
        if self.is_cancelled() {
            return;
        }
        unsafe { (self.emit)(self.ctx, payload) };
    }
}

/// Marker value returned from `#[shibei_napi(event)]` fns. The real cancel
/// signal lives on the shared `Arc<AtomicBool>` stored inside the callback;
/// this type exists solely to keep the user fn's signature honest.
pub struct Subscription;

impl Subscription {
    pub fn new() -> Self {
        Self
    }
}

impl Default for Subscription {
    fn default() -> Self {
        Self::new()
    }
}
