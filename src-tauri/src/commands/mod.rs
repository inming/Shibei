use std::sync::Arc;

use serde::Serialize;

use crate::db::{self, comments, folders, highlights, resources, tags, DbError};
use crate::storage;

/// Shared application state managed by Tauri.
pub struct AppState {
    pub pool: db::DbPool,
    pub base_dir: std::path::PathBuf,
    pub auth_token: String,
    pub sync_clock: Option<crate::sync::hlc::HlcClock>,
    pub device_id: Option<String>,
    pub sync_engine: Option<Arc<crate::sync::engine::SyncEngine>>,
}

impl AppState {
    pub fn sync_context(&self) -> Option<crate::sync::SyncContext<'_>> {
        match (&self.sync_clock, &self.device_id) {
            (Some(clock), Some(device_id)) => Some(crate::sync::SyncContext { clock, device_id }),
            _ => None,
        }
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    folders::list_children(&conn, &parent_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_folder(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    parent_id: String,
) -> Result<folders::Folder, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    folders::create_folder(&conn, &name, &parent_id, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_rename_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    name: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    folders::rename_folder(&conn, &id, &name, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<String>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let resource_ids = folders::delete_folder(&conn, &id, sync_ctx.as_ref())?;
    // Clean up filesystem (best-effort)
    for rid in &resource_ids {
        let dir = storage::resource_dir(&state.base_dir, rid);
        let _ = std::fs::remove_dir_all(dir);
    }
    Ok(resource_ids)
}

#[tauri::command]
pub async fn cmd_move_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    new_parent_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    folders::move_folder(&conn, &id, &new_parent_id, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_reorder_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    new_sort_order: i64,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    folders::reorder_folder(&conn, &id, new_sort_order, sync_ctx.as_ref()).map_err(Into::into)
}

// ── Resources ──

#[tauri::command]
pub async fn cmd_list_resources(
    state: tauri::State<'_, Arc<AppState>>,
    folder_id: String,
    sort_by: Option<resources::SortBy>,
    sort_order: Option<resources::SortOrder>,
) -> Result<Vec<resources::Resource>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    resources::list_resources_by_folder(
        &conn,
        &folder_id,
        sort_by.unwrap_or(resources::SortBy::CreatedAt),
        sort_order.unwrap_or(resources::SortOrder::Desc),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_resource(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<resources::Resource, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    resources::get_resource(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_resource(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let rid = resources::delete_resource(&conn, &id, sync_ctx.as_ref())?;
    drop(conn);
    let dir = storage::resource_dir(&state.base_dir, &rid);
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        eprintln!("[shibei] Failed to clean up resource directory {:?}: {}", dir, e);
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_move_resource(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    new_folder_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    resources::move_resource(&conn, &id, &new_folder_id, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_update_resource(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    title: String,
    description: Option<String>,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    resources::update_resource(&conn, &id, &title, description.as_deref(), sync_ctx.as_ref()).map_err(Into::into)
}

// ── Tags ──

#[tauri::command]
pub async fn cmd_list_tags(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<tags::Tag>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    tags::list_tags(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_tag(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    color: String,
) -> Result<tags::Tag, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::create_tag(&conn, &name, &color, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_tag(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::delete_tag(&conn, &id, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_tags_for_resource(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<tags::Tag>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    tags::get_tags_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_add_tag_to_resource(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::add_tag_to_resource(&conn, &resource_id, &tag_id, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_remove_tag_from_resource(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::remove_tag_from_resource(&conn, &resource_id, &tag_id, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_update_tag(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    name: String,
    color: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::update_tag(&conn, &id, &name, &color, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_resources_by_tag(
    state: tauri::State<'_, Arc<AppState>>,
    tag_id: String,
) -> Result<Vec<resources::Resource>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    tags::get_resources_by_tag(&conn, &tag_id).map_err(Into::into)
}

// ── Highlights ──

#[tauri::command]
pub async fn cmd_get_highlights(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<highlights::Highlight>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    highlights::get_highlights_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
    text_content: String,
    anchor: highlights::Anchor,
    color: String,
) -> Result<highlights::Highlight, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    highlights::create_highlight(&conn, &resource_id, &text_content, &anchor, &color, sync_ctx.as_ref())
        .map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    highlights::delete_highlight(&conn, &id, sync_ctx.as_ref()).map_err(Into::into)
}

// ── Comments ──

#[tauri::command]
pub async fn cmd_get_comments(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<comments::Comment>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    comments::get_comments_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_comment(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
    highlight_id: Option<String>,
    content: String,
) -> Result<comments::Comment, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    comments::create_comment(&conn, &resource_id, highlight_id.as_deref(), &content, sync_ctx.as_ref())
        .map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_update_comment(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    content: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    comments::update_comment(&conn, &id, &content, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_comment(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    comments::delete_comment(&conn, &id, sync_ctx.as_ref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_folder_counts(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<std::collections::HashMap<String, i64>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    resources::count_by_folder(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_non_leaf_folder_ids(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<String>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
pub async fn cmd_sync_now(state: tauri::State<'_, Arc<AppState>>) -> Result<String, CommandError> {
    let engine = build_sync_engine(&state)?;
    let result = engine.sync().await
        .map_err(|e| CommandError { message: e.to_string() })?;
    Ok(format!("{:?}", result))
}

/// Build a SyncEngine from current config. Called on each sync to pick up latest settings.
fn build_sync_engine(state: &AppState) -> Result<crate::sync::engine::SyncEngine, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let region = crate::sync::sync_state::get(&conn, "config:s3_region")?
        .ok_or_else(|| CommandError { message: "请先配置同步设置（Region 未设置）".to_string() })?;
    let bucket = crate::sync::sync_state::get(&conn, "config:s3_bucket")?
        .ok_or_else(|| CommandError { message: "请先配置同步设置（Bucket 未设置）".to_string() })?;
    let endpoint = crate::sync::sync_state::get(&conn, "config:s3_endpoint")?.unwrap_or_default();
    let (access_key, secret_key) = crate::sync::credentials::load_credentials(&conn)?
        .ok_or_else(|| CommandError { message: "请先配置同步设置（凭据未设置）".to_string() })?;

    let s3_config = crate::sync::backend::S3Config {
        endpoint: if endpoint.is_empty() { None } else { Some(endpoint) },
        region,
        bucket,
        access_key,
        secret_key,
    };
    let backend = crate::sync::backend::S3Backend::new(s3_config)
        .map_err(|e| CommandError { message: e.to_string() })?;

    let device_id = state.device_id.as_ref()
        .ok_or_else(|| CommandError { message: "Device ID not initialized".to_string() })?;
    let clock = Arc::new(crate::sync::hlc::HlcClock::new(device_id.clone()));

    Ok(crate::sync::engine::SyncEngine::new(
        state.pool.clone(),
        Arc::new(backend),
        device_id.clone(),
        clock,
        state.base_dir.clone(),
    ))
}

#[tauri::command]
pub async fn cmd_save_sync_config(
    state: tauri::State<'_, Arc<AppState>>,
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    crate::sync::sync_state::set(&conn, "config:s3_endpoint", &endpoint)?;
    crate::sync::sync_state::set(&conn, "config:s3_region", &region)?;
    crate::sync::sync_state::set(&conn, "config:s3_bucket", &bucket)?;
    // Only update credentials if not placeholder
    if access_key != "__keep__" && secret_key != "__keep__" {
        crate::sync::credentials::store_credentials(&conn, &access_key, &secret_key)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_sync_config(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let endpoint = crate::sync::sync_state::get(&conn, "config:s3_endpoint")?.unwrap_or_default();
    let region = crate::sync::sync_state::get(&conn, "config:s3_region")?.unwrap_or_default();
    let bucket = crate::sync::sync_state::get(&conn, "config:s3_bucket")?.unwrap_or_default();
    let has_credentials = crate::sync::credentials::load_credentials(&conn)
        .map(|c| c.is_some()).unwrap_or(false);
    let last_sync = crate::sync::sync_state::get(&conn, "last_sync_at")?.unwrap_or_default();
    Ok(serde_json::json!({
        "endpoint": endpoint,
        "region": region,
        "bucket": bucket,
        "has_credentials": has_credentials,
        "last_sync_at": last_sync,
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    resource_id: String,
) -> Result<bool, CommandError> {
    let engine = build_sync_engine(&state)?;
    engine.download_snapshot(&resource_id).await
        .map_err(|e| CommandError { message: e.to_string() })?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_get_snapshot_status(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<String, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let status = crate::sync::sync_state::get(&conn, &format!("snapshot:{}", resource_id))?
        .unwrap_or_else(|| "synced".to_string());
    Ok(status)
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
