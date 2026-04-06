use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json};
use axum::routing::{get, post, put};
use axum::Router;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use tauri::Emitter;

use crate::db::{self, comments, folders, highlights, resources, search, tags};
use crate::events;
use crate::plain_text;
use crate::storage;

/// Shared state for the HTTP server.
pub struct AppState {
    pub pool: db::DbPool,
    pub base_dir: PathBuf,
    pub token: String,
    pub app_handle: tauri::AppHandle,
    pub sync_clock: Option<crate::sync::hlc::HlcClock>,
    pub device_id: Option<String>,
}

impl AppState {
    fn sync_context(&self) -> Option<crate::sync::SyncContext<'_>> {
        match (&self.sync_clock, &self.device_id) {
            (Some(clock), Some(device_id)) => Some(crate::sync::SyncContext { clock, device_id }),
            _ => None,
        }
    }
}

#[derive(Serialize)]
struct PingResponse {
    status: String,
}

#[derive(Serialize)]
struct TokenResponse {
    token: String,
}

#[derive(Serialize)]
struct FolderNode {
    id: String,
    name: String,
    children: Vec<FolderNode>,
}

#[derive(Deserialize)]
struct SaveRequest {
    title: String,
    url: String,
    domain: Option<String>,
    author: Option<String>,
    description: Option<String>,
    content: String,
    content_type: String,
    folder_id: String,
    tags: Vec<String>,
    captured_at: String,
    selection_meta: Option<String>,
}

#[derive(Serialize)]
struct SaveResponse {
    resource_id: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Deserialize)]
struct ResourcesQuery {
    folder_id: Option<String>,
    tag_ids: Option<String>, // comma-separated
    sort_by: Option<String>, // "created_at" | "annotated_at"
    sort_order: Option<String>, // "asc" | "desc"
    query: Option<String>,
}

#[derive(Serialize)]
struct ResourceWithTags {
    #[serde(flatten)]
    resource: resources::Resource,
    tags: Vec<tags::Tag>,
}

#[derive(Serialize)]
struct AnnotationsResponse {
    highlights: Vec<highlights::Highlight>,
    comments: Vec<comments::Comment>,
}

#[derive(Deserialize)]
struct ContentQuery {
    offset: Option<usize>,
    max_length: Option<usize>,
}

#[derive(Serialize)]
struct ContentResponse {
    content: String,
    total_length: usize,
    has_more: bool,
}

#[derive(Deserialize)]
struct UpdateResourceRequest {
    title: Option<String>,
    description: Option<String>,
    folder_id: Option<String>,
}

#[derive(Deserialize)]
struct CreateTagRequest {
    name: String,
    color: String,
}

#[derive(Serialize)]
struct CreateTagResponse {
    tag_id: String,
}

#[derive(Deserialize)]
struct CreateCommentRequest {
    content: String,
}

#[derive(Serialize)]
struct CreateCommentResponse {
    comment_id: String,
}

#[derive(Deserialize)]
struct UpdateCommentRequest {
    content: String,
}

/// Start the HTTP server on 127.0.0.1:21519.
pub async fn start_server(
    state: Arc<AppState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::predicate(
            |origin: &axum::http::HeaderValue, _req: &axum::http::request::Parts| {
                let Ok(s) = origin.to_str() else { return false };
                s.starts_with("chrome-extension://")
                    || s.starts_with("tauri://")
                    || s.starts_with("http://tauri.localhost")
                    || s.starts_with("http://127.0.0.1")
                    || s.starts_with("http://localhost")
            },
        ))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([axum::http::header::CONTENT_TYPE, axum::http::header::AUTHORIZATION]);

    let app = Router::new()
        .route("/api/ping", get(handle_ping))
        .route("/token", get(handle_token))
        .route("/api/folders", get(handle_folders))
        .route("/api/tags", get(handle_tags).post(handle_create_tag))
        .route("/api/folder-counts", get(handle_folder_counts))
        .route("/api/check-url", get(handle_check_url))
        .route("/api/save", post(handle_save))
        .route("/api/resources", get(handle_list_resources))
        .route(
            "/api/resources/{id}",
            get(handle_get_resource).put(handle_update_resource),
        )
        .route("/api/resources/{id}/annotations", get(handle_get_annotations))
        .route("/api/resources/{id}/content", get(handle_get_content))
        .route(
            "/api/resources/{id}/tags/{tag_id}",
            post(handle_add_tag_to_resource).delete(handle_remove_tag_from_resource),
        )
        .route(
            "/api/resources/{id}/comments",
            post(handle_create_comment),
        )
        .route("/api/comments/{id}", put(handle_update_comment))
        .with_state(state)
        .layer(cors)
        .layer(axum::extract::DefaultBodyLimit::max(100 * 1024 * 1024));

    let addr = SocketAddr::from(([127, 0, 0, 1], 21519));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn verify_token(headers: &HeaderMap, expected: &str) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if let Some(token) = auth.strip_prefix("Bearer ") {
        if token == expected {
            return Ok(());
        }
    }

    Err((
        StatusCode::UNAUTHORIZED,
        Json(ErrorResponse {
            error: "invalid or missing token".to_string(),
        }),
    ))
}

async fn handle_ping() -> Json<PingResponse> {
    Json(PingResponse {
        status: "ok".to_string(),
    })
}

async fn handle_token(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(TokenResponse {
        token: state.token.clone(),
    })
}

async fn handle_folders(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<FolderNode>>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;

    let conn = state.pool.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    let tree = build_folder_tree(&conn, "__root__", 0).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    Ok(Json(tree))
}

fn build_folder_tree(
    conn: &Connection,
    parent_id: &str,
    depth: u32,
) -> Result<Vec<FolderNode>, crate::db::DbError> {
    if depth > 20 {
        return Ok(Vec::new());
    }
    let children = folders::list_children(conn, parent_id)?;
    let mut nodes = Vec::new();
    for folder in children {
        let sub_children = build_folder_tree(conn, &folder.id, depth + 1)?;
        nodes.push(FolderNode {
            id: folder.id,
            name: folder.name,
            children: sub_children,
        });
    }
    Ok(nodes)
}

async fn handle_tags(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<tags::Tag>>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;

    let conn = state.pool.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    let tag_list = tags::list_tags(&conn).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    Ok(Json(tag_list))
}

async fn handle_folder_counts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<std::collections::HashMap<String, i64>>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;

    let conn = state.pool.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    let counts = resources::count_by_folder(&conn).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    Ok(Json(counts))
}

#[derive(Deserialize)]
struct CheckUrlQuery {
    url: String,
}

#[derive(Serialize)]
struct CheckUrlResponse {
    count: usize,
}

async fn handle_check_url(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<CheckUrlQuery>,
) -> Result<Json<CheckUrlResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = state.pool.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    let matches = resources::find_by_url(&conn, &query.url).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    Ok(Json(CheckUrlResponse {
        count: matches.len(),
    }))
}

async fn handle_save(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SaveRequest>,
) -> Result<Json<SaveResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;

    // Validate content_type
    if payload.content_type != "html" && payload.content_type != "html_fragment" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "content_type must be 'html' or 'html_fragment'".to_string(),
            }),
        ));
    }

    // Decode base64 content
    let content_bytes =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &payload.content)
            .map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("invalid base64 content: {}", e),
                    }),
                )
            })?;

    // Generate resource_id and save to filesystem
    let resource_id = uuid::Uuid::new_v4().to_string();
    let rel_path =
        storage::save_snapshot(&state.base_dir, &resource_id, &content_bytes).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("storage error: {}", e),
                }),
            )
        })?;

    let conn = state.pool.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    conn.execute_batch("BEGIN").map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("db error: {}", e),
            }),
        )
    })?;

    // Create resource in database
    let sync_ctx = state.sync_context();
    let resource = match resources::create_resource(
        &conn,
        resources::CreateResourceInput {
            id: Some(resource_id.clone()),
            title: payload.title,
            url: payload.url,
            domain: payload.domain,
            author: payload.author,
            description: payload.description,
            folder_id: payload.folder_id,
            resource_type: payload.content_type,
            file_path: rel_path.to_string_lossy().to_string(),
            captured_at: payload.captured_at,
            selection_meta: payload.selection_meta,
        },
        sync_ctx.as_ref(),
    ) {
        Ok(r) => r,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            let _ = std::fs::remove_dir_all(storage::resource_dir(&state.base_dir, &resource_id));
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("db error: {}", e),
                }),
            ));
        }
    };

    // Associate tags (create if not exist, then link)
    let all_tags = tags::list_tags(&conn).unwrap_or_default();
    for tag_name in &payload.tags {
        let tag = all_tags.iter().find(|t| t.name == *tag_name);

        let tag_id = match tag {
            Some(t) => t.id.clone(),
            None => {
                match tags::create_tag(&conn, tag_name, "#888888", sync_ctx.as_ref()) {
                    Ok(new_tag) => new_tag.id,
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        let _ = std::fs::remove_dir_all(
                            storage::resource_dir(&state.base_dir, &resource_id),
                        );
                        return Err((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(ErrorResponse {
                                error: format!("tag error: {}", e),
                            }),
                        ));
                    }
                }
            }
        };

        if let Err(e) = tags::add_tag_to_resource(&conn, &resource.id, &tag_id, sync_ctx.as_ref()) {
            let _ = conn.execute_batch("ROLLBACK");
            let _ =
                std::fs::remove_dir_all(storage::resource_dir(&state.base_dir, &resource_id));
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("tag association error: {}", e),
                }),
            ));
        }
    }

    conn.execute_batch("COMMIT").map_err(|e| {
        let _ = std::fs::remove_dir_all(storage::resource_dir(&state.base_dir, &resource_id));
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("db error: {}", e),
            }),
        )
    })?;

    // Extract and store plain text (best-effort, don't fail the save)
    {
        let html_str = String::from_utf8_lossy(&content_bytes);
        let text = plain_text::extract_plain_text(&html_str);
        if !text.is_empty() {
            let _ = resources::set_plain_text(&conn, &resource.id, &text);
        }
    }

    // Notify desktop app that a new resource was saved (best-effort, outside transaction)
    let _ = state.app_handle.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({
        "action": "created",
        "resource_id": resource.id,
        "folder_id": resource.folder_id,
    }));

    Ok(Json(SaveResponse {
        resource_id: resource.id,
    }))
}

fn map_db_error(e: db::DbError) -> (StatusCode, Json<ErrorResponse>) {
    match &e {
        db::DbError::NotFound(_) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        ),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        ),
    }
}

fn get_conn(
    state: &AppState,
) -> Result<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>, (StatusCode, Json<ErrorResponse>)>
{
    state.pool.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })
}

async fn handle_list_resources(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<ResourcesQuery>,
) -> Result<Json<Vec<resources::Resource>>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;

    let tag_ids: Vec<String> = q
        .tag_ids
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let sort_by_str = q.sort_by.as_deref().unwrap_or("created_at");
    let sort_order_str = q.sort_order.as_deref().unwrap_or("desc");

    let sort_by = match sort_by_str {
        "annotated_at" => resources::SortBy::AnnotatedAt,
        _ => resources::SortBy::CreatedAt,
    };
    let sort_order = match sort_order_str {
        "asc" => resources::SortOrder::Asc,
        _ => resources::SortOrder::Desc,
    };

    // If query present and >= 2 chars, use search
    if let Some(ref query) = q.query {
        if query.chars().count() >= 2 {
            let results = search::search_resources(
                &conn,
                query,
                q.folder_id.as_deref(),
                &tag_ids,
                sort_by_str,
                sort_order_str,
            )
            .map_err(map_db_error)?;
            return Ok(Json(results));
        }
    }

    let results = if let Some(ref folder_id) = q.folder_id {
        resources::list_resources_by_folder(&conn, folder_id, sort_by, sort_order, &tag_ids)
            .map_err(map_db_error)?
    } else {
        resources::list_all_resources(&conn, sort_by, sort_order, &tag_ids)
            .map_err(map_db_error)?
    };

    Ok(Json(results))
}

async fn handle_get_resource(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<ResourceWithTags>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;

    let resource = resources::get_resource(&conn, &id).map_err(map_db_error)?;
    let resource_tags = tags::get_tags_for_resource(&conn, &id).map_err(map_db_error)?;

    Ok(Json(ResourceWithTags {
        resource,
        tags: resource_tags,
    }))
}

async fn handle_get_annotations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<AnnotationsResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;

    // Verify resource exists
    let _ = resources::get_resource(&conn, &id).map_err(map_db_error)?;

    let highlight_list =
        highlights::get_highlights_for_resource(&conn, &id).map_err(map_db_error)?;
    let comment_list = comments::get_comments_for_resource(&conn, &id).map_err(map_db_error)?;

    Ok(Json(AnnotationsResponse {
        highlights: highlight_list,
        comments: comment_list,
    }))
}

async fn handle_get_content(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<ContentQuery>,
) -> Result<Json<ContentResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;

    // Verify resource exists
    let _ = resources::get_resource(&conn, &id).map_err(map_db_error)?;

    // Try to get plain_text from DB
    let mut text = resources::get_plain_text(&conn, &id).map_err(map_db_error)?;

    // If null, try lazy-fill from snapshot file
    if text.is_none() {
        let snapshot_path = state.base_dir.join("storage").join(&id).join("snapshot.html");
        if snapshot_path.exists() {
            if let Ok(html) = std::fs::read_to_string(&snapshot_path) {
                let extracted = plain_text::extract_plain_text(&html);
                if !extracted.is_empty() {
                    let _ = resources::set_plain_text(&conn, &id, &extracted);
                    text = Some(extracted);
                }
            }
        }
    }

    let text = match text {
        Some(t) if !t.is_empty() => t,
        _ => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "Content not available. Please open this resource in Shibei app to download the snapshot first.".to_string(),
                }),
            ));
        }
    };

    let offset = q.offset.unwrap_or(0);
    let max_length = q.max_length.unwrap_or(50000);
    let total_length = text.chars().count();
    let content: String = text.chars().skip(offset).take(max_length).collect();
    let has_more = offset + max_length < total_length;

    Ok(Json(ContentResponse {
        content,
        total_length,
        has_more,
    }))
}

async fn handle_update_resource(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(payload): Json<UpdateResourceRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();

    // Get current resource (404 if not found)
    let current = resources::get_resource(&conn, &id).map_err(map_db_error)?;

    // Update title/description if provided
    if payload.title.is_some() || payload.description.is_some() {
        let title = payload.title.as_deref().unwrap_or(&current.title);
        let description = if payload.description.is_some() {
            payload.description.as_deref()
        } else {
            current.description.as_deref()
        };
        resources::update_resource(&conn, &id, title, description, sync_ctx.as_ref())
            .map_err(map_db_error)?;
    }

    // Move to new folder if provided
    if let Some(ref folder_id) = payload.folder_id {
        resources::move_resource(&conn, &id, folder_id, sync_ctx.as_ref())
            .map_err(map_db_error)?;
    }

    let _ = state.app_handle.emit(
        events::DATA_RESOURCE_CHANGED,
        serde_json::json!({
            "action": "updated",
            "resource_id": id,
        }),
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn handle_create_tag(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<CreateTagRequest>,
) -> Result<Json<CreateTagResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();

    let tag =
        tags::create_tag(&conn, &payload.name, &payload.color, sync_ctx.as_ref())
            .map_err(map_db_error)?;

    let _ = state.app_handle.emit(
        events::DATA_TAG_CHANGED,
        serde_json::json!({
            "action": "created",
            "tag_id": tag.id,
        }),
    );

    Ok(Json(CreateTagResponse { tag_id: tag.id }))
}

async fn handle_add_tag_to_resource(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path((resource_id, tag_id)): axum::extract::Path<(String, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();

    tags::add_tag_to_resource(&conn, &resource_id, &tag_id, sync_ctx.as_ref())
        .map_err(map_db_error)?;

    let _ = state.app_handle.emit(
        events::DATA_TAG_CHANGED,
        serde_json::json!({
            "action": "updated",
            "resource_id": resource_id,
            "tag_id": tag_id,
        }),
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn handle_remove_tag_from_resource(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path((resource_id, tag_id)): axum::extract::Path<(String, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();

    tags::remove_tag_from_resource(&conn, &resource_id, &tag_id, sync_ctx.as_ref())
        .map_err(map_db_error)?;

    let _ = state.app_handle.emit(
        events::DATA_TAG_CHANGED,
        serde_json::json!({
            "action": "updated",
            "resource_id": resource_id,
            "tag_id": tag_id,
        }),
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn handle_create_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(resource_id): axum::extract::Path<String>,
    Json(payload): Json<CreateCommentRequest>,
) -> Result<Json<CreateCommentResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();

    let comment = comments::create_comment(
        &conn,
        &resource_id,
        None,
        &payload.content,
        sync_ctx.as_ref(),
    )
    .map_err(map_db_error)?;

    let _ = state.app_handle.emit(
        events::DATA_ANNOTATION_CHANGED,
        serde_json::json!({
            "action": "created",
            "resource_id": resource_id,
        }),
    );

    Ok(Json(CreateCommentResponse {
        comment_id: comment.id,
    }))
}

async fn handle_update_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(payload): Json<UpdateCommentRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();

    comments::update_comment(&conn, &id, &payload.content, sync_ctx.as_ref())
        .map_err(map_db_error)?;

    let _ = state.app_handle.emit(
        events::DATA_ANNOTATION_CHANGED,
        serde_json::json!({
            "action": "updated",
            "comment_id": id,
        }),
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}
