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
    app: tauri::AppHandle,
    name: String,
    parent_id: String,
) -> Result<folders::Folder, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let resource_ids = folders::delete_folder(&conn, &id, sync_ctx.as_ref())?;
    // Clean up filesystem (best-effort)
    for rid in &resource_ids {
        let dir = storage::resource_dir(&state.base_dir, rid);
        let _ = std::fs::remove_dir_all(dir);
    }
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    folders::get_folder(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_folder_path(
    state: tauri::State<'_, Arc<AppState>>,
    folder_id: String,
) -> Result<Vec<folders::Folder>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    folders::get_folder_path(&conn, &folder_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_reorder_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    new_sort_order: i64,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let folder_id = resources::get_resource(&conn, &id)?.folder_id;
    let sync_ctx = state.sync_context();
    let rid = resources::delete_resource(&conn, &id, sync_ctx.as_ref())?;
    drop(conn);
    let dir = storage::resource_dir(&state.base_dir, &rid);
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        eprintln!("[shibei] Failed to clean up resource directory {:?}: {}", dir, e);
    }
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
) -> Result<Vec<resources::Resource>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    resources::list_all_resources(
        &conn,
        sort_by.unwrap_or(resources::SortBy::CreatedAt),
        sort_order.unwrap_or(resources::SortOrder::Desc),
    )
    .map_err(Into::into)
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
    app: tauri::AppHandle,
    name: String,
    color: String,
) -> Result<tags::Tag, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    tags::get_tags_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_add_tag_to_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    app: tauri::AppHandle,
    resource_id: String,
    text_content: String,
    anchor: highlights::Anchor,
    color: String,
) -> Result<highlights::Highlight, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let highlight = highlights::create_highlight(&conn, &resource_id, &text_content, &anchor, &color, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({ "action": "created", "resource_id": resource_id }));
    Ok(highlight)
}

#[tauri::command]
pub async fn cmd_delete_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    resource_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    comments::delete_comment(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({ "action": "deleted", "resource_id": resource_id }));
    Ok(())
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
pub async fn cmd_sync_now(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    app: tauri::AppHandle,
) -> Result<String, CommandError> {
    let _ = app.emit(events::SYNC_STARTED, ());
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
    let _ = app.emit(events::DATA_SYNC_COMPLETED, ());
    Ok(format!("{:?}", result))
}

/// Build a SyncEngine from current config. Called on each sync to pick up latest settings.
/// If encryption is enabled, wraps the backend with EncryptedBackend.
/// Multi-device detection: if local doesn't know about encryption, check remote keyring.json.
async fn build_sync_engine(
    state: &AppState,
    encryption_state: &crate::sync::EncryptionState,
) -> Result<crate::sync::engine::SyncEngine, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;

    let local_encryption_enabled = crate::sync::sync_state::get(&conn, "config:encryption_enabled")?
        .map(|v| v == "true")
        .unwrap_or(false);

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
            // Another device enabled encryption — mark locally
            crate::sync::sync_state::set(&conn, "config:encryption_enabled", "true")?;
            true
        } else {
            false
        }
    };

    let backend: Arc<dyn crate::sync::backend::SyncBackend> = if encryption_enabled {
        let mk = encryption_state.get_key().ok_or_else(|| CommandError {
            message: "加密已启用但未解锁，请先输入加密密码".to_string(),
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let region = crate::sync::sync_state::get(&conn, "config:s3_region")?
        .ok_or_else(|| CommandError { message: "请先配置同步设置（Region 未设置）".to_string() })?;
    let bucket = crate::sync::sync_state::get(&conn, "config:s3_bucket")?
        .ok_or_else(|| CommandError { message: "请先配置同步设置（Bucket 未设置）".to_string() })?;
    let endpoint = crate::sync::sync_state::get(&conn, "config:s3_endpoint")?.unwrap_or_default();
    let (access_key, secret_key) = crate::sync::credentials::load_credentials(&conn)?
        .ok_or_else(|| CommandError { message: "请先配置同步设置（凭据未设置）".to_string() })?;

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
        .map_err(|e| CommandError { message: format!("密钥生成失败: {}", e) })?;
    let mk = keyring.unlock(&password)
        .map_err(|e| CommandError { message: format!("密钥验证失败: {}", e) })?;

    // 2. Upload keyring.json via raw backend
    let backend = build_raw_s3_backend(&state)?;
    let keyring_json = keyring.to_json()
        .map_err(|e| CommandError { message: e.to_string() })?;
    backend.upload("meta/keyring.json", keyring_json.as_bytes()).await
        .map_err(|e| CommandError { message: format!("上传密钥文件失败: {}", e) })?;

    // 3. Clear all existing S3 data
    for prefix in &["sync/", "state/", "snapshots/"] {
        let objects = backend.list(prefix).await
            .map_err(|e| CommandError { message: e.to_string() })?;
        for obj in objects {
            let _ = backend.delete(&obj.key).await;
        }
    }

    // 4. Reset local sync progress
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
        .map_err(|e| CommandError { message: format!("下载密钥文件失败: {}", e) })?;
    let json = String::from_utf8(data)
        .map_err(|e| CommandError { message: format!("密钥文件格式错误: {}", e) })?;
    let keyring = Keyring::from_json(&json)
        .map_err(|e| CommandError { message: format!("密钥文件解析失败: {}", e) })?;

    let mk = keyring.unlock(&password).map_err(|e| match e {
        crate::sync::keyring::KeyringError::WrongPassword => {
            CommandError { message: "密码错误".to_string() }
        }
        crate::sync::keyring::KeyringError::Tampered => {
            CommandError { message: "密钥文件可能被篡改，请检查".to_string() }
        }
        other => CommandError { message: format!("解锁失败: {}", other) },
    })?;

    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;

    // Only reset sync progress on first unlock (new device joining)
    let is_first_unlock = !crate::sync::sync_state::get(&conn, "config:encryption_enabled")?
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
        .map_err(|e| CommandError { message: format!("下载密钥文件失败: {}", e) })?;
    let json = String::from_utf8(data)
        .map_err(|e| CommandError { message: format!("密钥文件格式错误: {}", e) })?;
    let keyring = Keyring::from_json(&json)
        .map_err(|e| CommandError { message: format!("密钥文件解析失败: {}", e) })?;

    let new_keyring = keyring.change_password(&old_password, &new_password).map_err(|e| match e {
        crate::sync::keyring::KeyringError::WrongPassword => {
            CommandError { message: "旧密码错误".to_string() }
        }
        other => CommandError { message: format!("修改密码失败: {}", other) },
    })?;

    let new_json = new_keyring.to_json()
        .map_err(|e| CommandError { message: e.to_string() })?;
    backend.upload("meta/keyring.json", new_json.as_bytes()).await
        .map_err(|e| CommandError { message: format!("上传密钥文件失败: {}", e) })?;

    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({ "scope": "encryption" }));
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_encryption_status(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
) -> Result<serde_json::Value, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
        let conn = state
            .pool
            .get()
            .map_err(|e| CommandError {
                message: e.to_string(),
            })?;
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

    let conn = state
        .pool
        .get()
        .map_err(|e| CommandError {
            message: e.to_string(),
        })?;

    if remember {
        let mk = encryption_state.get_key().ok_or_else(|| CommandError {
            message: "加密未解锁，无法保存密钥".to_string(),
        })?;
        os_keystore::save_master_key(&mk).map_err(|e| CommandError {
            message: format!("保存到系统钥匙串失败: {}", e),
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
    let conn = state
        .pool
        .get()
        .map_err(|e| CommandError {
            message: e.to_string(),
        })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    crate::sync::sync_state::set(&conn, "config:sync_interval", &minutes.to_string())?;
    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({ "scope": "sync" }));
    Ok(())
}

// ── Recycle Bin ──

#[tauri::command]
pub async fn cmd_list_deleted_resources(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<resources::DeletedResource>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    resources::list_deleted_resources(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_list_deleted_folders(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<folders::DeletedFolder>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    folders::list_deleted_folders(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_restore_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<resources::Resource, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    resources::purge_resource(&conn, &id)?;
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let resource_ids = folders::purge_folder(&conn, &id)?;
    for rid in &resource_ids {
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
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;

    // Purge deleted folders (and resources inside them) first
    let mut all_resource_ids = folders::purge_all_deleted_folders(&conn)?;
    // Then purge standalone soft-deleted resources
    let resource_ids = resources::purge_all_deleted_resources(&conn)?;
    all_resource_ids.extend(resource_ids);

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
        return Err(CommandError { message: "PIN 必须为 4 位数字".to_string() });
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
        Err(keyring::Error::NoEntry) => return Err(CommandError { message: "未设置 PIN".to_string() }),
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
        return Err(CommandError { message: "PIN 不正确".to_string() });
    }

    entry.delete_credential()
        .map_err(|e| CommandError { message: e.to_string() })?;

    if let Ok(timeout_entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_LOCK_TIMEOUT) {
        let _ = timeout_entry.delete_credential();
    }

    Ok(())
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
