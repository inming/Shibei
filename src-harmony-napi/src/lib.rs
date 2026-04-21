//! HarmonyOS NEXT native module for Shibei.
//!
//! Commands exported to ArkTS live in `commands.rs`, annotated with
//! `#[shibei_napi]`. The codegen tool at `crates/shibei-napi-codegen/` reads
//! that file and writes `generated/shim.c` + `generated/bindings.rs`, which
//! the build.rs compiles and this lib.rs includes respectively.
//!
//! See `docs/superpowers/plans/2026-04-21-phase2-skeleton.md` §4.1 for the
//! full codegen contract.

#![deny(clippy::all)]
#![allow(clippy::missing_safety_doc)]

pub mod commands;
pub mod progress;
pub mod runtime;
pub mod state;
mod s3_smoke;

include!("../generated/bindings.rs");
