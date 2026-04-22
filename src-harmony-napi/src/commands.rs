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

/// Must be the very first command ArkTS calls, with:
///   - `data_dir`: the per-app sandbox path, e.g.
///     `/data/storage/el2/base/haps/entry/files`
///   - `ca_bundle_path`: absolute path of a cacert.pem that ArkTS has
///     already copied out of the HAP's `resources/rawfile/ca-bundle.pem`
///     into the sandbox (see `app/CaBundle.ets`). We export SSL_CERT_FILE
///     to that path so hyper-rustls finds a trust store.
///
/// Idempotent across redundant dev-reload calls.
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
pub fn init_app(data_dir: String, ca_bundle_path: String) -> String {
    match state::init(
        std::path::PathBuf::from(data_dir),
        std::path::PathBuf::from(ca_bundle_path),
    ) {
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

/// Factory-reset this device: wipes all business-table rows (resources /
/// folders / tags / annotations / sync_log / sync_state), deletes cached
/// snapshots on disk, and clears the in-memory Master Key. The DB schema
/// and the AppState singleton itself stay intact — subsequent commands
/// work without re-running `initApp`.
///
/// Returns "ok" on success, `error.*` string on failure. Invoked from
/// Settings → 数据 → 重置设备 after a confirmation dialog. Next cold
/// start will land on Onboard because `hasSavedConfig()` is driven off
/// `config:s3_bucket`, which gets cleared here.
#[shibei_napi]
pub fn reset_device() -> String {
    match reset_device_inner() {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}

fn reset_device_inner() -> Result<(), String> {
    // 1) Clear in-memory encryption state first so that, if anything below
    // fails, we don't leave an app that can still sync with the old MK.
    state::lock_vault();

    // 2) Wipe all user-owned rows in a single transaction. We enumerate
    // tables via sqlite_master rather than hardcoding the list so a future
    // migration's new table can't silently be left behind.
    let app = state::get()?;
    {
        let pool = app
            .db_pool
            .read()
            .map_err(|e| format!("error.poolPoisoned: {e}"))?;
        let mut conn = pool.get().map_err(|e| format!("error.dbConn: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("error.txBegin: {e}"))?;
        // `_content`, `_data`, `_idx`, `_docsize`, `_config` are FTS5 shadow
        // tables — clearing them directly corrupts the index; DELETE FROM
        // `search_index` (the virtual table) cascades correctly.
        let names: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT name FROM sqlite_master \
                     WHERE type='table' \
                     AND name NOT LIKE 'sqlite_%' \
                     AND name NOT LIKE '%\\_content' ESCAPE '\\' \
                     AND name NOT LIKE '%\\_data' ESCAPE '\\' \
                     AND name NOT LIKE '%\\_idx' ESCAPE '\\' \
                     AND name NOT LIKE '%\\_docsize' ESCAPE '\\' \
                     AND name NOT LIKE '%\\_config' ESCAPE '\\'",
                )
                .map_err(|e| format!("error.enumTables: {e}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("error.enumTables: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("error.enumTables: {e}"))?
        };
        for name in &names {
            // DELETE rather than DROP so the schema (+ migrations state)
            // stays intact. Table names come from sqlite_master — no
            // user input, safe to interpolate.
            tx.execute(&format!(r#"DELETE FROM "{}""#, name), [])
                .map_err(|e| format!("error.wipeTable({name}): {e}"))?;
        }
        tx.commit().map_err(|e| format!("error.txCommit: {e}"))?;
    }

    // 3) Remove the on-disk snapshot cache. Sync will re-download on demand.
    // Tolerate NotFound — first-time reset on a fresh install has no dir.
    let storage_dir = app.data_dir.join("storage");
    if storage_dir.exists() {
        std::fs::remove_dir_all(&storage_dir)
            .map_err(|e| format!("error.wipeStorage: {e}"))?;
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────
// Pairing QR decrypt (shared with Onboard Step 3)
// ────────────────────────────────────────────────────────────

/// Decrypt a Phase 1 pairing envelope (scanned from desktop QR) using the
/// 6-digit PIN the user types. Returns a JSON string shaped like
/// `{"version":1, "endpoint":"...", "region":"...", "bucket":"...",
///   "access_key":"...", "secret_key":"..."}` on success — callers can
/// feed it straight into setS3Config after camelCase remapping.
///
/// Errors:
///   error.pairingBadPin      — PIN wrong (XChaCha20-Poly1305 AEAD fail)
///   error.pairingBadEnvelope — envelope JSON malformed / version mismatch
#[shibei_napi]
pub fn decrypt_pairing_payload(pin: String, envelope_json: String) -> String {
    match shibei_pairing::decrypt_payload(&pin, &envelope_json) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(e) => format!(r#"{{"error":"error.pairingBadEnvelope: {e}"}}"#),
        },
        Err(shibei_pairing::PairingError::DecryptFailed) => {
            r#"{"error":"error.pairingBadPin"}"#.to_string()
        }
        Err(e) => format!(r#"{{"error":"error.pairingBadEnvelope: {e}"}}"#),
    }
}

// ────────────────────────────────────────────────────────────
// S3 config + E2EE unlock + sync (Track A4 batch 1 + 3)
// ────────────────────────────────────────────────────────────

/// Persist S3 endpoint/region/bucket + credentials. Mirrors desktop
/// `cmd_save_sync_config`. Does not touch the network; safe to call with
/// placeholder values during onboarding form validation.
///
/// Input is a JSON object `{"endpoint","region","bucket","accessKey","secretKey"}`
/// to keep the NAPI ABI one-string-in, one-string-out. Empty endpoint → AWS.
#[shibei_napi]
pub fn set_s3_config(config_json: String) -> String {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        endpoint: Option<String>,
        region: String,
        bucket: String,
        access_key: String,
        secret_key: String,
    }
    let input: Input = match serde_json::from_str(&config_json) {
        Ok(v) => v,
        Err(e) => return format!("error.badConfigJson: {e}"),
    };
    let result = with_conn(|conn| {
        shibei_sync::sync_state::set(conn, "config:s3_endpoint", input.endpoint.as_deref().unwrap_or(""))?;
        shibei_sync::sync_state::set(conn, "config:s3_region", &input.region)?;
        shibei_sync::sync_state::set(conn, "config:s3_bucket", &input.bucket)?;
        shibei_sync::credentials::store_credentials(conn, &input.access_key, &input.secret_key)?;
        Ok(())
    });
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}

/// Fetch `meta/keyring.json` from S3, Argon2id-derive the wrapping key from
/// `password`, unwrap the Master Key, and cache it in AppState. After this,
/// syncMetadata can run with E2EE enabled. Mirrors desktop
/// `cmd_unlock_encryption` minus the `config:encryption_sync_completed`
/// reset (mobile first-sync semantics handled by syncMetadata itself).
#[shibei_napi(async)]
pub async fn set_e2ee_password(password: String) -> Result<String, String> {
    use shibei_sync::backend::SyncBackend;

    let backend = build_raw_backend().map_err(|e| format!("error.buildBackend: {e}"))?;
    let data = backend
        .download("meta/keyring.json")
        .await
        .map_err(|e| format!("error.keyDownloadFailed: {e}"))?;
    let json = String::from_utf8(data).map_err(|e| format!("error.keyFileFormatError: {e}"))?;
    let keyring =
        shibei_sync::keyring::Keyring::from_json(&json).map_err(|e| format!("error.keyFileParseFailed: {e}"))?;

    let mk = keyring.unlock(&password).map_err(|e| match e {
        shibei_sync::keyring::KeyringError::WrongPassword => "error.wrongPassword".to_string(),
        shibei_sync::keyring::KeyringError::Tampered => "error.keyFileTampered".to_string(),
        other => format!("error.unlockFailed: {other}"),
    })?;

    let app = state::get()?;
    app.encryption.set_key(mk);
    with_conn(|conn| shibei_sync::sync_state::set(conn, "config:encryption_enabled", "true"))?;
    Ok("ok".to_string())
}

/// Run one pass of SyncEngine against the local DB. Uploads pending
/// sync_log entries, pulls remote JSONL + snapshot manifest, applies with
/// LWW. Returns a JSON SyncResult on success or an error.* string.
///
/// Emits `{phase,current,total}` progress JSON to any active
/// `subscribeSyncProgress` listener. A final `{"phase":"done",…}` tick is
/// sent on success — the UI uses it to hide the progress bar.
///
/// Requires setS3Config called at least once AND (if the remote bucket has
/// `meta/keyring.json`) setE2EEPassword called successfully this session.
#[shibei_napi(async)]
pub async fn sync_metadata() -> Result<String, String> {
    let engine = build_sync_engine().await?;
    let cb: shibei_sync::engine::ProgressCallback = Box::new(|phase, current, total| {
        crate::progress::emit(phase, current, total);
    });
    let result = engine
        .sync(Some(&cb))
        .await
        .map_err(|e| format!("error.syncFailed: {e}"))?;
    crate::progress::emit("done", 0, 0);
    Ok(to_json(&result))
}

/// Subscribe to sync-progress events. The callback fires whenever the
/// sync engine advances through a phase (uploading / downloading / applying
/// snapshots), with a final `{"phase":"done"}` tick when syncMetadata
/// returns Ok. Payload is JSON: `{"phase":"<str>","current":N,"total":N}`.
/// Returns an unsubscribe fn; Demo 12 / Onboard call it on page unmount.
///
/// Last-subscriber-wins: if two listeners subscribe, only the newer one
/// receives events. In practice only one UI is showing progress at a time.
#[shibei_napi(event)]
pub fn subscribe_sync_progress(cb: ThreadsafeCallback<String>) -> Subscription {
    crate::progress::set(std::sync::Arc::new(cb));
    Subscription::new()
}

fn build_raw_backend() -> Result<shibei_sync::backend::S3Backend, String> {
    let (endpoint, region, bucket, access_key, secret_key) = with_conn(|conn| {
        let endpoint = shibei_sync::sync_state::get(conn, "config:s3_endpoint")?.unwrap_or_default();
        let region = shibei_sync::sync_state::get(conn, "config:s3_region")?
            .ok_or_else(|| shibei_db::DbError::NotFound("config:s3_region".into()))?;
        let bucket = shibei_sync::sync_state::get(conn, "config:s3_bucket")?
            .ok_or_else(|| shibei_db::DbError::NotFound("config:s3_bucket".into()))?;
        let (ak, sk) = shibei_sync::credentials::load_credentials(conn)?
            .ok_or_else(|| shibei_db::DbError::NotFound("credentials".into()))?;
        Ok((endpoint, region, bucket, ak, sk))
    })?;
    let cfg = shibei_sync::backend::S3Config {
        endpoint: if endpoint.is_empty() { None } else { Some(endpoint) },
        region,
        bucket,
        access_key,
        secret_key,
    };
    shibei_sync::backend::S3Backend::new(cfg).map_err(|e| format!("error.s3Init: {e}"))
}

async fn build_sync_engine() -> Result<shibei_sync::engine::SyncEngine, String> {
    use shibei_sync::backend::SyncBackend;
    use std::sync::Arc;

    let raw = build_raw_backend()?;
    let app = state::get()?;

    let local_e2ee = with_conn(|conn| shibei_sync::sync_state::get(conn, "config:encryption_enabled"))
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false);

    let encryption_enabled = if local_e2ee {
        true
    } else {
        raw.head("meta/keyring.json").await.map(|m| m.is_some()).unwrap_or(false)
    };

    let backend: Arc<dyn SyncBackend> = if encryption_enabled {
        let mk = app
            .encryption
            .get_key()
            .ok_or_else(|| "error.encryptionNotUnlocked".to_string())?;
        Arc::new(shibei_sync::encrypted_backend::EncryptedBackend::new(Arc::new(raw), mk))
    } else {
        Arc::new(raw)
    };

    let clock = Arc::new(shibei_db::hlc::HlcClock::new(app.device_id.clone()));

    Ok(shibei_sync::engine::SyncEngine::new(
        app.db_pool.clone(),
        backend,
        app.device_id.clone(),
        clock,
        app.data_dir.clone(),
    ))
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
/// PDF still running backfill, sync-apply before re-index) OR when the
/// resource doesn't exist (stale deep link, soft-deleted) — same null-
/// folding policy as `get_resource`, so the UI can render a blank
/// preview without a special-case try/catch.
#[shibei_napi]
pub fn get_resource_summary(id: String, max_chars: i32) -> String {
    let limit = if max_chars <= 0 { 200 } else { max_chars as usize };
    let result = with_conn(|conn| match shibei_db::resources::get_plain_text(conn, &id) {
        Ok(v) => Ok(v),
        Err(shibei_db::DbError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    });
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
// Reader (Phase 3a)
// ────────────────────────────────────────────────────────────

/// Returns the snapshot HTML for a resource with the mobile annotator
/// injected into `<head>`. Script tags from the original page are stripped
/// first (same policy as desktop — `strip_script_tags`) so page JS can't
/// mutate the DOM on load and break anchor offsets.
///
/// Returns the HTML string, or `error.*` prefixed string on failure.
/// ArkTS checks `starts_with("error.")` before feeding to WebView.
///
/// The `annotator-mobile.js` content is embedded at compile time via
/// `include_str!`. The HAP ships a copy in `rawfile/` for reference
/// but this NAPI version is the one actually injected.
const ANNOTATOR_MOBILE_JS: &str = include_str!("../annotator-mobile.js");

#[shibei_napi]
pub fn get_resource_html(id: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.notInitialized: {e}"),
    };
    let html_path = app
        .data_dir
        .join("storage")
        .join(&id)
        .join("snapshot.html");
    let html = match std::fs::read_to_string(&html_path) {
        Ok(s) => s,
        Err(e) => return format!("error.snapshotNotFound: {e}"),
    };
    // Strip page scripts, then inject the annotator.
    strip_scripts_and_inject(&html)
}

fn strip_scripts_and_inject(html: &str) -> String {
    let stripped = strip_script_tags(html);
    let override_css = "<style>*{-webkit-user-select:text!important;user-select:text!important;}</style>";
    let script_tag = format!("{}<script>{}</script>", override_css, ANNOTATOR_MOBILE_JS);
    if let Some(pos) = stripped.find("</head>") {
        let mut r = stripped;
        r.insert_str(pos, &script_tag);
        r
    } else if let Some(pos) = stripped.find("<body") {
        let mut r = stripped;
        r.insert_str(pos, &script_tag);
        r
    } else {
        format!("{}{}", script_tag, stripped)
    }
}

/// Strip `<script …>…</script>` blocks. Matches only when the char after
/// "<script" is `>`, `/`, or ASCII whitespace. Copy of desktop lib.rs logic.
fn strip_script_tags(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let hit = match find_ci(bytes, cursor, b"<script") {
            Some(p) => p,
            None => break,
        };
        let after = hit + 7;
        let boundary = after >= bytes.len()
            || matches!(
                bytes[after],
                b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | 0x0c
            );
        if !boundary {
            out.push_str(&html[cursor..hit + 1]);
            cursor = hit + 1;
            continue;
        }
        out.push_str(&html[cursor..hit]);
        let open_end = match bytes[after..].iter().position(|&b| b == b'>') {
            Some(p) => after + p + 1,
            None => {
                cursor = bytes.len();
                break;
            }
        };
        let close_hit = match find_ci(bytes, open_end, b"</script") {
            Some(p) => p,
            None => {
                cursor = bytes.len();
                break;
            }
        };
        let close_end = match bytes[close_hit + 8..].iter().position(|&b| b == b'>') {
            Some(p) => close_hit + 8 + p + 1,
            None => {
                cursor = bytes.len();
                break;
            }
        };
        cursor = close_end;
    }
    if cursor < bytes.len() {
        out.push_str(&html[cursor..]);
    }
    out
}

fn find_ci(haystack: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || start >= haystack.len() {
        return None;
    }
    let mut i = start;
    while i + needle.len() <= haystack.len() {
        let mut ok = true;
        for j in 0..needle.len() {
            let a = haystack[i + j].to_ascii_lowercase();
            let b = needle[j].to_ascii_lowercase();
            if a != b {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(i);
        }
        i += 1;
    }
    None
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
