use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::db::{comments, folders, highlights, resources, tags, DbError};
use crate::storage;

/// Shared application state managed by Tauri.
pub struct AppState {
    pub conn: Mutex<Connection>,
    pub base_dir: std::path::PathBuf,
    pub auth_token: String,
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
    let conn = state.conn.lock().await;
    folders::list_children(&conn, &parent_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_folder(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    parent_id: String,
) -> Result<folders::Folder, CommandError> {
    let conn = state.conn.lock().await;
    folders::create_folder(&conn, &name, &parent_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_rename_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    name: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    folders::rename_folder(&conn, &id, &name).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<String>, CommandError> {
    let conn = state.conn.lock().await;
    let resource_ids = folders::delete_folder(&conn, &id)?;
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
    let conn = state.conn.lock().await;
    folders::move_folder(&conn, &id, &new_parent_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_reorder_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    new_sort_order: i64,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    folders::reorder_folder(&conn, &id, new_sort_order).map_err(Into::into)
}

// ── Resources ──

#[tauri::command]
pub async fn cmd_list_resources(
    state: tauri::State<'_, Arc<AppState>>,
    folder_id: String,
    sort_by: Option<resources::SortBy>,
    sort_order: Option<resources::SortOrder>,
) -> Result<Vec<resources::Resource>, CommandError> {
    let conn = state.conn.lock().await;
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
    let conn = state.conn.lock().await;
    resources::get_resource(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_resource(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    let rid = resources::delete_resource(&conn, &id)?;
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
    let conn = state.conn.lock().await;
    resources::move_resource(&conn, &id, &new_folder_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_update_resource(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    title: String,
    description: Option<String>,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    resources::update_resource(&conn, &id, &title, description.as_deref()).map_err(Into::into)
}

// ── Tags ──

#[tauri::command]
pub async fn cmd_list_tags(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<tags::Tag>, CommandError> {
    let conn = state.conn.lock().await;
    tags::list_tags(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_tag(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    color: String,
) -> Result<tags::Tag, CommandError> {
    let conn = state.conn.lock().await;
    tags::create_tag(&conn, &name, &color).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_tag(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    tags::delete_tag(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_tags_for_resource(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<tags::Tag>, CommandError> {
    let conn = state.conn.lock().await;
    tags::get_tags_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_add_tag_to_resource(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    tags::add_tag_to_resource(&conn, &resource_id, &tag_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_remove_tag_from_resource(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    tags::remove_tag_from_resource(&conn, &resource_id, &tag_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_update_tag(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    name: String,
    color: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    tags::update_tag(&conn, &id, &name, &color).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_resources_by_tag(
    state: tauri::State<'_, Arc<AppState>>,
    tag_id: String,
) -> Result<Vec<resources::Resource>, CommandError> {
    let conn = state.conn.lock().await;
    tags::get_resources_by_tag(&conn, &tag_id).map_err(Into::into)
}

// ── Highlights ──

#[tauri::command]
pub async fn cmd_get_highlights(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<highlights::Highlight>, CommandError> {
    let conn = state.conn.lock().await;
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
    let conn = state.conn.lock().await;
    highlights::create_highlight(&conn, &resource_id, &text_content, &anchor, &color)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    highlights::delete_highlight(&conn, &id).map_err(Into::into)
}

// ── Comments ──

#[tauri::command]
pub async fn cmd_get_comments(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
) -> Result<Vec<comments::Comment>, CommandError> {
    let conn = state.conn.lock().await;
    comments::get_comments_for_resource(&conn, &resource_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_comment(
    state: tauri::State<'_, Arc<AppState>>,
    resource_id: String,
    highlight_id: Option<String>,
    content: String,
) -> Result<comments::Comment, CommandError> {
    let conn = state.conn.lock().await;
    comments::create_comment(&conn, &resource_id, highlight_id.as_deref(), &content)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_update_comment(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    content: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    comments::update_comment(&conn, &id, &content).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_delete_comment(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn.lock().await;
    comments::delete_comment(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_folder_counts(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<std::collections::HashMap<String, i64>, CommandError> {
    let conn = state.conn.lock().await;
    resources::count_by_folder(&conn).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_non_leaf_folder_ids(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<String>, CommandError> {
    let conn = state.conn.lock().await;
    let set = folders::parent_ids_with_children(&conn).map_err(CommandError::from)?;
    Ok(set.into_iter().collect())
}

#[tauri::command]
pub async fn cmd_get_auth_token(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, CommandError> {
    Ok(state.auth_token.clone())
}
