//! C NAPI shim renderer.
//!
//! Emits a standalone `shim.c` (replaces the old hand-rolled one) that:
//!   - registers the module `shibei_core`
//!   - marshals each annotated fn from JS into a fixed Rust FFI symbol
//!     (see bindings.rs) and back
//!
//! The ABI between C and Rust is deliberately minimal: all non-primitive data
//! passes through NUL-terminated C strings (arg strings with a 4 KiB cap; ret
//! strings are heap-allocated by Rust, printed by C, then freed via a single
//! shared `shibei_ffi_free_cstring`). Async/event callbacks carry a `void*`
//! context pointer produced by C and opaque to Rust.

use crate::parse::{Command, Kind, ScalarType};
use std::fmt::Write;

pub fn render(commands: &[Command]) -> String {
    let mut out = String::new();
    emit_header(&mut out);
    emit_extern_decls(&mut out, commands);
    emit_wrappers(&mut out, commands);
    emit_module_init(&mut out, commands);
    out
}

fn emit_header(out: &mut String) {
    out.push_str("// GENERATED — do not edit by hand.\n");
    out.push_str("// Run `cargo run -p shibei-napi-codegen` after editing commands.rs.\n\n");
    out.push_str("#include \"napi/native_api.h\"\n");
    out.push_str("#include <stddef.h>\n");
    out.push_str("#include <stdint.h>\n");
    out.push_str("#include <stdlib.h>\n");
    out.push_str("#include <string.h>\n\n");
    out.push_str("// Rust-owned heap string; pair every returning pointer with a free.\n");
    out.push_str("extern void shibei_ffi_free_cstring(char* p);\n\n");
}

fn emit_extern_decls(out: &mut String, commands: &[Command]) {
    out.push_str("// ── Rust FFI entry points (see generated/bindings.rs) ─────────────\n");
    for cmd in commands {
        match cmd.kind {
            Kind::Sync => emit_sync_extern(out, cmd),
            Kind::Async => emit_async_extern(out, cmd),
            Kind::Event => emit_event_extern(out, cmd),
        }
    }
    // Shared callback from Rust → C for async completion + event fire.
    out.push_str("\n// C callbacks invoked from Rust worker threads.\n");
    out.push_str("void shibei_async_resolve(void* ctx, int ok, const char* payload);\n");
    out.push_str("void shibei_event_emit_i64(void* ctx, int64_t payload);\n");
    out.push('\n');
}

fn emit_sync_extern(out: &mut String, cmd: &Command) {
    let params = cmd.args.iter()
        .map(|a| format!("{} {}", c_arg_type(a.ty), a.rust_name))
        .collect::<Vec<_>>().join(", ");
    let params = if params.is_empty() { "void".to_string() } else { params };
    let _ = writeln!(
        out,
        "extern {} shibei_ffi_{}({params});",
        c_ret_type(cmd.ret),
        cmd.rust_ident,
    );
}

fn emit_async_extern(out: &mut String, cmd: &Command) {
    let mut params: Vec<String> = cmd.args.iter()
        .map(|a| format!("{} {}", c_arg_type(a.ty), a.rust_name))
        .collect();
    params.push("void* ctx".to_string());
    let _ = writeln!(
        out,
        "extern void shibei_ffi_{}({});",
        cmd.rust_ident,
        params.join(", "),
    );
}

fn emit_event_extern(out: &mut String, cmd: &Command) {
    // Rust signature: scalar args + void* ctx → void* subscription_token
    let mut params: Vec<String> = cmd.args.iter()
        .map(|a| format!("{} {}", c_arg_type(a.ty), a.rust_name))
        .collect();
    params.push("void* ctx".to_string());
    let _ = writeln!(
        out,
        "extern void* shibei_ffi_{}({});",
        cmd.rust_ident,
        params.join(", "),
    );
    let _ = writeln!(
        out,
        "extern void shibei_ffi_{}_unsubscribe(void* token);",
        cmd.rust_ident,
    );
}

fn emit_wrappers(out: &mut String, commands: &[Command]) {
    out.push_str("// ── Shared async plumbing ─────────────────────────────────────────\n");
    out.push_str(ASYNC_CTX_SNIPPET);

    out.push_str("\n// ── Shared event plumbing (i64 payload) ───────────────────────────\n");
    out.push_str(EVENT_CTX_SNIPPET);

    out.push_str("\n// ── Per-command NAPI wrappers ─────────────────────────────────────\n");
    // Forward declarations so event fns can reference their unsubscribe
    // wrapper ahead of its definition.
    for cmd in commands {
        if cmd.kind == Kind::Event {
            let _ = writeln!(
                out,
                "static napi_value {}_unsubscribe_wrap(napi_env env, napi_callback_info info);",
                cmd.rust_ident
            );
        }
    }
    out.push('\n');
    for cmd in commands {
        match cmd.kind {
            Kind::Sync => emit_sync_wrapper(out, cmd),
            Kind::Async => emit_async_wrapper(out, cmd),
            Kind::Event => emit_event_wrapper(out, cmd),
        }
        out.push('\n');
    }
}

fn emit_sync_wrapper(out: &mut String, cmd: &Command) {
    let mut w = String::new();
    let _ = writeln!(w, "static napi_value {}_wrap(napi_env env, napi_callback_info info) {{", cmd.rust_ident);
    let n = cmd.args.len();
    if n == 0 {
        let _ = writeln!(w, "    (void)info;");
    }
    if n > 0 {
        let _ = writeln!(w, "    size_t argc = {n};");
        let _ = writeln!(w, "    napi_value args[{n}] = {{0}};");
        let _ = writeln!(w, "    napi_get_cb_info(env, info, &argc, args, NULL, NULL);");
        for (i, a) in cmd.args.iter().enumerate() {
            match a.ty {
                ScalarType::String => {
                    let _ = writeln!(w, "    char buf_{}[4096] = {{0}};", a.rust_name);
                    let _ = writeln!(w, "    if ({i} < argc) {{ size_t len = 0; napi_get_value_string_utf8(env, args[{i}], buf_{}, sizeof(buf_{}), &len); }}", a.rust_name, a.rust_name);
                }
                ScalarType::I32 => {
                    let _ = writeln!(w, "    int32_t v_{} = 0; if ({i} < argc) napi_get_value_int32(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
                }
                ScalarType::I64 => {
                    let _ = writeln!(w, "    int64_t v_{} = 0; if ({i} < argc) napi_get_value_int64(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
                }
                ScalarType::Bool => {
                    let _ = writeln!(w, "    bool v_{} = false; if ({i} < argc) napi_get_value_bool(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
                }
                ScalarType::VoidReturn => unreachable!("void in argument position"),
            }
        }
    }

    let call_args = cmd.args.iter().map(|a| match a.ty {
        ScalarType::String => format!("buf_{}", a.rust_name),
        _ => format!("v_{}", a.rust_name),
    }).collect::<Vec<_>>().join(", ");

    let _ = writeln!(w, "    napi_value result = NULL;");
    match cmd.ret {
        ScalarType::String => {
            let _ = writeln!(w, "    char* ret = shibei_ffi_{}({call_args});", cmd.rust_ident);
            let _ = writeln!(w, "    napi_create_string_utf8(env, ret ? ret : \"\", NAPI_AUTO_LENGTH, &result);");
            let _ = writeln!(w, "    if (ret) shibei_ffi_free_cstring(ret);");
        }
        ScalarType::I32 => {
            let _ = writeln!(w, "    int32_t ret = shibei_ffi_{}({call_args});", cmd.rust_ident);
            let _ = writeln!(w, "    napi_create_int32(env, ret, &result);");
        }
        ScalarType::I64 => {
            let _ = writeln!(w, "    int64_t ret = shibei_ffi_{}({call_args});", cmd.rust_ident);
            let _ = writeln!(w, "    napi_create_int64(env, ret, &result);");
        }
        ScalarType::Bool => {
            let _ = writeln!(w, "    bool ret = shibei_ffi_{}({call_args});", cmd.rust_ident);
            let _ = writeln!(w, "    napi_get_boolean(env, ret, &result);");
        }
        ScalarType::VoidReturn => {
            let _ = writeln!(w, "    shibei_ffi_{}({call_args});", cmd.rust_ident);
            let _ = writeln!(w, "    napi_get_undefined(env, &result);");
        }
    }
    let _ = writeln!(w, "    return result;");
    let _ = writeln!(w, "}}");
    out.push_str(&w);
}

fn emit_async_wrapper(out: &mut String, cmd: &Command) {
    let mut w = String::new();
    let _ = writeln!(w, "static napi_value {}_wrap(napi_env env, napi_callback_info info) {{", cmd.rust_ident);
    let n = cmd.args.len();
    let _ = writeln!(w, "    size_t argc = {n};");
    if n > 0 {
        let _ = writeln!(w, "    napi_value args[{n}] = {{0}};");
    } else {
        let _ = writeln!(w, "    napi_value* args = NULL;");
    }
    let _ = writeln!(w, "    napi_get_cb_info(env, info, &argc, args, NULL, NULL);");
    for (i, a) in cmd.args.iter().enumerate() {
        match a.ty {
            ScalarType::String => {
                let _ = writeln!(w, "    char buf_{}[4096] = {{0}};", a.rust_name);
                let _ = writeln!(w, "    if ({i} < argc) {{ size_t len = 0; napi_get_value_string_utf8(env, args[{i}], buf_{}, sizeof(buf_{}), &len); }}", a.rust_name, a.rust_name);
            }
            ScalarType::I32 => {
                let _ = writeln!(w, "    int32_t v_{} = 0; if ({i} < argc) napi_get_value_int32(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
            }
            ScalarType::I64 => {
                let _ = writeln!(w, "    int64_t v_{} = 0; if ({i} < argc) napi_get_value_int64(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
            }
            ScalarType::Bool => {
                let _ = writeln!(w, "    bool v_{} = false; if ({i} < argc) napi_get_value_bool(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
            }
            ScalarType::VoidReturn => unreachable!(),
        }
    }

    let _ = writeln!(w, "    AsyncCtx* ctx = (AsyncCtx*)calloc(1, sizeof(AsyncCtx));");
    let _ = writeln!(w, "    napi_value promise = NULL;");
    let _ = writeln!(w, "    napi_create_promise(env, &ctx->deferred, &promise);");
    let _ = writeln!(w, "    napi_value res_name = NULL;");
    let _ = writeln!(w, "    napi_create_string_utf8(env, \"{}_tsfn\", NAPI_AUTO_LENGTH, &res_name);", cmd.js_name);
    let _ = writeln!(w, "    napi_create_threadsafe_function(env, NULL, NULL, res_name, 0, 1, NULL, NULL, NULL, async_complete_cb, &ctx->tsfn);");
    let call_args = cmd.args.iter().map(|a| match a.ty {
        ScalarType::String => format!("buf_{}", a.rust_name),
        _ => format!("v_{}", a.rust_name),
    }).chain(std::iter::once("ctx".to_string())).collect::<Vec<_>>().join(", ");
    let _ = writeln!(w, "    shibei_ffi_{}({call_args});", cmd.rust_ident);
    let _ = writeln!(w, "    return promise;");
    let _ = writeln!(w, "}}");
    out.push_str(&w);
}

fn emit_event_wrapper(out: &mut String, cmd: &Command) {
    // Arg positions: scalar args first, JS callback last.
    let mut w = String::new();
    let _ = writeln!(w, "static napi_value {}_wrap(napi_env env, napi_callback_info info) {{", cmd.rust_ident);
    let n = cmd.args.len() + 1; // +1 for JS cb
    let _ = writeln!(w, "    size_t argc = {n};");
    let _ = writeln!(w, "    napi_value args[{n}] = {{0}};");
    let _ = writeln!(w, "    napi_get_cb_info(env, info, &argc, args, NULL, NULL);");
    for (i, a) in cmd.args.iter().enumerate() {
        match a.ty {
            ScalarType::I64 => {
                let _ = writeln!(w, "    int64_t v_{} = 0; if ({i} < argc) napi_get_value_int64(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
            }
            ScalarType::I32 => {
                let _ = writeln!(w, "    int32_t v_{} = 0; if ({i} < argc) napi_get_value_int32(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
            }
            ScalarType::Bool => {
                let _ = writeln!(w, "    bool v_{} = false; if ({i} < argc) napi_get_value_bool(env, args[{i}], &v_{});", a.rust_name, a.rust_name);
            }
            ScalarType::String => {
                let _ = writeln!(w, "    char buf_{}[4096] = {{0}};", a.rust_name);
                let _ = writeln!(w, "    if ({i} < argc) {{ size_t len = 0; napi_get_value_string_utf8(env, args[{i}], buf_{}, sizeof(buf_{}), &len); }}", a.rust_name, a.rust_name);
            }
            ScalarType::VoidReturn => unreachable!(),
        }
    }
    let cb_idx = cmd.args.len();
    let _ = writeln!(w, "    EventCtx* ctx = (EventCtx*)calloc(1, sizeof(EventCtx));");
    let _ = writeln!(w, "    napi_value res_name = NULL;");
    let _ = writeln!(w, "    napi_create_string_utf8(env, \"{}_tsfn\", NAPI_AUTO_LENGTH, &res_name);", cmd.js_name);
    let _ = writeln!(w, "    napi_create_threadsafe_function(env, args[{cb_idx}], NULL, res_name, 0, 1, NULL, NULL, NULL, event_i64_cb, &ctx->tsfn);");
    let call_args = cmd.args.iter().map(|a| match a.ty {
        ScalarType::String => format!("buf_{}", a.rust_name),
        _ => format!("v_{}", a.rust_name),
    }).chain(std::iter::once("ctx".to_string())).collect::<Vec<_>>().join(", ");
    let _ = writeln!(w, "    ctx->token = shibei_ffi_{}({call_args});", cmd.rust_ident);
    let _ = writeln!(w, "    // Return a JS fn that unsubscribes when invoked.");
    let _ = writeln!(w, "    napi_value unsubscribe = NULL;");
    let _ = writeln!(w, "    napi_create_function(env, \"unsubscribe\", NAPI_AUTO_LENGTH, {}_unsubscribe_wrap, ctx, &unsubscribe);", cmd.rust_ident);
    let _ = writeln!(w, "    return unsubscribe;");
    let _ = writeln!(w, "}}");
    let _ = writeln!(w);
    // The unsubscribe wrapper:
    let _ = writeln!(w, "static napi_value {}_unsubscribe_wrap(napi_env env, napi_callback_info info) {{", cmd.rust_ident);
    let _ = writeln!(w, "    void* data = NULL;");
    let _ = writeln!(w, "    napi_get_cb_info(env, info, NULL, NULL, NULL, &data);");
    let _ = writeln!(w, "    EventCtx* ctx = (EventCtx*)data;");
    let _ = writeln!(w, "    if (ctx && ctx->token) {{");
    let _ = writeln!(w, "        shibei_ffi_{}_unsubscribe(ctx->token);", cmd.rust_ident);
    let _ = writeln!(w, "        ctx->token = NULL;");
    let _ = writeln!(w, "        napi_release_threadsafe_function(ctx->tsfn, napi_tsfn_release);");
    let _ = writeln!(w, "    }}");
    let _ = writeln!(w, "    napi_value undef = NULL; napi_get_undefined(env, &undef); return undef;");
    let _ = writeln!(w, "}}");
    out.push_str(&w);
}

fn emit_module_init(out: &mut String, commands: &[Command]) {
    out.push_str("// ── Module registration ───────────────────────────────────────────\n");
    // The module-init callback is named `shibei_register_exports`, not `init`,
    // so it can't possibly collide with a `#[shibei_napi] fn init()` command
    // that we also want to export under the JS name "init".
    out.push_str("static napi_value shibei_register_exports(napi_env env, napi_value exports) {\n");
    out.push_str("    napi_property_descriptor props[] = {\n");
    for cmd in commands {
        let _ = writeln!(
            out,
            "        {{\"{}\", NULL, {}_wrap, NULL, NULL, NULL, napi_default, NULL}},",
            cmd.js_name, cmd.rust_ident,
        );
    }
    out.push_str("    };\n");
    out.push_str("    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);\n");
    out.push_str("    return exports;\n}\n\n");

    out.push_str(r#"static napi_module shibei_module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = NULL,
    .nm_register_func = shibei_register_exports,
    .nm_modname = "shibei_core",
    .nm_priv = NULL,
    .reserved = {NULL, NULL, NULL, NULL},
};

__attribute__((used, constructor))
void register_shibei_core(void) {
    napi_module_register(&shibei_module);
}
"#);
}

fn c_ret_type(ty: ScalarType) -> &'static str {
    match ty {
        ScalarType::I32 => "int32_t",
        ScalarType::I64 => "int64_t",
        ScalarType::Bool => "bool",
        ScalarType::String => "char*",
        ScalarType::VoidReturn => "void",
    }
}

fn c_arg_type(ty: ScalarType) -> &'static str {
    match ty {
        ScalarType::I32 => "int32_t",
        ScalarType::I64 => "int64_t",
        ScalarType::Bool => "bool",
        ScalarType::String => "const char*",
        ScalarType::VoidReturn => "void",
    }
}

const ASYNC_CTX_SNIPPET: &str = r#"typedef struct {
    napi_threadsafe_function tsfn;
    napi_deferred deferred;
    char* payload;   // strdup'd by shibei_async_resolve, freed by completion cb
    int ok;
} AsyncCtx;

// Called by Rust from a tokio worker thread.
void shibei_async_resolve(void* ctx_ptr, int ok, const char* payload) {
    AsyncCtx* ctx = (AsyncCtx*)ctx_ptr;
    ctx->ok = ok;
    ctx->payload = payload ? strdup(payload) : NULL;
    napi_call_threadsafe_function(ctx->tsfn, ctx, napi_tsfn_nonblocking);
}

static void async_complete_cb(napi_env env, napi_value js_cb, void* ctx_ptr, void* data) {
    (void)js_cb; (void)ctx_ptr;
    AsyncCtx* ctx = (AsyncCtx*)data;
    napi_value value = NULL;
    napi_create_string_utf8(env, ctx->payload ? ctx->payload : "", NAPI_AUTO_LENGTH, &value);
    if (ctx->ok) napi_resolve_deferred(env, ctx->deferred, value);
    else         napi_reject_deferred(env, ctx->deferred, value);
    if (ctx->payload) free(ctx->payload);
    napi_release_threadsafe_function(ctx->tsfn, napi_tsfn_release);
    free(ctx);
}
"#;

const EVENT_CTX_SNIPPET: &str = r#"typedef struct {
    napi_threadsafe_function tsfn;
    void* token;  // opaque Rust subscription handle
} EventCtx;

typedef struct { int64_t value; } I64Payload;

// Called by Rust worker thread to fire a single i64 event.
void shibei_event_emit_i64(void* ctx_ptr, int64_t payload) {
    EventCtx* ctx = (EventCtx*)ctx_ptr;
    I64Payload* p = (I64Payload*)malloc(sizeof(I64Payload));
    p->value = payload;
    napi_call_threadsafe_function(ctx->tsfn, p, napi_tsfn_nonblocking);
}

static void event_i64_cb(napi_env env, napi_value js_cb, void* ctx_ptr, void* data) {
    (void)ctx_ptr;
    I64Payload* p = (I64Payload*)data;
    napi_value v = NULL;
    napi_create_int64(env, p->value, &v);
    napi_value undef = NULL; napi_get_undefined(env, &undef);
    napi_value ret = NULL;
    napi_call_function(env, undef, js_cb, 1, &v, &ret);
    free(p);
}
"#;
