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
    fn shibei_event_emit_string(ctx: *mut c_void, payload: *const c_char);
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
pub unsafe extern "C" fn shibei_ffi_init_app(data_dir: *const c_char) -> *mut c_char {
    let s = crate::commands::init_app(cstr_to_string(data_dir));
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_is_initialized() -> bool {
    crate::commands::is_initialized()
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_has_saved_config() -> bool {
    crate::commands::has_saved_config()
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_is_unlocked() -> bool {
    crate::commands::is_unlocked()
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_lock_vault() -> () {
    crate::commands::lock_vault();
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_decrypt_pairing_payload(pin: *const c_char, envelope_json: *const c_char) -> *mut c_char {
    let s = crate::commands::decrypt_pairing_payload(cstr_to_string(pin), cstr_to_string(envelope_json));
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_set_s3_config(config_json: *const c_char) -> *mut c_char {
    let s = crate::commands::set_s3_config(cstr_to_string(config_json));
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_set_e2ee_password(password: *const c_char, ctx: *mut c_void) {
    let password = cstr_to_string(password);
    let ctx_addr = ctx as usize;
    runtime().spawn(async move {
        let result = crate::commands::set_e2ee_password(password).await;
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
pub unsafe extern "C" fn shibei_ffi_sync_metadata(ctx: *mut c_void) {
    let ctx_addr = ctx as usize;
    runtime().spawn(async move {
        let result = crate::commands::sync_metadata().await;
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
pub unsafe extern "C" fn shibei_ffi_subscribe_sync_progress(ctx: *mut c_void) -> *mut c_void {
    let cancel = Arc::new(AtomicBool::new(false));
    let cb = crate::runtime::ThreadsafeCallback::<String>::new(ctx, cancel.clone(), |ctx, v: String| { let c = CString::new(v).unwrap_or_default(); shibei_event_emit_string(ctx, c.as_ptr()); });
    let _sub: crate::runtime::Subscription = crate::commands::subscribe_sync_progress(cb);
    // Ownership: cancel flag's Arc is returned as the C token.
    Arc::into_raw(cancel) as *mut c_void
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_subscribe_sync_progress_unsubscribe(token: *mut c_void) {
    if token.is_null() { return; }
    let cancel = unsafe { Arc::from_raw(token as *const AtomicBool) };
    cancel.store(true, Ordering::SeqCst);
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_list_folders() -> *mut c_char {
    let s = crate::commands::list_folders();
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_list_resources(folder_id: *const c_char, tag_ids_json: *const c_char, sort_json: *const c_char) -> *mut c_char {
    let s = crate::commands::list_resources(cstr_to_string(folder_id), cstr_to_string(tag_ids_json), cstr_to_string(sort_json));
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_search_resources(query: *const c_char, tag_ids_json: *const c_char) -> *mut c_char {
    let s = crate::commands::search_resources(cstr_to_string(query), cstr_to_string(tag_ids_json));
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_list_tags() -> *mut c_char {
    let s = crate::commands::list_tags();
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_get_resource(id: *const c_char) -> *mut c_char {
    let s = crate::commands::get_resource(cstr_to_string(id));
    leak_cstring(s)
}

#[no_mangle]
pub unsafe extern "C" fn shibei_ffi_get_resource_summary(id: *const c_char, max_chars: i32) -> *mut c_char {
    let s = crate::commands::get_resource_summary(cstr_to_string(id), max_chars);
    leak_cstring(s)
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

