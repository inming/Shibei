#![deny(clippy::all)]

// Plain extern "C" implementations exposed to a hand-written C NAPI shim
// (see src/shim.c). napi-rs's auto-bindings do not work under HarmonyOS NEXT
// as of 2026-04; Phase 0 fallback is manual N-API wrapping.

use std::ffi::c_char;

/// Returns a pointer to a static NUL-terminated C string describing the
/// runtime. Pointer is valid for the lifetime of the library.
#[no_mangle]
pub extern "C" fn shibei_hello() -> *const c_char {
    static GREETING: &[u8] = b"hello from rust, os=ohos, arch=aarch64\0";
    GREETING.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn shibei_add(a: i32, b: i32) -> i32 {
    a + b
}
