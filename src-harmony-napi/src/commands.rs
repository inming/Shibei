//! Commands exported to ArkTS. Each `#[shibei_napi]`-annotated fn in this
//! file is picked up by `crates/shibei-napi-codegen` which generates the
//! C shim, Rust FFI bindings, and ArkTS `.d.ts` declarations.
//!
//! Supported attribute forms:
//!   #[shibei_napi]                    — synchronous; args/ret are scalars
//!   #[shibei_napi(async)]             — async fn; returns `Result<T, String>`
//!                                        → JS Promise<T> | rejection(string)
//!   #[shibei_napi(event)]             — takes `cb: ThreadsafeCallback<T>`;
//!                                        returns `Subscription`. ArkTS gets
//!                                        back an unsubscribe fn.
//!
//! After editing, run:
//!     cargo run -p shibei-napi-codegen
//! and commit both `commands.rs` AND the regenerated `generated/` /
//! `shibei-harmony/entry/types/libshibei_core/Index.d.ts` output.

use shibei_napi_macros::shibei_napi;

use crate::runtime::{Subscription, ThreadsafeCallback};
use crate::state;

// ────────────────────────────────────────────────────────────
// Lifecycle (Track A3)
// ────────────────────────────────────────────────────────────

/// Must be the very first command ArkTS calls, with the per-app sandbox path
/// (e.g. `/data/storage/el2/base/haps/entry/files`). Idempotent across
/// redundant dev-reload calls.
///
/// Returns `ok` on success, or `error.*` on failure. We return `String` (not
/// `Result<String, String>`) to keep this command sync — async-codegen's
/// error branch would require Promise plumbing, overkill for a fn that runs
/// exactly once per process lifetime.
///
/// JS name: `initApp`. The shorter form `init` is rejected by the ArkTS
/// module linker on HarmonyOS NEXT (2026-04-21 Mate X5, Demo 9 regression);
/// empirically the ES-module bootstrap reserves that identifier.
#[shibei_napi]
pub fn init_app(data_dir: String) -> String {
    match state::init(std::path::PathBuf::from(data_dir)) {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}

/// True once `init` has produced a usable `AppState`. ArkTS can gate its
/// first query on this, or simply assume init completed (since Onboard/Lock
/// won't render otherwise).
#[shibei_napi]
pub fn is_initialized() -> bool {
    state::get().is_ok()
}

/// True if S3 config has been persisted (Onboard completed once). ArkTS
/// uses this on cold start to decide Onboard vs Lock/Library.
#[shibei_napi]
pub fn has_saved_config() -> bool {
    state::has_saved_config()
}

/// True if the Master Key is cached in memory (user completed setE2EEPassword
/// at least once this session).
#[shibei_napi]
pub fn is_unlocked() -> bool {
    state::is_unlocked()
}

/// Forget the Master Key. Next operation requiring MK (sync / snapshot
/// download) will need the user to unlock again.
#[shibei_napi]
pub fn lock_vault() {
    state::lock_vault();
}

// ────────────────────────────────────────────────────────────
// Queries (Track A4 batch 2)
//
// Complex return types (Vec<Folder>, Option<Resource>, Vec<SearchResult>,
// …) are serialized to JSON strings here because the codegen's scalar
// support is limited to String/i32/i64/bool. ArkTS side JSON.parse on
// receipt. When Track A5 extends codegen to struct support, callers can
// switch to direct struct returns with no API churn.
// ────────────────────────────────────────────────────────────

fn with_conn<T>(op: impl FnOnce(&rusqlite::Connection) -> Result<T, shibei_db::DbError>) -> Result<T, String> {
    let app = state::get()?;
    let pool = app.db_pool.read().map_err(|e| format!("error.poolPoisoned: {e}"))?;
    let conn = pool.get().map_err(|e| format!("error.dbConn: {e}"))?;
    op(&conn).map_err(|e| format!("error.db: {e}"))
}

fn to_json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| format!(r#"{{"error":"serialize: {e}"}}"#))
}

fn parse_tag_ids(tag_ids_json: &str) -> Vec<String> {
    if tag_ids_json.is_empty() || tag_ids_json == "null" {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(tag_ids_json).unwrap_or_default()
}

fn parse_sort(sort_json: &str) -> (shibei_db::resources::SortBy, shibei_db::resources::SortOrder) {
    use shibei_db::resources::{SortBy, SortOrder};
    #[derive(serde::Deserialize)]
    struct SortInput {
        #[serde(default)]
        by: Option<String>,
        #[serde(default)]
        order: Option<String>,
    }
    let parsed: SortInput =
        serde_json::from_str(sort_json).unwrap_or(SortInput { by: None, order: None });
    let by = match parsed.by.as_deref() {
        Some("annotated_at") => SortBy::AnnotatedAt,
        _ => SortBy::CreatedAt,
    };
    let order = match parsed.order.as_deref() {
        Some("asc") | Some("ASC") => SortOrder::Asc,
        _ => SortOrder::Desc,
    };
    (by, order)
}

/// Returns the whole active folder tree in one flat Vec<Folder>; ArkTS
/// rebuilds the hierarchy via the parent_id field. Empty DB → `[]`.
#[shibei_napi]
pub fn list_folders() -> String {
    match with_conn(shibei_db::folders::list_all) {
        Ok(list) => to_json(&list),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

/// `tag_ids_json` — JSON array of tag-id strings ("", "null", "[]" = no filter).
/// `sort_json` — `{"by":"created_at"|"annotated_at","order":"asc"|"desc"}` or "".
/// Special folder_id `"__all__"` aggregates across every folder.
#[shibei_napi]
pub fn list_resources(folder_id: String, tag_ids_json: String, sort_json: String) -> String {
    use shibei_db::resources::{list_all_resources, list_resources_by_folder};
    let tag_ids = parse_tag_ids(&tag_ids_json);
    let (sort_by, sort_order) = parse_sort(&sort_json);
    let result = with_conn(|conn| {
        if folder_id == "__all__" {
            list_all_resources(conn, sort_by, sort_order, &tag_ids)
        } else {
            list_resources_by_folder(conn, &folder_id, sort_by, sort_order, &tag_ids)
        }
    });
    match result {
        Ok(list) => to_json(&list),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

/// Full-text search (FTS5 trigram ≥ 3 chars, LIKE fallback for shorter
/// queries). Sort hard-coded to `created_at DESC` for Phase 2; mobile UI
/// doesn't expose sort controls on search results. `[]` on empty query.
#[shibei_napi]
pub fn search_resources(query: String, tag_ids_json: String) -> String {
    let tag_ids = parse_tag_ids(&tag_ids_json);
    let result = with_conn(|conn| {
        shibei_db::search::search_resources(conn, &query, None, &tag_ids, "created_at", "desc")
    });
    match result {
        Ok(list) => to_json(&list),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

#[shibei_napi]
pub fn list_tags() -> String {
    match with_conn(shibei_db::tags::list_tags) {
        Ok(list) => to_json(&list),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

/// Returns `{"resource": Resource} | {"resource": null}`. ArkTS callers
/// JSON.parse and read `.resource`. Not-found is a normal condition
/// (stale deep link, soft-deleted entry) so we fold it to null.
#[shibei_napi]
pub fn get_resource(id: String) -> String {
    let result = with_conn(|conn| match shibei_db::resources::get_resource(conn, &id) {
        Ok(r) => Ok(Some(r)),
        Err(shibei_db::DbError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    });
    match result {
        Ok(opt) => format!(r#"{{"resource":{}}}"#, to_json(&opt)),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

/// Plain-text prefix of the indexed body. `max_chars <= 0` → default 200;
/// empty string when plain_text hasn't been extracted yet (fresh import,
/// PDF still running backfill, sync-apply before re-index).
#[shibei_napi]
pub fn get_resource_summary(id: String, max_chars: i32) -> String {
    let limit = if max_chars <= 0 { 200 } else { max_chars as usize };
    let result = with_conn(|conn| shibei_db::resources::get_plain_text(conn, &id));
    match result {
        Ok(Some(text)) => {
            let total = text.chars().count();
            let prefix: String = text.chars().take(limit).collect();
            if total > limit {
                format!("{prefix}...")
            } else {
                prefix
            }
        }
        Ok(None) => String::new(),
        Err(e) => format!("error:{e}"),
    }
}

// ────────────────────────────────────────────────────────────
// Sync examples (migrated from Phase 0 hand-rolled shim)
// ────────────────────────────────────────────────────────────

#[shibei_napi]
pub fn hello() -> String {
    "hello from rust, os=ohos, arch=aarch64".to_string()
}

#[shibei_napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[shibei_napi]
pub fn s3_smoke_test(
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
) -> String {
    crate::s3_smoke::run(&endpoint, &region, &bucket, &access_key, &secret_key)
}

// ────────────────────────────────────────────────────────────
// Async example (new for Phase 2 / Track A1)
// ────────────────────────────────────────────────────────────

/// Sleeps briefly to prove the Promise threadsafe plumbing works end-to-end,
/// then echoes back the input. The sleep also exercises the tokio runtime.
#[shibei_napi(async)]
pub async fn echo_async(text: String) -> Result<String, String> {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    Ok(format!("echo:{}", text))
}

// ────────────────────────────────────────────────────────────
// Event example (new for Phase 2 / Track A1)
// ────────────────────────────────────────────────────────────

/// Emits the current tick counter every `interval_ms` milliseconds until the
/// ArkTS-side unsubscribe fn is invoked. Single threadsafe_function per
/// subscription; the Rust worker observes the cancel flag and exits.
#[shibei_napi(event)]
pub fn on_tick(interval_ms: i64, cb: ThreadsafeCallback<i64>) -> Subscription {
    let interval = std::time::Duration::from_millis(interval_ms.max(1) as u64);
    std::thread::spawn(move || {
        let mut n: i64 = 0;
        loop {
            if cb.is_cancelled() {
                break;
            }
            cb.call(n);
            n += 1;
            std::thread::sleep(interval);
        }
    });
    Subscription::new()
}
