//! NAPI codegen for HarmonyOS NEXT.
//!
//! Reads `src-harmony-napi/src/commands.rs`, finds `#[shibei_napi]` / `_napi(async)`
//! / `_napi(event)` functions, and writes three artifacts under `src-harmony-napi/generated/`
//! and `shibei-harmony/entry/types/libshibei_core/`:
//!
//!   generated/shim.c     — hand-rolled-equivalent N-API wrapper for each fn
//!   generated/bindings.rs — Rust extern "C" side invoked by the shim
//!   ../types/Index.d.ts   — ArkTS type declarations
//!
//! Run manually after editing commands.rs:
//!     cargo run -p shibei-napi-codegen
//! CI guards drift via `git diff --exit-code` on the generated tree.

use std::fs;
use std::path::{Path, PathBuf};

mod parse;
mod render_bindings;
mod render_dts;
mod render_shim;

use parse::{Command, Kind};

fn main() {
    let manifest_dir = env_path("CARGO_MANIFEST_DIR");
    // crates/shibei-napi-codegen → repo root
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root two levels up")
        .to_path_buf();

    let source_file = repo_root.join("src-harmony-napi/src/commands.rs");
    let source = fs::read_to_string(&source_file)
        .unwrap_or_else(|e| panic!("read {}: {e}", source_file.display()));

    let commands = parse::parse_commands(&source)
        .unwrap_or_else(|e| panic!("parse {}: {e}", source_file.display(), ));

    if commands.is_empty() {
        eprintln!("warning: no #[shibei_napi]-annotated functions found in commands.rs");
    }

    let generated_dir = repo_root.join("src-harmony-napi/generated");
    fs::create_dir_all(&generated_dir).expect("create generated/");
    let dts_dir = repo_root.join("shibei-harmony/entry/types/libshibei_core");
    fs::create_dir_all(&dts_dir).expect("create types/libshibei_core/");

    let shim = render_shim::render(&commands);
    write_if_changed(&generated_dir.join("shim.c"), &shim);

    let bindings = render_bindings::render(&commands);
    write_if_changed(&generated_dir.join("bindings.rs"), &bindings);

    let dts = render_dts::render(&commands);
    write_if_changed(&dts_dir.join("Index.d.ts"), &dts);

    print_summary(&commands);
}

fn env_path(key: &str) -> PathBuf {
    PathBuf::from(std::env::var(key).unwrap_or_else(|_| panic!("${key} not set")))
}

fn write_if_changed(path: &Path, content: &str) {
    let prev = fs::read_to_string(path).unwrap_or_default();
    if prev == content {
        println!("unchanged: {}", path.display());
    } else {
        fs::write(path, content).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
        println!("wrote:     {}", path.display());
    }
}

fn print_summary(commands: &[Command]) {
    println!("\n{} command(s) generated:", commands.len());
    for cmd in commands {
        let kind = match cmd.kind {
            Kind::Sync => "sync ",
            Kind::Async => "async",
            Kind::Event => "event",
        };
        println!("  [{kind}] {}", cmd.rust_ident);
    }
}
