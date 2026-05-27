//! HTTP handlers for the questions system. Used by the MCP server and
//! anything else that wants to drive questions without going through the
//! Tauri command channel.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::db::questions;
use crate::events;

use super::{get_conn, verify_token, AppState, ErrorResponse};

#[derive(Deserialize)]
pub struct ListQuestionsQuery {
    pub status: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateQuestionRequest {
    pub title: String,
    pub description: Option<String>,
}

#[derive(Serialize)]
pub struct CreateQuestionResponse {
    pub question_id: String,
}

/// PUT body: pass any subset.
/// - `title` + `description` → edit metadata
/// - `status` ∈ {"active", "archived"} → archive / unarchive (combined with
///   edit in one call: edit first, then status transition)
#[derive(Deserialize)]
pub struct UpdateQuestionRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateLinkRequest {
    pub target_type: String,
    pub target_id: String,
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct CreateLinkResponse {
    pub link_id: String,
}

#[derive(Deserialize)]
pub struct UpdateLinkRequest {
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct ForTargetQuery {
    pub target_type: String,
    pub target_id: String,
}

fn db_err(e: impl std::fmt::Display) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: e.to_string(),
        }),
    )
}

fn not_found(msg: impl Into<String>) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::NOT_FOUND, Json(ErrorResponse { error: msg.into() }))
}

fn bad_request(msg: impl Into<String>) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: msg.into() }))
}

pub async fn handle_list_questions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ListQuestionsQuery>,
) -> Result<Json<Vec<questions::Question>>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    questions::list_questions(&conn, q.status.as_deref())
        .map(Json)
        .map_err(db_err)
}

pub async fn handle_get_question(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<questions::Question>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    questions::get_question(&conn, &id).map(Json).map_err(|e| match e {
        crate::db::DbError::NotFound(_) => not_found(e.to_string()),
        other => db_err(other),
    })
}

pub async fn handle_create_question(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateQuestionRequest>,
) -> Result<Json<CreateQuestionResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();
    let q = questions::create_question(&conn, &body.title, body.description.as_deref(), sync_ctx.as_ref())
        .map_err(db_err)?;
    let _ = state.app_handle.emit(
        events::DATA_QUESTION_CHANGED,
        serde_json::json!({ "action": "created", "question_id": q.id }),
    );
    Ok(Json(CreateQuestionResponse { question_id: q.id }))
}

pub async fn handle_update_question(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<UpdateQuestionRequest>,
) -> Result<Json<questions::Question>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();

    // Fetch existing so missing fields fall through.
    let existing = questions::get_question(&conn, &id).map_err(|e| match e {
        crate::db::DbError::NotFound(_) => not_found(e.to_string()),
        other => db_err(other),
    })?;

    // Apply edit first (title / description). Even if the caller only sent
    // `status`, this is a no-op safe rewrite.
    let new_title = body.title.unwrap_or(existing.title);
    let new_desc = body.description.or(existing.description);
    questions::update_question(&conn, &id, &new_title, new_desc.as_deref(), sync_ctx.as_ref())
        .map_err(db_err)?;

    // Then apply status transition if requested. Ignore no-op transitions
    // (already in the requested state).
    if let Some(requested_status) = body.status.as_deref() {
        match requested_status {
            "active" if existing.status == "archived" => {
                questions::unarchive_question(&conn, &id, sync_ctx.as_ref()).map_err(db_err)?;
            }
            "archived" if existing.status == "active" => {
                questions::archive_question(&conn, &id, sync_ctx.as_ref()).map_err(db_err)?;
            }
            "active" | "archived" => {
                // already in this state — no-op
            }
            other => {
                return Err(bad_request(format!("invalid status: {}", other)));
            }
        }
    }

    let action = if body.status.is_some() {
        if body.status.as_deref() == Some("archived") {
            "archived"
        } else {
            "unarchived"
        }
    } else {
        "updated"
    };
    let _ = state.app_handle.emit(
        events::DATA_QUESTION_CHANGED,
        serde_json::json!({ "action": action, "question_id": id }),
    );

    let updated = questions::get_question(&conn, &id).map_err(db_err)?;
    Ok(Json(updated))
}

pub async fn handle_delete_question(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();
    questions::delete_question(&conn, &id, sync_ctx.as_ref()).map_err(|e| match e {
        crate::db::DbError::NotFound(_) => not_found(e.to_string()),
        other => db_err(other),
    })?;
    let _ = state.app_handle.emit(
        events::DATA_QUESTION_CHANGED,
        serde_json::json!({ "action": "deleted", "question_id": id }),
    );
    let _ = state.app_handle.emit(
        events::DATA_QUESTION_LINK_CHANGED,
        serde_json::json!({ "action": "unlinked", "question_id": id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn handle_list_question_links(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Vec<questions::QuestionLink>>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    questions::list_links_for_question(&conn, &id)
        .map(Json)
        .map_err(db_err)
}

pub async fn handle_create_link(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CreateLinkRequest>,
) -> Result<Json<CreateLinkResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();
    let link = questions::link(
        &conn,
        &id,
        &body.target_type,
        &body.target_id,
        body.reason.as_deref(),
        sync_ctx.as_ref(),
    )
    .map_err(|e| match e {
        crate::db::DbError::InvalidOperation(msg) => bad_request(msg),
        crate::db::DbError::NotFound(_) => not_found(e.to_string()),
        other => db_err(other),
    })?;
    let _ = state.app_handle.emit(
        events::DATA_QUESTION_LINK_CHANGED,
        serde_json::json!({
            "action": "linked",
            "question_id": id,
            "target_type": body.target_type,
            "target_id": body.target_id,
        }),
    );
    Ok(Json(CreateLinkResponse { link_id: link.id }))
}

pub async fn handle_update_link(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(link_id): Path<String>,
    Json(body): Json<UpdateLinkRequest>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();
    let link_before = questions::get_link(&conn, &link_id).map_err(|e| match e {
        crate::db::DbError::NotFound(_) => not_found(e.to_string()),
        other => db_err(other),
    })?;
    questions::update_link_reason(&conn, &link_id, body.reason.as_deref(), sync_ctx.as_ref())
        .map_err(db_err)?;
    let _ = state.app_handle.emit(
        events::DATA_QUESTION_LINK_CHANGED,
        serde_json::json!({
            "action": "reason-updated",
            "question_id": link_before.question_id,
            "target_type": link_before.target_type,
            "target_id": link_before.target_id,
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn handle_delete_link(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(link_id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    let sync_ctx = state.sync_context();
    let link_before = questions::get_link(&conn, &link_id).map_err(|e| match e {
        crate::db::DbError::NotFound(_) => not_found(e.to_string()),
        other => db_err(other),
    })?;
    questions::unlink(&conn, &link_id, sync_ctx.as_ref()).map_err(db_err)?;
    let _ = state.app_handle.emit(
        events::DATA_QUESTION_LINK_CHANGED,
        serde_json::json!({
            "action": "unlinked",
            "question_id": link_before.question_id,
            "target_type": link_before.target_type,
            "target_id": link_before.target_id,
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn handle_questions_for_target(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ForTargetQuery>,
) -> Result<Json<Vec<questions::Question>>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;
    let conn = get_conn(&state)?;
    questions::list_questions_for_target(&conn, &q.target_type, &q.target_id)
        .map(Json)
        .map_err(|e| match e {
            crate::db::DbError::InvalidOperation(msg) => bad_request(msg),
            other => db_err(other),
        })
}
