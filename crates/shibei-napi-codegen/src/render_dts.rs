//! ArkTS .d.ts renderer.

use crate::parse::{Arg, Command, Kind, ScalarType};
use std::fmt::Write;

pub fn render(commands: &[Command]) -> String {
    let mut out = String::new();
    out.push_str("// GENERATED — do not edit by hand.\n");
    out.push_str("// Run `cargo run -p shibei-napi-codegen` after editing commands.rs.\n\n");

    for cmd in commands {
        match cmd.kind {
            Kind::Sync => render_sync(&mut out, cmd),
            Kind::Async => render_async(&mut out, cmd),
            Kind::Event => render_event(&mut out, cmd),
        }
    }
    out
}

fn render_sync(out: &mut String, cmd: &Command) {
    let _ = writeln!(
        out,
        "export const {}: ({}) => {};",
        cmd.js_name,
        fmt_args(&cmd.args),
        ts_ret(cmd.ret),
    );
}

fn render_async(out: &mut String, cmd: &Command) {
    let _ = writeln!(
        out,
        "export const {}: ({}) => Promise<{}>;",
        cmd.js_name,
        fmt_args(&cmd.args),
        ts_ret(cmd.ret),
    );
}

fn render_event(out: &mut String, cmd: &Command) {
    // Event fns: caller passes the non-cb scalar args + a callback; receive
    // an unsubscribe function as return.
    let cb_arg = format!("cb: (payload: {}) => void", ts_ret(cmd.ret));
    let all_args = if cmd.args.is_empty() {
        cb_arg
    } else {
        format!("{}, {cb_arg}", fmt_args(&cmd.args))
    };
    let _ = writeln!(out, "export const {}: ({all_args}) => () => void;", cmd.js_name);
}

fn fmt_args(args: &[Arg]) -> String {
    args.iter()
        .map(|a| format!("{}: {}", a.js_name, ts_ret(a.ty)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn ts_ret(ty: ScalarType) -> &'static str {
    match ty {
        ScalarType::I32 | ScalarType::I64 => "number",
        ScalarType::Bool => "boolean",
        ScalarType::String => "string",
        ScalarType::VoidReturn => "void",
    }
}
