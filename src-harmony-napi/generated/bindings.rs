// GENERATED — do not edit by hand.
// Run `cargo run -p shibei-napi-codegen` after editing commands.rs.

// Note: this file is `include!`d directly into src-harmony-napi/src/lib.rs,
// which already has `pub mod commands; pub mod runtime;`. Avoid `use
// crate::commands` here — that would shadow the submodule and cause E0255.
// Fully-qualified paths throughout instead.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Global tokio runtime used by every `#[shibei_napi(async)]` command.
/// 4 worker threads is plenty for Phase 2 / Phase 3 workloads; revisit if
/// sync throughput (first-time bulk apply_entries) becomes a bottleneck.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("tokio runtime build")
    })
}

extern "C" {
    fn shibei_async_resolve(ctx: *mut c_void, ok: c_int, payload: *const c_char);
    fn shibei_event_emit_i64(ctx: *mut c_void, payload: i64);
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_free_cstring(p: *mut c_char) {
    if !p.is_null() {
        drop(CString::from_raw(p));
    }
}

fn cstr_to_string(p: *const c_char) -> String {
    if p.is_null() { return String::new() }
    unsafe { CStr::from_ptr(p) }.to_str().unwrap_or("").to_owned()
}

fn leak_cstring(s: String) -> *mut c_char {
    CString::new(s).unwrap_or_default().into_raw()
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_hello() -> *mut c_char {
    let s = crate::commands::hello();
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_add(a: i32, b: i32) -> i32 {
    crate::commands::add(a, b)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_s3_smoke_test(endpoint: *const c_char, region: *const c_char, bucket: *const c_char, access_key: *const c_char, secret_key: *const c_char) -> *mut c_char {
    let s = crate::commands::s3_smoke_test(cstr_to_string(endpoint), cstr_to_string(region), cstr_to_string(bucket), cstr_to_string(access_key), cstr_to_string(secret_key));
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_echo_async(text: *const c_char, ctx: *mut c_void) {
    let text = cstr_to_string(text);
    let ctx_addr = ctx as usize;
    runtime().spawn(async move {
        let result = crate::commands::echo_async(text).await;
        let ctx = ctx_addr as *mut c_void;
        match result {
            Ok(s) => {
                let c = CString::new(s).unwrap_or_default();
                unsafe { shibei_async_resolve(ctx, 1, c.as_ptr()); }
            }
            Err(e) => {
                let c = CString::new(e.to_string()).unwrap_or_default();
                unsafe { shibei_async_resolve(ctx, 0, c.as_ptr()); }
            }
        }
    });
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_on_tick(interval_ms: i64, ctx: *mut c_void) -> *mut c_void {
    let cancel = Arc::new(AtomicBool::new(false));
    let cb = crate::runtime::ThreadsafeCallback::<i64>::new(ctx, cancel.clone(), |ctx, v| { shibei_event_emit_i64(ctx, v); });
    let _sub: crate::runtime::Subscription = crate::commands::on_tick(interval_ms, cb);
    // Ownership: cancel flag's Arc is returned as the C token.
    Arc::into_raw(cancel) as *mut c_void
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_on_tick_unsubscribe(token: *mut c_void) {
    if token.is_null() { return; }
    let cancel = unsafe { Arc::from_raw(token as *const AtomicBool) };
    cancel.store(true, Ordering::SeqCst);
}

