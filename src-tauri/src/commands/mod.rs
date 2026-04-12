use std::sync::Arc;

use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use rand::rngs::OsRng;
use serde::Serialize;
use tauri::Emitter;

use crate::db::{self, comments, folders, highlights, resources, tags, DbError};
use crate::events;
use crate::storage;

/// Shared application state managed by Tauri.
pub struct AppState {
    pub pool: db::SharedPool,
    pub base_dir: std::path::PathBuf,
    pub auth_token: String,
    pub sync_clock: Option<crate::sync::hlc::HlcClock>,
    pub device_id: Option<String>,
    #[allow(dead_code)]
    pub sync_engine: Option<Arc<crate::sync::engine::SyncEngine>>,
}

impl AppState {
    pub fn sync_context(&self) -> Option<crate::sync::SyncContext<'_>> {
        match (&self.sync_clock, &self.device_id) {
            (Some(clock), Some(device_id)) => Some(crate::sync::SyncContext { clock, device_id }),
            _ => None,
        }
    }

    pub fn conn(&self) -> Result<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>, CommandError> {
        let pool = self.pool.read().map_err(|e| CommandError { message: format!("pool lock poisoned: {e}") })?;
        pool.get().map_err(|e| CommandError { message: e.to_string() })
    }
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl From<DbError> for CommandError {
    fn from(e: DbError) -> Self {
        CommandError {
            message: e.to_string(),
        }
    }
}

impl From<storage::StorageError> for CommandError {
    fn from(e: storage::StorageError) -> Self {
        CommandError {
            message: e.to_string(),
        }
    }
}

// ── Folders ──

#[tauri::command]
pub async fn cmd_list_folders(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: String,
) -> Result<Vec<folders::Folder>, CommandError> {
    let conn = state.conn()?;
    folders::list_children(&conn, &parent_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    name: String,
    parent_id: String,
) -> Result<folders::Folder, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let folder = folders::create_folder(&conn, &name, &parent_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "created", "parent_id": parent_id }));
    Ok(folder)
}

#[tauri::command]
pub async fn cmd_rename_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    folders::rename_folder(&conn, &id, &name, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "updated", "folder_id": id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<String>, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let resource_ids = folders::delete_folder(&conn, &id, sync_ctx.as_ref())?;
    // Snapshot files are kept until purge, so restore can still access them.
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "deleted", "folder_id": id }));
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({ "action": "deleted" }));
    Ok(resource_ids)
}

#[tauri::command]
pub async fn cmd_move_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    new_parent_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    folders::move_folder(&conn, &id, &new_parent_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "moved", "folder_id": id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<folders::Folder, CommandError> {
    let conn = state.conn()?;
    folders::get_folder(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_folder_path(
    state: tauri::State<'_, Arc<AppState>>,
    folder_id: String,
) -> Result<Vec<folders::Folder>, CommandError> {
    let conn = state.conn()?;
    folders::get_folder_path(&conn, &folder_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_reorder_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    new_sort_order: i64,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    folders::reorder_folder(&conn, &id, new_sort_order, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "reordered", "folder_id": id }));
    Ok(())
}

// ── Resources ──

#[tauri::command]
pub async fn cmd_list_resources(
    state: tauri::State<'_, Arc<AppState>>,
    folder_id: String,
    sort_by: Option<resources::SortBy>,
    sort_order: Option<resources::SortOrder>,
    tag_ids: Vec<String>,
) -> Result<Vec<resources::Resource>, CommandError> {
    let conn = state.conn()?;
    resources::list_resources_by_folder(
        &conn,
        &folder_id,
        sort_by.unwrap_or(resources::SortBy::CreatedAt),
        sort_order.unwrap_or(resources::SortOrder::Desc),
        &tag_ids,
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_resource(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<resources::Resource, CommandError> {
    let conn = state.conn()?;
    resources::get_resource(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let folder_id = resources::get_resource(&conn, &id)?.folder_id;
    let sync_ctx = state.sync_context();
    resources::delete_resource(&conn, &id, sync_ctx.as_ref())?;
    // Snapshot files are kept until purge, so restore can still access them.
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({ "action": "deleted", "resource_id": id, "folder_id": folder_id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_move_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    new_folder_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    resources::move_resource(&conn, &id, &new_folder_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({ "action": "moved", "resource_id": id, "folder_id": new_folder_id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_update_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    title: String,
    description: Option<String>,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    resources::update_resource(&conn, &id, &title, description.as_deref(), sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({ "action": "updated", "resource_id": id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_list_all_resources(
    state: tauri::State<'_, Arc<AppState>>,
    sort_by: Option<resources::SortBy>,
    sort_order: Option<resources::SortOrder>,
    tag_ids: Vec<String>,
) -> Result<Vec<resources::Resource>, CommandError> {
    let conn = state.conn()?;
    resources::list_all_resources(
        &conn,
        sort_by.unwrap_or(resources::SortBy::CreatedAt),
        sort_order.unwrap_or(resources::SortOrder::Desc),
        &tag_ids,
    )
    .map_err(Into::into)
}

// ── Tags ──

#[tauri::command]
pub async fn cmd_list_tags(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<tags::Tag>, CommandError> {
    let conn = state.conn()?;
    tags::list_tags(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_tag(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    name: String,
    color: String,
) -> Result<tags::Tag, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let tag = tags::create_tag(&conn, &name, &color, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({ "action": "created", "tag_id": tag.id }));
    Ok(tag)
}

#[tauri::command]
pub async fn cmd_delete_tag(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    tags::delete_tag(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({ "action": "deleted", "tag_id": id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_tags_for_resource(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<tags::Tag>, CommandError> {
    let conn = state.conn()?;
    tags::get_tags_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_add_tag_to_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    tags::add_tag_to_resource(&conn, &resource_id, &tag_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({ "action": "updated", "tag_id": tag_id, "resource_id": resource_id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_remove_tag_from_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    tags::remove_tag_from_resource(&conn, &resource_id, &tag_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({ "action": "updated", "tag_id": tag_id, "resource_id": resource_id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_update_tag(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    name: String,
    color: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    tags::update_tag(&conn, &id, &name, &color, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({ "action": "updated", "tag_id": id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_resources_by_tag(
    state: tauri::State<'_, Arc<AppState>>,
    tag_id: String,
) -> Result<Vec<resources::Resource>, CommandError> {
    let conn = state.conn()?;
    tags::get_resources_by_tag(&conn, &tag_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_search_resources(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    folder_id: Option<String>,
    tag_ids: Vec<String>,
    sort_by: Option<resources::SortBy>,
    sort_order: Option<resources::SortOrder>,
) -> Result<Vec<db::search::SearchResult>, CommandError> {
    let conn = state.conn()?;
    let sort_by_str = match sort_by.unwrap_or(resources::SortBy::CreatedAt) {
        resources::SortBy::CreatedAt => "created_at",
        resources::SortBy::AnnotatedAt => "annotated_at",
    };
    let sort_order_str = match sort_order.unwrap_or(resources::SortOrder::Desc) {
        resources::SortOrder::Asc => "asc",
        resources::SortOrder::Desc => "desc",
    };
    db::search::search_resources(
        &conn,
        &query,
        folder_id.as_deref(),
        &tag_ids,
        sort_by_str,
        sort_order_str,
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_index_stats(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<db::search::IndexStats, CommandError> {
    let conn = state.conn()?;
    db::search::get_index_stats(&conn).map_err(Into::into)
}

// ── Highlights ──

#[tauri::command]
pub async fn cmd_get_highlights(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<highlights::Highlight>, CommandError> {
    let conn = state.conn()?;
    highlights::get_highlights_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    text_content: String,
    anchor: highlights::Anchor,
    color: String,
) -> Result<highlights::Highlight, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let highlight = highlights::create_highlight(&conn, &resource_id, &text_content, &anchor, &color, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({ "action": "created", "resource_id": resource_id }));
    Ok(highlight)
}

#[tauri::command]
pub async fn cmd_update_highlight_color(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    resource_id: String,
    color: String,
) -> Result<highlights::Highlight, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let highlight = highlights::update_highlight_color(&conn, &id, &color, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({ "action": "updated", "resource_id": resource_id }));
    Ok(highlight)
}

#[tauri::command]
pub async fn cmd_delete_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    resource_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    highlights::delete_highlight(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({ "action": "deleted", "resource_id": resource_id }));
    Ok(())
}

// ── Comments ──

#[tauri::command]
pub async fn cmd_get_comments(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<comments::Comment>, CommandError> {
    let conn = state.conn()?;
    comments::get_comments_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_comment(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    highlight_id: Option<String>,
    content: String,
) -> Result<comments::Comment, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let comment = comments::create_comment(&conn, &resource_id, highlight_id.as_deref(), &content, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({ "action": "created", "resource_id": resource_id }));
    Ok(comment)
}

#[tauri::command]
pub async fn cmd_update_comment(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    resource_id: String,
    content: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    comments::update_comment(&conn, &id, &content, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({ "action": "updated", "resource_id": resource_id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_comment(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    resource_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    comments::delete_comment(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({ "action": "deleted", "resource_id": resource_id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_folder_counts(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<std::collections::HashMap<String, i64>, CommandError> {
    let conn = state.conn()?;
    resources::count_by_folder(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_non_leaf_folder_ids(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<String>, CommandError> {
    let conn = state.conn()?;
    let set = folders::parent_ids_with_children(&conn).map_err(CommandError::from)?;
    Ok(set.into_iter().collect())
}

#[tauri::command]
pub async fn cmd_get_auth_token(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, CommandError> {
    Ok(state.auth_token.clone())
}

// ── Sync ──

#[tauri::command]
pub async fn cmd_sync_now(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    app: tauri::AppHandle,
) -> Result<String, CommandError> {
    let _ = app.emit(events::SYNC_STARTED, ());

    // Self-heal: if encryption is enabled but first post-encryption sync never completed,
    // reset sync state to force full snapshot import. This repairs devices that went
    // through the buggy unlock flow where sync state was not properly reset.
    {
        let conn = state.conn()?;
        let encryption_enabled = crate::sync::sync_state::get(&conn, "config:encryption_enabled")?
            .map(|v| v == "true").unwrap_or(false);
        let sync_completed = crate::sync::sync_state::get(&conn, "config:encryption_sync_completed")?
            .map(|v| v == "true").unwrap_or(false);
        if encryption_enabled && !sync_completed {
            eprintln!("[sync] Encryption enabled but first sync not completed — resetting sync state");
            conn.execute("UPDATE sync_log SET uploaded = 0", [])
                .map_err(|e| CommandError { message: e.to_string() })?;
            let remote_keys = crate::sync::sync_state::list_by_prefix(&conn, "remote:")?;
            for (key, _) in &remote_keys {
                crate::sync::sync_state::delete(&conn, key)?;
            }
            crate::sync::sync_state::delete(&conn, "last_sync_at")?;
        }
    }

    let engine = build_sync_engine(&state, &encryption_state).await.inspect_err(|e| {
        let _ = app.emit(events::SYNC_FAILED, serde_json::json!({ "message": e.message }));
    })?;
    let app_clone = app.clone();
    let on_progress: crate::sync::engine::ProgressCallback = Box::new(move |phase, current, total| {
        let _ = app_clone.emit(events::SYNC_PROGRESS, serde_json::json!({
            "phase": phase,
            "current": current,
            "total": total
        }));
    });

    let result = engine.sync(Some(&on_progress)).await.map_err(|e| {
        let msg = e.to_string();
        let _ = app.emit(events::SYNC_FAILED, serde_json::json!({ "message": msg }));
        CommandError { message: e.to_string() }
    })?;

    // Mark first post-encryption sync as completed
    {
        let conn = state.conn()?;
        if crate::sync::sync_state::get(&conn, "config:encryption_enabled")?
            .map(|v| v == "true").unwrap_or(false)
        {
            crate::sync::sync_state::set(&conn, "config:encryption_sync_completed", "true")?;
        }
    }

    let _ = app.emit(events::DATA_SYNC_COMPLETED, ());
    Ok(format!("{:?}", result))
}

#[tauri::command]
pub async fn cmd_force_compact(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
) -> Result<String, CommandError> {
    let engine = build_sync_engine(&state, &encryption_state).await?;
    let ran = engine.force_compact().await.map_err(|e| CommandError { message: e.to_string() })?;
    if ran {
        Ok("compaction completed".to_string())
    } else {
        Ok("compaction completed (no files to clean)".to_string())
    }
}

#[tauri::command]
pub async fn cmd_list_orphan_snapshots(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
) -> Result<serde_json::Value, CommandError> {
    let engine = build_sync_engine(&state, &encryption_state).await?;
    let orphans = engine.list_orphan_snapshots().await.map_err(|e| CommandError { message: e.to_string() })?;
    let total_size: u64 = orphans.iter().map(|(_, s)| s).sum();
    let items: Vec<serde_json::Value> = orphans.iter().map(|(id, size)| {
        serde_json::json!({ "resource_id": id, "size": size })
    }).collect();
    Ok(serde_json::json!({
        "count": orphans.len(),
        "total_size": total_size,
        "items": items,
    }))
}

#[tauri::command]
pub async fn cmd_purge_orphan_snapshots(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
) -> Result<serde_json::Value, CommandError> {
    let engine = build_sync_engine(&state, &encryption_state).await?;
    let (deleted, freed) = engine.purge_orphan_snapshots().await.map_err(|e| CommandError { message: e.to_string() })?;
    Ok(serde_json::json!({
        "deleted": deleted,
        "freed_bytes": freed,
    }))
}

/// Build a SyncEngine from current config. Called on each sync to pick up latest settings.
/// If encryption is enabled, wraps the backend with EncryptedBackend.
/// Multi-device detection: if local doesn't know about encryption, check remote keyring.json.
async fn build_sync_engine(
    state: &AppState,
    encryption_state: &crate::sync::EncryptionState,
) -> Result<crate::sync::engine::SyncEngine, CommandError> {
    let conn = state.conn()?;

    let local_encryption_enabled = crate::sync::sync_state::get(&conn, "config:encryption_enabled")?
        .map(|v| v == "true")
        .unwrap_or(false);

    let region = crate::sync::sync_state::get(&conn, "config:s3_region")?
        .ok_or_else(|| CommandError { message: "error.syncRegionNotSet".to_string() })?;
    let bucket = crate::sync::sync_state::get(&conn, "config:s3_bucket")?
        .ok_or_else(|| CommandError { message: "error.syncBucketNotSet".to_string() })?;
    let endpoint = crate::sync::sync_state::get(&conn, "config:s3_endpoint")?.unwrap_or_default();
    let (access_key, secret_key) = crate::sync::credentials::load_credentials(&conn)?
        .ok_or_else(|| CommandError { message: "error.syncCredentialsNotSet".to_string() })?;

    let s3_config = crate::sync::backend::S3Config {
        endpoint: if endpoint.is_empty() { None } else { Some(endpoint) },
        region,
        bucket,
        access_key,
        secret_key,
    };
    let s3_backend = crate::sync::backend::S3Backend::new(s3_config)
        .map_err(|e| CommandError { message: e.to_string() })?;

    // Determine if encryption is needed.
    // Check local flag first to avoid network round-trip on every sync.
    // Fall back to remote check only when local doesn't know.
    let encryption_enabled = if local_encryption_enabled {
        true
    } else {
        use crate::sync::backend::SyncBackend;
        let remote_has_keyring = s3_backend.head("meta/keyring.json").await
            .map(|meta| meta.is_some())
            .unwrap_or(false);
        if remote_has_keyring {
            // Don't persist here — let cmd_unlock_encryption set this flag
            // so that is_first_unlock correctly detects the first unlock and
            // resets sync state (last_sync_at, remote:* progress, sync_log).
            true
        } else {
            false
        }
    };

    let backend: Arc<dyn crate::sync::backend::SyncBackend> = if encryption_enabled {
        let mk = encryption_state.get_key().ok_or_else(|| CommandError {
            message: "error.encryptionNotUnlocked".to_string(),
        })?;
        Arc::new(crate::sync::encrypted_backend::EncryptedBackend::new(
            Arc::new(s3_backend),
            mk,
        ))
    } else {
        Arc::new(s3_backend)
    };

    let device_id = state.device_id.as_ref()
        .ok_or_else(|| CommandError { message: "Device ID not initialized".to_string() })?;
    let clock = Arc::new(crate::sync::hlc::HlcClock::new(device_id.clone()));

    Ok(crate::sync::engine::SyncEngine::new(
        state.pool.clone(),
        backend,
        device_id.clone(),
        clock,
        state.base_dir.clone(),
    ))
}

/// Build a raw S3Backend (no encryption) for keyring operations.
fn build_raw_s3_backend(state: &AppState) -> Result<crate::sync::backend::S3Backend, CommandError> {
    let conn = state.conn()?;
    let region = crate::sync::sync_state::get(&conn, "config:s3_region")?
        .ok_or_else(|| CommandError { message: "error.syncRegionNotSet".to_string() })?;
    let bucket = crate::sync::sync_state::get(&conn, "config:s3_bucket")?
        .ok_or_else(|| CommandError { message: "error.syncBucketNotSet".to_string() })?;
    let endpoint = crate::sync::sync_state::get(&conn, "config:s3_endpoint")?.unwrap_or_default();
    let (access_key, secret_key) = crate::sync::credentials::load_credentials(&conn)?
        .ok_or_else(|| CommandError { message: "error.syncCredentialsNotSet".to_string() })?;

    let config = crate::sync::backend::S3Config {
        endpoint: if endpoint.is_empty() { None } else { Some(endpoint) },
        region,
        bucket,
        access_key,
        secret_key,
    };
    crate::sync::backend::S3Backend::new(config)
        .map_err(|e| CommandError { message: e.to_string() })
}

#[tauri::command]
pub async fn cmd_setup_encryption(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    app: tauri::AppHandle,
    password: String,
) -> Result<(), CommandError> {
    // Clear any stale keychain entry (old MK is now invalid)
    let _ = crate::sync::os_keystore::delete_master_key();

    use crate::sync::backend::SyncBackend;
    use crate::sync::keyring::Keyring;

    // 1. Generate keyring
    let keyring = Keyring::generate(&password)
        .map_err(|e| CommandError { message: format!("error.keyGenFailed: {}", e) })?;
    let mk = keyring.unlock(&password)
        .map_err(|e| CommandError { message: format!("error.keyVerifyFailed: {}", e) })?;

    // 2. Upload keyring.json via raw backend
    let backend = build_raw_s3_backend(&state)?;
    let keyring_json = keyring.to_json()
        .map_err(|e| CommandError { message: e.to_string() })?;
    backend.upload("meta/keyring.json", keyring_json.as_bytes()).await
        .map_err(|e| CommandError { message: format!("error.keyUploadFailed: {}", e) })?;

    // 3. Clear all existing S3 data
    for prefix in &["sync/", "state/", "snapshots/"] {
        let objects = backend.list(prefix).await
            .map_err(|e| CommandError { message: e.to_string() })?;
        for obj in objects {
            let _ = backend.delete(&obj.key).await;
        }
    }

    // 4. Reset local sync progress
    let conn = state.conn()?;
    conn.execute("UPDATE sync_log SET uploaded = 0", [])
        .map_err(|e| CommandError { message: e.to_string() })?;
    let remote_keys = crate::sync::sync_state::list_by_prefix(&conn, "remote:")?;
    for (key, _) in &remote_keys {
        crate::sync::sync_state::delete(&conn, key)?;
    }
    crate::sync::sync_state::delete(&conn, "last_sync_at")?;

    // 5. Store MK and mark encryption enabled
    encryption_state.set_key(mk);
    crate::sync::sync_state::set(&conn, "config:encryption_enabled", "true")?;
    // Reset completion flag so next sync does full re-sync
    crate::sync::sync_state::delete(&conn, "config:encryption_sync_completed")?;

    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({ "scope": "encryption" }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_unlock_encryption(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    app: tauri::AppHandle,
    password: String,
) -> Result<(), CommandError> {
    use crate::sync::backend::SyncBackend;
    use crate::sync::keyring::Keyring;

    let backend = build_raw_s3_backend(&state)?;
    let data = backend.download("meta/keyring.json").await
        .map_err(|e| CommandError { message: format!("error.keyDownloadFailed: {}", e) })?;
    let json = String::from_utf8(data)
        .map_err(|e| CommandError { message: format!("error.keyFileFormatError: {}", e) })?;
    let keyring = Keyring::from_json(&json)
        .map_err(|e| CommandError { message: format!("error.keyFileParseFailed: {}", e) })?;

    let mk = keyring.unlock(&password).map_err(|e| match e {
        crate::sync::keyring::KeyringError::WrongPassword => {
            CommandError { message: "error.wrongPassword".to_string() }
        }
        crate::sync::keyring::KeyringError::Tampered => {
            CommandError { message: "error.keyFileTampered".to_string() }
        }
        other => CommandError { message: format!("error.unlockFailed: {}", other) },
    })?;

    let conn = state.conn()?;

    // Reset sync progress if first post-encryption sync was never completed.
    // Uses a dedicated flag instead of config:encryption_enabled, which could
    // be set prematurely by build_sync_engine's auto-detection.
    let is_first_unlock = !crate::sync::sync_state::get(&conn, "config:encryption_sync_completed")?
        .map(|v| v == "true")
        .unwrap_or(false);

    // If remember_key is enabled, save MK to keychain (before set_key consumes mk)
    if crate::sync::sync_state::get(&conn, "config:remember_encryption_key")?
        .map(|v| v == "true")
        .unwrap_or(false)
    {
        let _ = crate::sync::os_keystore::save_master_key(&mk);
    }

    encryption_state.set_key(mk);
    crate::sync::sync_state::set(&conn, "config:encryption_enabled", "true")?;

    if is_first_unlock {
        conn.execute("UPDATE sync_log SET uploaded = 0", [])
            .map_err(|e| CommandError { message: e.to_string() })?;
        let remote_keys = crate::sync::sync_state::list_by_prefix(&conn, "remote:")?;
        for (key, _) in &remote_keys {
            crate::sync::sync_state::delete(&conn, key)?;
        }
        crate::sync::sync_state::delete(&conn, "last_sync_at")?;
    }

    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({ "scope": "encryption" }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_change_encryption_password(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    old_password: String,
    new_password: String,
) -> Result<(), CommandError> {
    use crate::sync::backend::SyncBackend;
    use crate::sync::keyring::Keyring;

    let backend = build_raw_s3_backend(&state)?;
    let data = backend.download("meta/keyring.json").await
        .map_err(|e| CommandError { message: format!("error.keyDownloadFailed: {}", e) })?;
    let json = String::from_utf8(data)
        .map_err(|e| CommandError { message: format!("error.keyFileFormatError: {}", e) })?;
    let keyring = Keyring::from_json(&json)
        .map_err(|e| CommandError { message: format!("error.keyFileParseFailed: {}", e) })?;

    let new_keyring = keyring.change_password(&old_password, &new_password).map_err(|e| match e {
        crate::sync::keyring::KeyringError::WrongPassword => {
            CommandError { message: "error.wrongOldPassword".to_string() }
        }
        other => CommandError { message: format!("error.changePasswordFailed: {}", other) },
    })?;

    let new_json = new_keyring.to_json()
        .map_err(|e| CommandError { message: e.to_string() })?;
    backend.upload("meta/keyring.json", new_json.as_bytes()).await
        .map_err(|e| CommandError { message: format!("error.keyUploadFailed: {}", e) })?;

    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({ "scope": "encryption" }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_encryption_status(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
) -> Result<serde_json::Value, CommandError> {
    let conn = state.conn()?;
    let enabled = crate::sync::sync_state::get(&conn, "config:encryption_enabled")?
        .map(|v| v == "true")
        .unwrap_or(false);
    let unlocked = encryption_state.is_unlocked();
    let remember_key = if enabled {
        crate::sync::sync_state::get(&conn, "config:remember_encryption_key")?
            .map(|v| v == "true")
            .unwrap_or(false)
    } else {
        false
    };

    Ok(serde_json::json!({
        "enabled": enabled,
        "unlocked": unlocked,
        "remember_key": remember_key,
    }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoUnlockResult {
    Unlocked,
    UnlockedUnverified,
    NoStoredKey,
    KeychainError,
    KeyMismatch,
}

#[tauri::command]
pub async fn cmd_auto_unlock(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
) -> Result<AutoUnlockResult, CommandError> {
    use crate::sync::backend::SyncBackend;
    use crate::sync::keyring::{compute_verification_hash, Keyring};
    use crate::sync::os_keystore;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    // 1. Try to load MK from OS keychain
    let mk = match os_keystore::load_master_key() {
        Ok(Some(mk)) => mk,
        Ok(None) => return Ok(AutoUnlockResult::NoStoredKey),
        Err(_) => return Ok(AutoUnlockResult::KeychainError),
    };

    // 2. Verify MK against remote keyring.json
    let backend = match build_raw_s3_backend(&state) {
        Ok(b) => b,
        Err(_) => {
            // No S3 config — optimistically trust keychain
            encryption_state.set_key(mk);
            return Ok(AutoUnlockResult::UnlockedUnverified);
        }
    };

    let keyring_data = match backend.download("meta/keyring.json").await {
        Ok(data) => data,
        Err(_) => {
            // S3 unreachable — optimistically trust keychain
            encryption_state.set_key(mk);
            return Ok(AutoUnlockResult::UnlockedUnverified);
        }
    };

    let json = match String::from_utf8(keyring_data) {
        Ok(j) => j,
        Err(_) => {
            encryption_state.set_key(mk);
            return Ok(AutoUnlockResult::UnlockedUnverified);
        }
    };

    let keyring = match Keyring::from_json(&json) {
        Ok(k) => k,
        Err(_) => {
            encryption_state.set_key(mk);
            return Ok(AutoUnlockResult::UnlockedUnverified);
        }
    };

    // Compare verification hash
    let actual_hash = compute_verification_hash(&mk);
    let expected_hash = B64.decode(&keyring.verification_hash).unwrap_or_default();

    if actual_hash[..] == expected_hash[..] {
        encryption_state.set_key(mk);
        Ok(AutoUnlockResult::Unlocked)
    } else {
        // MK is stale — another device reset encryption
        let _ = os_keystore::delete_master_key();
        let conn = state.conn()?;
        let _ = crate::sync::sync_state::delete(&conn, "config:remember_encryption_key");
        Ok(AutoUnlockResult::KeyMismatch)
    }
}

#[tauri::command]
pub async fn cmd_set_remember_key(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    app: tauri::AppHandle,
    remember: bool,
) -> Result<(), CommandError> {
    use crate::sync::os_keystore;

    let conn = state.conn()?;

    if remember {
        let mk = encryption_state.get_key().ok_or_else(|| CommandError {
            message: "error.encryptionNotUnlockedCannotSaveKey".to_string(),
        })?;
        os_keystore::save_master_key(&mk).map_err(|e| CommandError {
            message: format!("error.keychainSaveFailed: {}", e),
        })?;
        crate::sync::sync_state::set(&conn, "config:remember_encryption_key", "true")?;
    } else {
        let _ = os_keystore::delete_master_key();
        let _ = crate::sync::sync_state::delete(&conn, "config:remember_encryption_key");
    }

    let _ = app.emit(
        events::DATA_CONFIG_CHANGED,
        serde_json::json!({ "scope": "encryption" }),
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_remember_key(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<bool, CommandError> {
    let conn = state.conn()?;
    let remember = crate::sync::sync_state::get(&conn, "config:remember_encryption_key")?
        .map(|v| v == "true")
        .unwrap_or(false);
    Ok(remember)
}

#[tauri::command]
pub async fn cmd_save_sync_config(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    crate::sync::sync_state::set(&conn, "config:s3_endpoint", &endpoint)?;
    crate::sync::sync_state::set(&conn, "config:s3_region", &region)?;
    crate::sync::sync_state::set(&conn, "config:s3_bucket", &bucket)?;
    // Only update credentials if not placeholder
    if access_key != "__keep__" && secret_key != "__keep__" {
        crate::sync::credentials::store_credentials(&conn, &access_key, &secret_key)?;
    }
    // sync_interval is stored separately via cmd_set_sync_interval
    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({ "scope": "sync" }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_sync_config(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, CommandError> {
    let conn = state.conn()?;
    let endpoint = crate::sync::sync_state::get(&conn, "config:s3_endpoint")?.unwrap_or_default();
    let region = crate::sync::sync_state::get(&conn, "config:s3_region")?.unwrap_or_default();
    let bucket = crate::sync::sync_state::get(&conn, "config:s3_bucket")?.unwrap_or_default();
    let has_credentials = crate::sync::credentials::load_credentials(&conn)
        .map(|c| c.is_some()).unwrap_or(false);
    let last_sync = crate::sync::sync_state::get(&conn, "last_sync_at")?.unwrap_or_default();
    let sync_interval: i64 = crate::sync::sync_state::get(&conn, "config:sync_interval")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    Ok(serde_json::json!({
        "endpoint": endpoint,
        "region": region,
        "bucket": bucket,
        "has_credentials": has_credentials,
        "last_sync_at": last_sync,
        "sync_interval": sync_interval,
    }))
}

#[tauri::command]
pub async fn cmd_test_s3_connection(
    state: tauri::State<'_, Arc<AppState>>,
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
) -> Result<bool, CommandError> {
    if region.is_empty() || bucket.is_empty() {
        return Err(CommandError { message: "Region and Bucket are required".to_string() });
    }
    // If credentials are placeholder, load from DB
    let conn = state.conn()?;
    let (ak, sk) = if access_key == "__keep__" || secret_key == "__keep__" {
        crate::sync::credentials::load_credentials(&conn)?
            .ok_or_else(|| CommandError { message: "Credentials not configured".to_string() })?
    } else if access_key.is_empty() || secret_key.is_empty() {
        return Err(CommandError { message: "Access Key and Secret Key are required".to_string() });
    } else {
        (access_key, secret_key)
    };
    let config = crate::sync::backend::S3Config {
        endpoint: if endpoint.is_empty() { None } else { Some(endpoint) },
        region,
        bucket,
        access_key: ak,
        secret_key: sk,
    };
    use crate::sync::backend::SyncBackend as _;
    let backend = crate::sync::backend::S3Backend::new(config)
        .map_err(|e| CommandError { message: e.to_string() })?;
    backend.list("").await.map_err(|e| CommandError { message: e.to_string() })?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_download_snapshot(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    resource_id: String,
) -> Result<bool, CommandError> {
    let engine = build_sync_engine(&state, &encryption_state).await?;
    engine.download_snapshot(&resource_id).await
        .map_err(|e| CommandError { message: e.to_string() })?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_get_snapshot_status(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<String, CommandError> {
    let conn = state.conn()?;
    let status = crate::sync::sync_state::get(&conn, &format!("snapshot:{}", resource_id))?
        .unwrap_or_else(|| "synced".to_string());
    Ok(status)
}

#[tauri::command]
pub async fn cmd_set_sync_interval(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    minutes: i64,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    crate::sync::sync_state::set(&conn, "config:sync_interval", &minutes.to_string())?;
    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({ "scope": "sync" }));
    Ok(())
}

// ── Recycle Bin ──

#[tauri::command]
pub async fn cmd_list_deleted_resources(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<resources::DeletedResource>, CommandError> {
    let conn = state.conn()?;
    resources::list_deleted_resources(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_list_deleted_folders(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<folders::DeletedFolder>, CommandError> {
    let conn = state.conn()?;
    folders::list_deleted_folders(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_restore_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<resources::Resource, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let resource = resources::restore_resource(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({ "action": "updated", "resource_id": id }));
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "updated" }));
    Ok(resource)
}

#[tauri::command]
pub async fn cmd_restore_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<folders::Folder, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let folder = folders::restore_folder(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "created", "folder_id": id }));
    Ok(folder)
}

#[tauri::command]
pub async fn cmd_purge_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    resources::purge_resource(&conn, &id)?;
    // Write PURGE to sync_log so other devices also hard-delete
    if let Some(ctx) = state.sync_context() {
        let hlc_str = ctx.clock.tick().to_string();
        let payload = serde_json::json!({ "id": id }).to_string();
        let _ = crate::sync::sync_log::append(&conn, "resource", &id, "PURGE", &payload, &hlc_str, ctx.device_id);
    }
    let dir = storage::resource_dir(&state.base_dir, &id);
    let _ = std::fs::remove_dir_all(dir);
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({ "action": "deleted", "resource_id": id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_purge_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let result = folders::purge_folder(&conn, &id)?;
    // Write PURGE to sync_log for folder, child folders, and resources
    if let Some(ctx) = state.sync_context() {
        let hlc_str = ctx.clock.tick().to_string();
        for rid in &result.resource_ids {
            let payload = serde_json::json!({ "id": rid }).to_string();
            let _ = crate::sync::sync_log::append(&conn, "resource", rid, "PURGE", &payload, &hlc_str, ctx.device_id);
        }
        for fid in &result.child_folder_ids {
            let payload = serde_json::json!({ "id": fid }).to_string();
            let _ = crate::sync::sync_log::append(&conn, "folder", fid, "PURGE", &payload, &hlc_str, ctx.device_id);
        }
        let payload = serde_json::json!({ "id": id }).to_string();
        let _ = crate::sync::sync_log::append(&conn, "folder", &id, "PURGE", &payload, &hlc_str, ctx.device_id);
    }
    for rid in &result.resource_ids {
        let dir = storage::resource_dir(&state.base_dir, rid);
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "deleted", "folder_id": id }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_purge_all_deleted(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), CommandError> {
    let conn = state.conn()?;

    // Collect IDs before purging (need them for sync_log)
    let deleted_folder_ids: Vec<String> = folders::list_deleted_folder_ids(&conn)?;
    let deleted_resource_ids: Vec<String> = resources::list_deleted_resource_ids(&conn)?;

    // Purge deleted folders (and resources inside them) first
    let mut all_resource_ids = folders::purge_all_deleted_folders(&conn)?;
    // Then purge standalone soft-deleted resources
    let resource_ids = resources::purge_all_deleted_resources(&conn)?;
    all_resource_ids.extend(resource_ids);

    // Write PURGE entries to sync_log
    if let Some(ctx) = state.sync_context() {
        let hlc_str = ctx.clock.tick().to_string();
        for rid in &deleted_resource_ids {
            let payload = serde_json::json!({ "id": rid }).to_string();
            let _ = crate::sync::sync_log::append(&conn, "resource", rid, "PURGE", &payload, &hlc_str, ctx.device_id);
        }
        for fid in &deleted_folder_ids {
            let payload = serde_json::json!({ "id": fid }).to_string();
            let _ = crate::sync::sync_log::append(&conn, "folder", fid, "PURGE", &payload, &hlc_str, ctx.device_id);
        }
    }

    drop(conn);

    // Cleanup filesystem (best-effort)
    for rid in &all_resource_ids {
        let dir = storage::resource_dir(&state.base_dir, rid);
        let _ = std::fs::remove_dir_all(dir);
    }

    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({ "action": "deleted" }));
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({ "action": "deleted" }));

    Ok(())
}

// ── Lock Screen ──

const KEYRING_SERVICE: &str = "com.shibei.app";
const KEYRING_LOCK_PIN: &str = "lock-pin-hash";
const KEYRING_LOCK_TIMEOUT: &str = "lock-timeout-minutes";

#[tauri::command]
pub async fn cmd_setup_lock_pin(pin: String) -> Result<(), CommandError> {
    if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(CommandError { message: "error.pinMustBe4Digits".to_string() });
    }
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(pin.as_bytes(), &salt)
        .map_err(|e| CommandError { message: format!("hash error: {}", e) })?
        .to_string();

    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_PIN)
        .map_err(|e| CommandError { message: e.to_string() })?;
    entry.set_password(&hash)
        .map_err(|e| CommandError { message: e.to_string() })?;

    // Set default timeout (10 minutes)
    let timeout_entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_TIMEOUT)
        .map_err(|e| CommandError { message: e.to_string() })?;
    timeout_entry.set_password("10")
        .map_err(|e| CommandError { message: e.to_string() })?;

    Ok(())
}

#[tauri::command]
pub async fn cmd_verify_lock_pin(pin: String) -> Result<bool, CommandError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_PIN)
        .map_err(|e| CommandError { message: e.to_string() })?;
    let hash_str = match entry.get_password() {
        Ok(h) => h,
        Err(keyring::Error::NoEntry) => return Err(CommandError { message: "error.pinNotSet".to_string() }),
        Err(e) => return Err(CommandError { message: e.to_string() }),
    };
    let parsed_hash = PasswordHash::new(&hash_str)
        .map_err(|e| CommandError { message: format!("invalid hash: {}", e) })?;
    Ok(Argon2::default().verify_password(pin.as_bytes(), &parsed_hash).is_ok())
}

#[tauri::command]
pub async fn cmd_get_lock_status() -> Result<serde_json::Value, CommandError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_PIN)
        .map_err(|e| CommandError { message: e.to_string() })?;
    let enabled = match entry.get_password() {
        Ok(_) => true,
        Err(keyring::Error::NoEntry) => false,
        Err(e) => return Err(CommandError { message: e.to_string() }),
    };

    let timeout_minutes: u32 = if enabled {
        let timeout_entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_TIMEOUT)
            .map_err(|e| CommandError { message: e.to_string() })?;
        match timeout_entry.get_password() {
            Ok(v) => v.parse().unwrap_or(10),
            Err(_) => 10,
        }
    } else {
        10
    };

    Ok(serde_json::json!({
        "enabled": enabled,
        "timeout_minutes": timeout_minutes,
    }))
}

#[tauri::command]
pub async fn cmd_set_lock_timeout(minutes: u32) -> Result<(), CommandError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_TIMEOUT)
        .map_err(|e| CommandError { message: e.to_string() })?;
    entry.set_password(&minutes.to_string())
        .map_err(|e| CommandError { message: e.to_string() })?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_disable_lock_pin(pin: String) -> Result<(), CommandError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_PIN)
        .map_err(|e| CommandError { message: e.to_string() })?;
    let hash_str = match entry.get_password() {
        Ok(h) => h,
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(e) => return Err(CommandError { message: e.to_string() }),
    };
    let parsed_hash = PasswordHash::new(&hash_str)
        .map_err(|e| CommandError { message: format!("invalid hash: {}", e) })?;
    if Argon2::default().verify_password(pin.as_bytes(), &parsed_hash).is_err() {
        return Err(CommandError { message: "error.pinIncorrect".to_string() });
    }

    entry.delete_credential()
        .map_err(|e| CommandError { message: e.to_string() })?;

    if let Ok(timeout_entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_TIMEOUT) {
        let _ = timeout_entry.delete_credential();
    }

    Ok(())
}

// ── Annotation Counts ──

#[derive(Debug, Serialize)]
pub struct AnnotationCount {
    pub highlights: i64,
}

#[tauri::command]
pub async fn cmd_get_annotation_counts(
    state: tauri::State<'_, Arc<AppState>>,
    resource_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, AnnotationCount>, CommandError> {
    let conn = state.conn()?;
    let hl_counts = highlights::count_by_resource_ids(&conn, &resource_ids)?;

    let mut result = std::collections::HashMap::new();
    for id in &resource_ids {
        if let Some(&count) = hl_counts.get(id) {
            result.insert(id.clone(), AnnotationCount { highlights: count });
        }
    }
    Ok(result)
}

// ── Plain Text Summary ──

#[tauri::command]
pub async fn cmd_get_resource_summary(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
    max_chars: Option<usize>,
) -> Result<Option<String>, CommandError> {
    let conn = state.conn()?;
    let text = resources::get_plain_text(&conn, &resource_id)?;
    let limit = max_chars.unwrap_or(200);
    Ok(text.map(|t| {
        let total = t.chars().count();
        let chars: String = t.chars().take(limit).collect();
        if total > limit {
            format!("{}...", chars)
        } else {
            chars
        }
    }))
}

// ── Backup ──

#[tauri::command]
pub async fn cmd_export_backup(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<crate::backup::BackupResult, CommandError> {
    let db_path = state.base_dir.join("shibei.db");
    let base_dir = state.base_dir.clone();
    let device_id = state.device_id.clone().unwrap_or_default();
    let output_path = std::path::PathBuf::from(&path);

    tokio::task::spawn_blocking(move || {
        crate::backup::export_backup(&db_path, &base_dir, &output_path, &device_id)
    })
    .await
    .map_err(|e| CommandError { message: e.to_string() })?
    .map_err(|e| CommandError { message: e })
}

#[tauri::command]
pub async fn cmd_import_backup(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    path: String,
) -> Result<crate::backup::RestoreResult, CommandError> {
    let shared_pool = state.pool.clone();
    let base_dir = state.base_dir.clone();
    let zip_path = std::path::PathBuf::from(&path);

    let result = tokio::task::spawn_blocking(move || {
        crate::backup::import_backup(&shared_pool, &base_dir, &zip_path)
    })
    .await
    .map_err(|e| CommandError { message: e.to_string() })?
    .map_err(|e| CommandError { message: e })?;

    // Emit all domain events for full UI refresh
    use crate::events::*;
    let _ = app.emit(DATA_RESOURCE_CHANGED, serde_json::json!({"action": "restored"}));
    let _ = app.emit(DATA_FOLDER_CHANGED, serde_json::json!({"action": "restored"}));
    let _ = app.emit(DATA_TAG_CHANGED, serde_json::json!({"action": "restored"}));
    let _ = app.emit(DATA_ANNOTATION_CHANGED, serde_json::json!({"action": "restored"}));
    let _ = app.emit(DATA_CONFIG_CHANGED, serde_json::json!({"scope": "restore"}));

    Ok(result)
}

// ── Debug ──

#[tauri::command]
pub async fn cmd_debug_log(
    state: tauri::State<'_, Arc<AppState>>,
    msg: String,
) -> Result<(), CommandError> {
    use std::io::Write;
    let log_path = state.base_dir.join("debug.log");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| CommandError { message: e.to_string() })?;
    let now = chrono::Local::now().format("%H:%M:%S%.3f");
    writeln!(file, "[{now}] {msg}")
        .map_err(|e| CommandError { message: e.to_string() })?;
    Ok(())
}
