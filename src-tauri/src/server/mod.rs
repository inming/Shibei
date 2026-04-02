use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json};
use axum::routing::{get, post};
use axum::Router;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use tauri::Emitter;

use crate::db::{self, folders, resources, tags};
use crate::storage;

/// Shared state for the HTTP server.
pub struct AppState {
    pub pool: db::DbPool,
    pub base_dir: PathBuf,
    pub token: String,
    pub app_handle: tauri::AppHandle,
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
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST, axum::http::Method::OPTIONS])
        .allow_headers([axum::http::header::CONTENT_TYPE, axum::http::header::AUTHORIZATION]);

    let app = Router::new()
        .route("/api/ping", get(handle_ping))
        .route("/token", get(handle_token))
        .route("/api/folders", get(handle_folders))
        .route("/api/tags", get(handle_tags))
        .route("/api/folder-counts", get(handle_folder_counts))
        .route("/api/check-url", get(handle_check_url))
        .route("/api/save", post(handle_save))
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
                match tags::create_tag(&conn, tag_name, "#888888") {
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

        if let Err(e) = tags::add_tag_to_resource(&conn, &resource.id, &tag_id) {
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

    // Notify desktop app that a new resource was saved (best-effort, outside transaction)
    let _ = state.app_handle.emit("resource-saved", serde_json::json!({
        "resource_id": resource.id,
        "folder_id": resource.folder_id,
    }));

    Ok(Json(SaveResponse {
        resource_id: resource.id,
    }))
}
