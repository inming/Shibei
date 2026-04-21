//! Rust FFI binding renderer.
//!
//! Emits `src-harmony-napi/generated/bindings.rs`, an `extern "C"` layer that:
//!   - for sync fns: marshals C-side args into Rust types, calls the user fn,
//!     returns by value (primitives) or leaks a CString (strings)
//!   - for async fns: spawns the user's async fn on the global tokio runtime
//!     and, when done, calls back into C via `shibei_async_resolve`
//!   - for event fns: calls the user fn with a synthetic
//!     `ThreadsafeCallback<T>` whose `call` delegates to `shibei_event_emit_i64`

use crate::parse::{Command, Kind, ScalarType};
use std::fmt::Write;

pub fn render(commands: &[Command]) -> String {
    let mut out = String::new();
    emit_header(&mut out);
    emit_prelude(&mut out);
    for cmd in commands {
        match cmd.kind {
            Kind::Sync => emit_sync(&mut out, cmd),
            Kind::Async => emit_async(&mut out, cmd),
            Kind::Event => emit_event(&mut out, cmd),
        }
    }
    out
}

fn emit_header(out: &mut String) {
    out.push_str("// GENERATED — do not edit by hand.\n");
    out.push_str("// Run `cargo run -p shibei-napi-codegen` after editing commands.rs.\n\n");
    // Inner attributes (`#![...]`) are forbidden inside `include!`d files,
    // so clippy lint allows are pushed to lib.rs instead.
}

fn emit_prelude(out: &mut String) {
    out.push_str(r#"// Note: this file is `include!`d directly into src-harmony-napi/src/lib.rs,
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

"#);
}

fn emit_sync(out: &mut String, cmd: &Command) {
    let rust_name = &cmd.rust_ident;
    let ffi_params = cmd.args.iter()
        .map(|a| format!("{}: {}", a.rust_name, ffi_param_ty(a.ty)))
        .collect::<Vec<_>>().join(", ");
    let ret = ffi_ret_ty(cmd.ret);
    let _ = writeln!(out, "#[no_mangle]");
    let _ = writeln!(out, "pub unsafe extern \"C\" fn shibei_ffi_{rust_name}({ffi_params}) -> {ret} {{");
    // Build user-fn call
    let user_args = cmd.args.iter().map(|a| match a.ty {
        ScalarType::String => format!("cstr_to_string({})", a.rust_name),
        _ => a.rust_name.clone(),
    }).collect::<Vec<_>>().join(", ");
    match cmd.ret {
        ScalarType::String => {
            let _ = writeln!(out, "    let s = crate::commands::{rust_name}({user_args});");
            let _ = writeln!(out, "    leak_cstring(s)");
        }
        ScalarType::I32 | ScalarType::I64 | ScalarType::Bool => {
            let _ = writeln!(out, "    crate::commands::{rust_name}({user_args})");
        }
        ScalarType::VoidReturn => {
            let _ = writeln!(out, "    crate::commands::{rust_name}({user_args});");
        }
    }
    let _ = writeln!(out, "}}\n");
}

fn emit_async(out: &mut String, cmd: &Command) {
    let rust_name = &cmd.rust_ident;
    let mut params = cmd.args.iter()
        .map(|a| format!("{}: {}", a.rust_name, ffi_param_ty(a.ty)))
        .collect::<Vec<_>>();
    params.push("ctx: *mut c_void".to_string());
    let _ = writeln!(out, "#[no_mangle]");
    let _ = writeln!(out, "pub unsafe extern \"C\" fn shibei_ffi_{rust_name}({}) {{", params.join(", "));
    // Capture args into owned values so we can send across threads.
    for a in &cmd.args {
        match a.ty {
            ScalarType::String => {
                let _ = writeln!(out, "    let {0} = cstr_to_string({0});", a.rust_name);
            }
            _ => {
                // primitives are Copy — move them as-is
            }
        }
    }
    let _ = writeln!(out, "    let ctx_addr = ctx as usize;");
    let user_args = cmd.args.iter().map(|a| a.rust_name.clone()).collect::<Vec<_>>().join(", ");
    let _ = writeln!(out, "    runtime().spawn(async move {{");
    let _ = writeln!(out, "        let result = crate::commands::{rust_name}({user_args}).await;");
    let _ = writeln!(out, "        let ctx = ctx_addr as *mut c_void;");
    // result: Result<T, _>. For now we only support T = String; both Ok/Err
    // carry a string payload.
    match cmd.ret {
        ScalarType::String => {
            let _ = writeln!(out, "        match result {{");
            let _ = writeln!(out, "            Ok(s) => {{");
            let _ = writeln!(out, "                let c = CString::new(s).unwrap_or_default();");
            let _ = writeln!(out, "                unsafe {{ shibei_async_resolve(ctx, 1, c.as_ptr()); }}");
            let _ = writeln!(out, "            }}");
            let _ = writeln!(out, "            Err(e) => {{");
            let _ = writeln!(out, "                let c = CString::new(e.to_string()).unwrap_or_default();");
            let _ = writeln!(out, "                unsafe {{ shibei_async_resolve(ctx, 0, c.as_ptr()); }}");
            let _ = writeln!(out, "            }}");
            let _ = writeln!(out, "        }}");
        }
        _ => {
            let _ = writeln!(out, "        // Async codegen for non-String returns not implemented yet.");
            let _ = writeln!(out, "        let _ = result;");
            let _ = writeln!(out, "        unsafe {{ shibei_async_resolve(ctx, 0, std::ptr::null()); }}");
        }
    }
    let _ = writeln!(out, "    }});");
    let _ = writeln!(out, "}}\n");
}

fn emit_event(out: &mut String, cmd: &Command) {
    let rust_name = &cmd.rust_ident;
    let mut params = cmd.args.iter()
        .map(|a| format!("{}: {}", a.rust_name, ffi_param_ty(a.ty)))
        .collect::<Vec<_>>();
    params.push("ctx: *mut c_void".to_string());
    let _ = writeln!(out, "#[no_mangle]");
    let _ = writeln!(out, "pub unsafe extern \"C\" fn shibei_ffi_{rust_name}({}) -> *mut c_void {{", params.join(", "));
    // Build an Arc<AtomicBool> cancel flag + store it in a Box we return as the
    // subscription token (round-trips through C as opaque void*).
    let _ = writeln!(out, "    let cancel = Arc::new(AtomicBool::new(false));");
    let _ = writeln!(out, "    let cb = crate::runtime::ThreadsafeCallback::<{}>::new(ctx, cancel.clone(), |ctx, v| {{ shibei_event_emit_i64(ctx, v); }});", cmd.ret_scalar_rust());
    let user_args = cmd.args.iter().map(|a| a.rust_name.clone())
        .chain(std::iter::once("cb".to_string()))
        .collect::<Vec<_>>().join(", ");
    let _ = writeln!(out, "    let _sub: crate::runtime::Subscription = crate::commands::{rust_name}({user_args});");
    let _ = writeln!(out, "    // Ownership: cancel flag's Arc is returned as the C token.");
    let _ = writeln!(out, "    Arc::into_raw(cancel) as *mut c_void");
    let _ = writeln!(out, "}}\n");

    let _ = writeln!(out, "#[no_mangle]");
    let _ = writeln!(out, "pub unsafe extern \"C\" fn shibei_ffi_{rust_name}_unsubscribe(token: *mut c_void) {{");
    let _ = writeln!(out, "    if token.is_null() {{ return; }}");
    let _ = writeln!(out, "    let cancel = unsafe {{ Arc::from_raw(token as *const AtomicBool) }};");
    let _ = writeln!(out, "    cancel.store(true, Ordering::SeqCst);");
    let _ = writeln!(out, "}}\n");
}

fn ffi_param_ty(ty: ScalarType) -> &'static str {
    match ty {
        ScalarType::I32 => "i32",
        ScalarType::I64 => "i64",
        ScalarType::Bool => "bool",
        ScalarType::String => "*const c_char",
        ScalarType::VoidReturn => "()",
    }
}

fn ffi_ret_ty(ty: ScalarType) -> &'static str {
    match ty {
        ScalarType::I32 => "i32",
        ScalarType::I64 => "i64",
        ScalarType::Bool => "bool",
        ScalarType::String => "*mut c_char",
        ScalarType::VoidReturn => "()",
    }
}

impl Command {
    fn ret_scalar_rust(&self) -> &'static str {
        match self.ret {
            ScalarType::I32 => "i32",
            ScalarType::I64 => "i64",
            ScalarType::Bool => "bool",
            ScalarType::String => "String",
            ScalarType::VoidReturn => "()",
        }
    }
}
