//! Marker attribute `#[shibei_napi]` / `#[shibei_napi(async)]` /
//! `#[shibei_napi(event)]`.
//!
//! At compile time this is a no-op — it just returns the annotated item
//! unchanged so rustc accepts it. The actual NAPI glue is produced by
//! `crates/shibei-napi-codegen/` which reads source files via `syn`, finds
//! these attributes, and writes C shim + Rust FFI bindings + ArkTS `.d.ts`
//! to `src-harmony-napi/generated/` (committed to git — see A1 plan).
//!
//! Keeping this as a marker rather than a macro that does work means:
//!   - annotated functions stay readable in rustdoc / IDE jump-to-def
//!   - codegen runs on-demand (`cargo run -p shibei-napi-codegen`) so diffs
//!     show up cleanly in review, not implicitly during every build
//!   - CI guards drift with `git diff --exit-code` after re-run.

use proc_macro::TokenStream;

/// No-op attribute. Accepts optional `async` or `event` metadata that the
/// codegen tool consumes.
#[proc_macro_attribute]
pub fn shibei_napi(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}
