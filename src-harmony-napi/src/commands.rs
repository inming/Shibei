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
    // Also drop the Phase 4.1 RwLock'd S3 creds so the wiped bucket can't
    // be re-contacted with the old access keys.
    state::lock_vault();
    state::clear_s3_creds();

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
        // Re-seed the `__root__` pseudo-folder that migration 001 inserts.
        // Without it, the post-reset `ensure_inbox_folder` (on next
        // `init`) fails with `FOREIGN KEY constraint failed` because
        // `__inbox__.parent_id = '__root__'` points at a missing row.
        tx.execute(
            "INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at) \
             VALUES ('__root__', 'root', '__root__', 0, datetime('now'), datetime('now'))",
            [],
        )
        .map_err(|e| format!("error.reseedRoot: {e}"))?;
        tx.commit().map_err(|e| format!("error.txCommit: {e}"))?;
    }

    // 3) Remove the on-disk snapshot cache. Sync will re-download on demand.
    // Tolerate NotFound — first-time reset on a fresh install has no dir.
    let storage_dir = app.data_dir.join("storage");
    if storage_dir.exists() {
        std::fs::remove_dir_all(&storage_dir)
            .map_err(|e| format!("error.wipeStorage: {e}"))?;
    }

    // 4) Reset the LRU cache index — both the in-memory BTreeMap and the
    // on-disk cache-index.json. Keep the configured limit across resets.
    if let Ok(mut guard) = app.cache.lock() {
        let limit = guard.limit_bytes();
        *guard = shibei_storage::cache::CacheIndex::default();
        guard.set_limit(limit);
        if let Err(e) = guard.flush(&app.data_dir) {
            eprintln!("[cache] flush after reset failed: {e}");
        }
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
        Ok(())
    });
    if let Err(e) = result {
        return e;
    }
    // Phase 4.1: creds live only in the RwLock + HUKS blob on mobile, never
    // SQLite. ArkTS is responsible for calling `setS3CredsRuntime` after
    // this to populate the in-memory cache and `s3CredsWrite` to persist
    // the HUKS-wrapped copy.
    let Ok(app) = state::get() else {
        return "error.notInitialized".to_string();
    };
    if let Ok(mut guard) = app.s3_creds.write() {
        *guard = Some((input.access_key, input.secret_key));
    }
    "ok".to_string()
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

/// Clear `remote:*:last_seq` + `last_sync_at` so the next sync re-runs the
/// snapshot-import pass. Recovery for the snapshot-cursor bug where a fresh
/// device silently dropped JSONL entries written between the snapshot's T0
/// and the latest JSONL at first-sync time. Safe to call at any time — the
/// worst case is the next sync re-downloads state that's already present
/// (LWW handles dedup). Returns the number of rows removed.
#[shibei_napi]
pub fn reset_sync_cursors() -> i32 {
    match with_conn(shibei_sync::sync_state::reset_sync_cursors) {
        Ok(n) => n as i32,
        Err(_) => -1,
    }
}

/// Phase 4: expose for lock.rs recovery flow.
pub(crate) fn build_raw_backend_pub() -> Result<shibei_sync::backend::S3Backend, String> {
    build_raw_backend()
}

fn build_raw_backend() -> Result<shibei_sync::backend::S3Backend, String> {
    let app = state::get()?;
    // Non-secret S3 config stays in sync_state (bucket+region identify the
    // remote, not authenticate it). Only the keys move to the RwLock.
    let (endpoint, region, bucket) = with_conn(|conn| {
        let endpoint = shibei_sync::sync_state::get(conn, "config:s3_endpoint")?.unwrap_or_default();
        let region = shibei_sync::sync_state::get(conn, "config:s3_region")?
            .ok_or_else(|| shibei_db::DbError::NotFound("config:s3_region".into()))?;
        let bucket = shibei_sync::sync_state::get(conn, "config:s3_bucket")?
            .ok_or_else(|| shibei_db::DbError::NotFound("config:s3_bucket".into()))?;
        Ok((endpoint, region, bucket))
    })?;
    // Phase 4.1: credentials live in the AppState RwLock, populated by
    // `primeS3Creds` (cold start via HUKS unwrap) or `setS3Config` (first
    // pairing). `error.credentialsNotPrimed` fires if a sync path runs
    // before ArkTS had a chance to rehydrate — shouldn't normally happen
    // since EntryAbility calls primeS3Creds before unlocking.
    let guard = app.s3_creds.read().map_err(|_| "error.credentialsLockPoisoned".to_string())?;
    let (access_key, secret_key) = guard
        .as_ref()
        .ok_or_else(|| "error.credentialsNotPrimed".to_string())?
        .clone();
    drop(guard);
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
    use shibei_sync::engine::SyncOptions;
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

    // Mobile LRU cache wiring (§7.2). Capture just the pieces we need so the
    // callback doesn't reach back into the OnceLock every time.
    let cache = app.cache.clone();
    let base_dir = app.data_dir.clone();
    let pool = app.db_pool.clone();
    let on_saved: shibei_sync::engine::SnapshotSavedCallback = Arc::new(move |id, _rtype, bytes| {
        let mut evicted: Vec<String> = Vec::new();
        if let Ok(mut guard) = cache.lock() {
            guard.put(id, bytes);
            evicted = guard.evict_if_over_limit(&base_dir);
            if let Err(e) = guard.flush(&base_dir) {
                eprintln!("[cache] flush after put failed: {e}");
            }
        }
        // §7.5: when LRU drops a snapshot from disk, also drop its
        // `body_text` so FTS stops returning stale matches the user can't
        // click through to. Title/URL/highlight-text columns stay — the
        // user can still find + re-cache the resource by name.
        if !evicted.is_empty() {
            clear_body_text_for(&pool, &evicted);
        }
    });

    let options = SyncOptions {
        skip_proactive_snapshot_download: true,
        on_snapshot_saved: Some(on_saved),
    };

    Ok(shibei_sync::engine::SyncEngine::with_options(
        app.db_pool.clone(),
        backend,
        app.device_id.clone(),
        clock,
        app.data_dir.clone(),
        options,
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

// Mobile annotator script, embedded at compile time. The HAP rawfile/ copy
// is for reference only; this is what actually gets injected into the WebView.
const ANNOTATOR_MOBILE_JS: &str = include_str!("../annotator-mobile.js");

/// Returns the snapshot HTML for a resource with the mobile annotator
/// injected into `<head>`. Script tags from the original page are stripped
/// first (same policy as desktop — `strip_script_tags`) so page JS can't
/// mutate the DOM on load and break anchor offsets.
///
/// Returns the HTML string, or `error.*` prefixed string on failure.
/// ArkTS checks `starts_with("error.")` before feeding to WebView.
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
    touch_cache(&id);
    // Strip page scripts, then inject the annotator.
    strip_scripts_and_inject(&html)
}

/// Bump the LRU entry's last_access timestamp + flush index. Best-effort —
/// any failure is logged but swallowed so reads never fail on cache I/O.
fn touch_cache(id: &str) {
    let Ok(app) = state::get() else { return };
    let Ok(mut guard) = app.cache.lock() else { return };
    if !guard.contains(id) {
        // Snapshot exists on disk but we never put()-ed it (e.g. written
        // before §7.2 landed, or by a non-sync path). Register it now using
        // the actual file size so LRU accounting stays honest.
        let storage_dir = app.data_dir.join("storage").join(id);
        let bytes = snapshot_bytes_in_dir(&storage_dir);
        if bytes > 0 {
            guard.put(id, bytes);
        }
    } else {
        guard.touch(id);
    }
    if let Err(e) = guard.flush(&app.data_dir) {
        eprintln!("[cache] flush after touch failed: {e}");
    }
}

/// Clear `body_text` for the given resource ids and rebuild their FTS
/// entries. Used by §7.5: every time an LRU eviction drops a snapshot
/// from disk we also strip body_text so search stops matching content
/// the user can't open. Desktop doesn't use this (all snapshots stay).
fn clear_body_text_for(pool: &shibei_db::SharedPool, ids: &[String]) {
    let Ok(pool_read) = pool.read() else { return };
    let Ok(conn) = pool_read.get() else { return };
    for id in ids {
        let _ = shibei_db::resources::set_plain_text(&conn, id, "");
    }
}

/// Return the total size of snapshot.* files in a resource dir. Used when
/// we need to retrofit an entry that wasn't registered at download time.
fn snapshot_bytes_in_dir(dir: &std::path::Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let mut total: u64 = 0;
    for entry in rd.flatten() {
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if s.starts_with("snapshot.") {
            if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
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
// PDF Reader (Phase 3b)
// ────────────────────────────────────────────────────────────

/// Returns the raw PDF bytes for a resource as a base64 string (standard
/// alphabet, with padding). Empty string on any failure (not initialized,
/// file missing, read error). ArkTS callers decode with
/// `util.base64Helper.decode(...)` to Uint8Array.
///
/// The codegen's scalar ABI doesn't support `Vec<u8>` yet (Track A5), and
/// building out the length-prefixed buffer FFI path for one consumer is
/// premature — base64 overhead on a 10 MB PDF is ~50 ms / one extra copy,
/// acceptable for MVP. See `docs/superpowers/specs/2026-04-22-phase3b-pdf-support-design.md` §5.
///
/// Empty-on-error signals "not available" to the caller; ArkTS translates to
/// a "PDF 文件不存在" UI, same policy as `get_resource_html`'s error surface.
#[shibei_napi]
pub fn get_pdf_bytes(id: String) -> String {
    use base64::Engine;

    let app = match state::get() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("get_pdf_bytes: not initialized: {e}");
            return String::new();
        }
    };
    let pdf_path = app
        .data_dir
        .join("storage")
        .join(&id)
        .join("snapshot.pdf");
    match std::fs::read(&pdf_path) {
        Ok(bytes) => {
            touch_cache(&id);
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        }
        Err(e) => {
            eprintln!("get_pdf_bytes: read failed {}: {e}", pdf_path.display());
            String::new()
        }
    }
}

/// Ensure the local snapshot.pdf for a resource is present on disk; if
/// missing, pull it down via the S3 sync backend. Returns `"ok"` on success
/// (including the file-already-present fast path) or an `error.*` string on
/// failure.
///
/// Mirrors the desktop on-demand snapshot policy in `SyncEngine`. Requires
/// that `setS3Config` has run at least once AND (when the remote bucket has
/// `meta/keyring.json`) `setE2EEPassword` has run successfully this session —
/// same preconditions as `sync_metadata`.
#[shibei_napi(async)]
pub async fn ensure_pdf_downloaded(id: String) -> Result<String, String> {
    let app = state::get()?;
    let pdf_path = app
        .data_dir
        .join("storage")
        .join(&id)
        .join("snapshot.pdf");
    if pdf_path.exists() {
        touch_cache(&id);
        return Ok("ok".to_string());
    }
    let engine = build_sync_engine().await?;
    engine
        .download_snapshot(&id, "pdf")
        .await
        .map_err(|e| format!("error.downloadFailed: {e}"))?;
    Ok("ok".to_string())
}

/// Ensure the local snapshot.html is present, pulling from S3 if missing.
/// Symmetric to `ensure_pdf_downloaded`. Returns `"ok"` or `error.*`.
///
/// Mobile uses this as the gate before `get_resource_html` so the Reader can
/// lazily download HTML without the sync engine eagerly pulling everything.
#[shibei_napi(async)]
pub async fn ensure_html_downloaded(id: String) -> Result<String, String> {
    let app = state::get()?;
    let html_path = app
        .data_dir
        .join("storage")
        .join(&id)
        .join("snapshot.html");
    if html_path.exists() {
        touch_cache(&id);
        return Ok("ok".to_string());
    }
    let engine = build_sync_engine().await?;
    engine
        .download_snapshot(&id, "html")
        .await
        .map_err(|e| format!("error.downloadFailed: {e}"))?;
    Ok("ok".to_string())
}

// ────────────────────────────────────────────────────────────
// Cache management (§7.2)
// ────────────────────────────────────────────────────────────

/// `{ "totalBytes": u64, "limitBytes": u64, "entryCount": u64 }` JSON.
/// ArkTS uses this to drive the cache progress bar in Settings → 数据.
#[shibei_napi]
pub fn cache_stats() -> String {
    let Ok(app) = state::get() else {
        return r#"{"totalBytes":0,"limitBytes":0,"entryCount":0}"#.to_string();
    };
    let Ok(guard) = app.cache.lock() else {
        return r#"{"totalBytes":0,"limitBytes":0,"entryCount":0}"#.to_string();
    };
    let s = guard.stats();
    format!(
        r#"{{"totalBytes":{},"limitBytes":{},"entryCount":{}}}"#,
        s.total_bytes, s.limit_bytes, s.entry_count
    )
}

/// Return cached entries joined with resource metadata (title/url/type) so
/// the Settings 缓存管理 list can show human-readable rows. Sorted MRU-first.
/// Entries whose resource row has been hard-deleted are filtered out
/// (compaction can leave behind orphan snapshot files; LRU eventually
/// reclaims them). JSON shape:
///   [{ "resourceId":"..","title":"..","url":"..","resourceType":"pdf",
///      "bytes":12345,"lastAccessMs":17... }]
#[shibei_napi]
pub fn cache_list() -> String {
    let Ok(app) = state::get() else {
        return "[]".to_string();
    };
    let entries = match app.cache.lock() {
        Ok(g) => g.list(),
        Err(_) => return "[]".to_string(),
    };
    let pool = match app.db_pool.read() {
        Ok(p) => p,
        Err(_) => return "[]".to_string(),
    };
    let conn = match pool.get() {
        Ok(c) => c,
        Err(_) => return "[]".to_string(),
    };
    #[derive(serde::Serialize)]
    struct Row {
        #[serde(rename = "resourceId")]
        resource_id: String,
        title: String,
        url: String,
        #[serde(rename = "resourceType")]
        resource_type: String,
        bytes: u64,
        #[serde(rename = "lastAccessMs")]
        last_access_ms: i64,
    }
    let mut out: Vec<Row> = Vec::with_capacity(entries.len());
    let mut stmt = match conn.prepare(
        "SELECT title, url, resource_type FROM resources \
         WHERE id = ?1 AND deleted_at IS NULL",
    ) {
        Ok(s) => s,
        Err(_) => return "[]".to_string(),
    };
    for e in entries {
        let row = stmt.query_row(rusqlite::params![&e.resource_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        });
        if let Ok((title, url, rtype)) = row {
            out.push(Row {
                resource_id: e.resource_id,
                title,
                url,
                resource_type: rtype,
                bytes: e.bytes,
                last_access_ms: e.last_access_ms,
            });
        }
    }
    to_json(&out)
}

/// Batch membership check: given a JSON array of resource ids, return the
/// subset that currently has a snapshot in cache. Used by ResourceList to
/// render the "已缓存" badge in one round-trip.
#[shibei_napi]
pub fn cached_ids(ids_json: String) -> String {
    let Ok(ids): Result<Vec<String>, _> = serde_json::from_str(&ids_json) else {
        return "[]".to_string();
    };
    let Ok(app) = state::get() else {
        return "[]".to_string();
    };
    let Ok(guard) = app.cache.lock() else {
        return "[]".to_string();
    };
    let cached = guard.cached_ids(ids);
    to_json(&cached)
}

/// Nuke every cached snapshot on disk + drop the in-memory index. Does NOT
/// touch the DB rows — titles/tags/annotations survive; the user simply has
/// to re-download a snapshot before reading. Returns the count of entries
/// cleared as a decimal string (so ArkTS can show a toast like "已清 N 条").
///
/// Orphan snapshot directories (written by pre-§7.2 builds that did eager
/// sync downloads without ever touching cache-index.json) get swept here
/// too — we honor the "all downloaded snapshots" wording of the confirm
/// dialog even when the cache index lost track of some files.
#[shibei_napi]
pub fn cache_clear() -> String {
    let Ok(app) = state::get() else {
        return "0".to_string();
    };
    let (removed, cleared_ids) = match app.cache.lock() {
        Ok(mut g) => {
            let ids = g.clear_all(&app.data_dir);
            if let Err(e) = g.flush(&app.data_dir) {
                eprintln!("[cache] flush after clear failed: {e}");
            }
            (ids.len(), ids)
        }
        Err(_) => (0, Vec::new()),
    };
    // §7.5: strip body_text for every dropped id.
    clear_body_text_for(&app.db_pool, &cleared_ids);
    // Sweep any orphan `storage/*` dirs that were never tracked in the
    // cache index. Safe to wipe wholesale because the index clear above
    // already accounts for every cached id, and the DB does not require
    // these files (only the Reader does — it'll re-download on next open).
    let storage_dir = app.data_dir.join("storage");
    if storage_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&storage_dir) {
            eprintln!("[cache] sweep orphan storage/ failed: {e}");
        }
    }
    removed.to_string()
}

/// Force an eviction pass against the current limit. Returns the evicted id
/// count. ArkTS typically doesn't call this directly — eviction happens
/// automatically inside `on_snapshot_saved` — but it's useful when the limit
/// was lowered via `cache_set_limit`.
#[shibei_napi]
pub fn cache_evict() -> String {
    let Ok(app) = state::get() else {
        return "0".to_string();
    };
    let (n, evicted_ids) = match app.cache.lock() {
        Ok(mut g) => {
            let ids = g.evict_if_over_limit(&app.data_dir);
            if let Err(e) = g.flush(&app.data_dir) {
                eprintln!("[cache] flush after evict failed: {e}");
            }
            (ids.len(), ids)
        }
        Err(_) => (0, Vec::new()),
    };
    clear_body_text_for(&app.db_pool, &evicted_ids);
    n.to_string()
}

/// Last successful sync, as the ISO8601 string stored in sync_state. Empty
/// string if never synced (or state not initialized). ArkTS formats this
/// into "HH:MM" or "MM-DD HH:MM" depending on recency.
#[shibei_napi]
pub fn get_last_sync_at() -> String {
    let result = with_conn(|conn| shibei_sync::sync_state::get(conn, "last_sync_at"));
    result.unwrap_or(None).unwrap_or_default()
}

/// Auto-sync mode. `"on_open"` (default) means the app fires a background
/// sync when Library lands on a cold launch; `"manual"` means the user
/// must explicitly tap 立即同步 or pull-to-refresh. Any unexpected value
/// from storage falls back to `"on_open"` so a garbled write can't leave
/// the user stuck on stale data forever.
#[shibei_napi]
pub fn get_auto_sync_mode() -> String {
    let raw = with_conn(|conn| shibei_sync::sync_state::get(conn, "config:auto_sync"))
        .ok()
        .flatten()
        .unwrap_or_default();
    match raw.as_str() {
        "manual" => "manual".to_string(),
        _ => "on_open".to_string(),
    }
}

#[shibei_napi]
pub fn set_auto_sync_mode(mode: String) -> String {
    if mode != "on_open" && mode != "manual" {
        return "error.invalidAutoSyncMode".to_string();
    }
    let result = with_conn(|conn| shibei_sync::sync_state::set(conn, "config:auto_sync", &mode));
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}

/// Update the cache size ceiling (bytes). Values < 1 are clamped to 1. If the
/// new limit is below current usage, an eviction pass runs immediately.
#[shibei_napi]
pub fn cache_set_limit(limit_bytes: i64) -> String {
    let Ok(app) = state::get() else {
        return "error.notInitialized".to_string();
    };
    let bytes = if limit_bytes < 1 { 1 } else { limit_bytes as u64 };
    let evicted_ids: Vec<String>;
    {
        let Ok(mut guard) = app.cache.lock() else {
            return "error.cacheLockPoisoned".to_string();
        };
        guard.set_limit(bytes);
        evicted_ids = guard.evict_if_over_limit(&app.data_dir);
        if let Err(e) = guard.flush(&app.data_dir) {
            eprintln!("[cache] flush after set_limit failed: {e}");
            return format!("error.cacheFlush: {e}");
        }
    }
    clear_body_text_for(&app.db_pool, &evicted_ids);
    "ok".to_string()
}

/// Preload a single resource's snapshot (HTML or PDF auto-detected from
/// `resources.resource_type`). Returns `"ok"` (fast path when already
/// present) or `error.*`. Used by ResourceList/FolderDrawer 右键 「缓存到
/// 本地」 and by the batch preload in `preload_folder`.
#[shibei_napi(async)]
pub async fn preload_resource(id: String) -> Result<String, String> {
    let rtype = with_conn(|conn| {
        conn.query_row(
            "SELECT resource_type FROM resources WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![&id],
            |row| row.get::<_, String>(0),
        )
        .map_err(shibei_db::DbError::from)
    })?;
    if rtype == "pdf" {
        ensure_pdf_downloaded(id).await
    } else {
        ensure_html_downloaded(id).await
    }
}

/// Preload every non-deleted resource in a folder. Returns JSON
/// `{"ok":N,"failed":M,"skipped":K}` — skipped = already cached, ok = newly
/// downloaded, failed = each individual error. Failures don't abort the run
/// (user on spotty WiFi shouldn't lose 9/10 successful downloads to one bad
/// one). `folder_id` may be `"__inbox__"`.
#[shibei_napi(async)]
pub async fn preload_folder(folder_id: String) -> Result<String, String> {
    let ids: Vec<(String, String)> = with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, resource_type FROM resources \
             WHERE folder_id = ?1 AND deleted_at IS NULL",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![&folder_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    let app = state::get()?;
    let base = app.data_dir.clone();

    let mut ok: u32 = 0;
    let mut failed: u32 = 0;
    let mut skipped: u32 = 0;

    // Build the engine lazily — if every resource is already on disk we can
    // skip the MK precondition entirely. Initial state: None; first missing
    // snapshot triggers construction. If construction fails (MK not loaded)
    // we surface one error and let the loop count the rest as failed.
    let mut engine: Option<shibei_sync::engine::SyncEngine> = None;
    let mut engine_err: Option<String> = None;

    for (rid, rtype) in ids {
        let filename = if rtype == "pdf" { "snapshot.pdf" } else { "snapshot.html" };
        let path = base.join("storage").join(&rid).join(filename);
        if path.exists() {
            // Already on disk from a previous sync — touch cache so the
            // row badge shows up. Without this, pre-existing snapshots
            // stay silently off-cache-index and the user has no way to
            // see they already have the file.
            touch_cache(&rid);
            skipped += 1;
            continue;
        }
        // Lazy engine construction. If MK isn't loaded we can't download
        // anything — surface that as each remaining failure so the user
        // sees "ok N / failed M / skipped K" and knows what gap remains.
        if engine.is_none() && engine_err.is_none() {
            match build_sync_engine().await {
                Ok(e) => engine = Some(e),
                Err(e) => engine_err = Some(e),
            }
        }
        if let Some(err) = engine_err.as_ref() {
            eprintln!("[preload] {} skipped (engine unavailable): {err}", rid);
            failed += 1;
            continue;
        }
        match engine.as_ref().unwrap().download_snapshot(&rid, &rtype).await {
            Ok(()) => ok += 1,
            Err(e) => {
                eprintln!("[preload] {} failed: {e}", rid);
                failed += 1;
            }
        }
    }

    Ok(format!(
        r#"{{"ok":{},"failed":{},"skipped":{}}}"#,
        ok, failed, skipped
    ))
}

// ────────────────────────────────────────────────────────────
// Annotations (Phase 3a)
// ────────────────────────────────────────────────────────────

/// Returns JSON envelope `{"highlights":[...], "comments":[...]}` for a
/// resource. Soft-deleted rows are filtered server-side.
#[shibei_napi]
pub fn list_annotations(resource_id: String) -> String {
    let result = with_conn(|conn| {
        let highlights = shibei_db::highlights::get_highlights_for_resource(conn, &resource_id)?;
        let comments = shibei_db::comments::get_comments_for_resource(conn, &resource_id)?;
        Ok((highlights, comments))
    });
    match result {
        Ok((h, c)) => {
            let h_json = serde_json::to_string(&h).unwrap_or_else(|_| "[]".into());
            let c_json = serde_json::to_string(&c).unwrap_or_else(|_| "[]".into());
            format!(r#"{{"highlights":{h_json},"comments":{c_json}}}"#)
        }
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

/// Input JSON: `{"resourceId":"...", "textContent":"...", "anchor":{...}, "color":"#RRGGBB"}`.
/// Returns: `{"highlight":{...}}` | `{"error":"..."}`.
/// Anchor stored verbatim as JSON — mobile annotator emits HTML-shaped
/// anchors `{text_position, text_quote}`.
#[shibei_napi]
pub fn create_highlight(input_json: String) -> String {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        resource_id: String,
        text_content: String,
        anchor: serde_json::Value,
        color: String,
    }
    let input: Input = match serde_json::from_str(&input_json) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"error":"error.badInput: {e}"}}"#),
    };
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!(r#"{{"error":"{e}"}}"#),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| {
        shibei_db::highlights::create_highlight(
            conn,
            &input.resource_id,
            &input.text_content,
            &input.anchor,
            &input.color,
            Some(&ctx),
        )
    });
    match result {
        Ok(h) => {
            let h_json = serde_json::to_string(&h).unwrap_or_default();
            format!(r#"{{"highlight":{h_json}}}"#)
        }
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

#[shibei_napi]
pub fn delete_highlight(id: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.{e}"),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| shibei_db::highlights::delete_highlight(conn, &id, Some(&ctx)));
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => format!("error.{e}"),
    }
}

#[shibei_napi]
pub fn update_highlight_color(id: String, color: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!(r#"{{"error":"{e}"}}"#),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| {
        shibei_db::highlights::update_highlight_color(conn, &id, &color, Some(&ctx))
    });
    match result {
        Ok(h) => format!(r#"{{"highlight":{}}}"#, serde_json::to_string(&h).unwrap_or_default()),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

/// Input JSON: `{"resourceId":"...", "highlightId":"..."|null, "content":"..."}`.
#[shibei_napi]
pub fn create_comment(input_json: String) -> String {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        resource_id: String,
        highlight_id: Option<String>,
        content: String,
    }
    let input: Input = match serde_json::from_str(&input_json) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"error":"error.badInput: {e}"}}"#),
    };
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!(r#"{{"error":"{e}"}}"#),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| {
        shibei_db::comments::create_comment(
            conn,
            &input.resource_id,
            input.highlight_id.as_deref(),
            &input.content,
            Some(&ctx),
        )
    });
    match result {
        Ok(c) => format!(r#"{{"comment":{}}}"#, serde_json::to_string(&c).unwrap_or_default()),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

#[shibei_napi]
pub fn update_comment(id: String, content: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.{e}"),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| shibei_db::comments::update_comment(conn, &id, &content, Some(&ctx)));
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => format!("error.{e}"),
    }
}

#[shibei_napi]
pub fn delete_comment(id: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.{e}"),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| shibei_db::comments::delete_comment(conn, &id, Some(&ctx)));
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => format!("error.{e}"),
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

// ────────────────────────────────────────────────────────────
// App lock (Phase 4)
// ────────────────────────────────────────────────────────────

#[shibei_napi]
pub fn lock_is_configured() -> bool {
    crate::lock::is_configured()
}

#[shibei_napi]
pub fn lock_is_bio_enabled() -> bool {
    crate::lock::is_bio_enabled()
}

#[shibei_napi]
pub fn lock_is_mk_loaded() -> bool {
    state::is_unlocked()
}

#[shibei_napi]
pub fn lock_lockout_remaining_secs() -> i32 {
    crate::lock::lockout_remaining_secs()
}

#[shibei_napi(async)]
pub async fn lock_setup_pin(pin: String) -> Result<String, String> {
    crate::lock::setup_pin(pin)
}

#[shibei_napi(async)]
pub async fn lock_unlock_with_pin(pin: String) -> Result<String, String> {
    crate::lock::unlock_with_pin(pin)
}

#[shibei_napi(async)]
pub async fn lock_disable(pin: String) -> Result<String, String> {
    crate::lock::disable(pin)
}

#[shibei_napi(async)]
pub async fn lock_enable_bio(bio_wrapped_mk_b64: String) -> Result<String, String> {
    crate::lock::enable_bio(bio_wrapped_mk_b64)
}

#[shibei_napi]
pub fn lock_get_bio_wrapped_mk() -> String {
    crate::lock::get_bio_wrapped_mk()
}

#[shibei_napi(async)]
pub async fn lock_push_unwrapped_mk(mk_b64: String) -> Result<String, String> {
    crate::lock::push_unwrapped_mk(mk_b64)
}

#[shibei_napi(async)]
pub async fn lock_recover_with_e2ee(password: String, new_pin: String) -> Result<String, String> {
    crate::lock::recover_with_e2ee(password, new_pin).await
}

#[shibei_napi]
pub fn lock_get_mk_for_bio_enroll() -> String {
    crate::lock::get_mk_for_bio_enroll()
}

#[shibei_napi(async)]
pub async fn lock_delete_bio_only() -> Result<String, String> {
    crate::lock::delete_bio_only()
}

// ────────────────────────────────────────────────────────────
// S3 credentials secure storage (Phase 4)
// ────────────────────────────────────────────────────────────

#[shibei_napi]
pub fn s3_creds_write(wrapped_b64: String) -> String {
    match s3_creds_write_inner(&wrapped_b64) {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}

fn s3_creds_write_inner(wrapped_b64: &str) -> Result<(), String> {
    use base64::Engine;
    use crate::secure_store::SecureStore;
    let app = state::get()?;
    let store = crate::secure_store::FileStore::new(&app.data_dir)
        .map_err(|e| format!("error.fsInit: {e}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wrapped_b64)
        .map_err(|e| format!("error.badS3Blob: {e}"))?;
    store.write("s3_creds", &bytes)?;
    Ok(())
}

#[shibei_napi]
pub fn s3_creds_read() -> String {
    use base64::Engine;
    use crate::secure_store::SecureStore;
    let Ok(app) = state::get() else { return String::new() };
    let store = match crate::secure_store::FileStore::new(&app.data_dir) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    match store.read("s3_creds") {
        Ok(Some(bytes)) => base64::engine::general_purpose::STANDARD.encode(&bytes),
        _ => String::new(),
    }
}

#[shibei_napi]
pub fn s3_creds_clear_legacy() -> String {
    match with_conn(shibei_sync::credentials::clear_credentials) {
        Ok(()) => "ok".to_string(),
        Err(e) => e,
    }
}

/// Phase 4.1: populate the in-memory S3 credentials cache. Called by ArkTS
/// (a) after `primeS3Creds` unwraps `secure/s3_creds.blob` on cold start,
/// and (b) after `setS3Config` to immediately back the HUKS-wrapped blob
/// with a live runtime copy. Never touches SQLite; kill → cleared.
#[shibei_napi]
pub fn set_s3_creds_runtime(access_key: String, secret_key: String) -> String {
    let Ok(app) = state::get() else {
        return "error.notInitialized".to_string();
    };
    let Ok(mut guard) = app.s3_creds.write() else {
        return "error.credentialsLockPoisoned".to_string();
    };
    *guard = Some((access_key, secret_key));
    "ok".to_string()
}
