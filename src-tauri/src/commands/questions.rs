//! Questions system Tauri commands.
//!
//! Each mutation emits `DATA_QUESTION_CHANGED` and/or
//! `DATA_QUESTION_LINK_CHANGED` so the frontend hooks can refresh without
//! manual callback wiring (see `crates/shibei-events`).

use std::sync::Arc;

use tauri::Emitter;

use crate::db::{comments, highlights, questions, search};
use crate::events;

use super::{AppState, CommandError};

// ─── lookup helpers used by the question detail view ────────────────────────
// QuestionLinkItem needs to resolve a highlight or comment by its id to show
// a snippet + jump-to-source. Existing commands only fetch by resource id, so
// we add the by-id variants here (the underlying shibei-db helpers already
// exist).

#[tauri::command]
pub async fn cmd_get_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<highlights::Highlight, CommandError> {
    let conn = state.conn()?;
    highlights::get_highlight_by_id(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_comment(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<comments::Comment, CommandError> {
    let conn = state.conn()?;
    comments::get_comment_by_id(&conn, &id).map_err(Into::into)
}

// ─── questions: CRUD ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cmd_list_questions(
    state: tauri::State<'_, Arc<AppState>>,
    status: Option<String>,
) -> Result<Vec<questions::Question>, CommandError> {
    let conn = state.conn()?;
    questions::list_questions(&conn, status.as_deref()).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_search_questions(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
) -> Result<Vec<questions::Question>, CommandError> {
    let conn = state.conn()?;
    search::search_questions(&conn, &query).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_get_question(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<questions::Question, CommandError> {
    let conn = state.conn()?;
    questions::get_question(&conn, &id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_question(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    title: String,
    description: Option<String>,
) -> Result<questions::Question, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let question = questions::create_question(
        &conn,
        &title,
        description.as_deref(),
        sync_ctx.as_ref(),
    )?;
    let _ = app.emit(
        events::DATA_QUESTION_CHANGED,
        serde_json::json!({ "action": "created", "question_id": question.id }),
    );
    Ok(question)
}

#[tauri::command]
pub async fn cmd_update_question(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    title: String,
    description: Option<String>,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    questions::update_question(&conn, &id, &title, description.as_deref(), sync_ctx.as_ref())?;
    let _ = app.emit(
        events::DATA_QUESTION_CHANGED,
        serde_json::json!({ "action": "updated", "question_id": id }),
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_archive_question(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    questions::archive_question(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(
        events::DATA_QUESTION_CHANGED,
        serde_json::json!({ "action": "archived", "question_id": id }),
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_unarchive_question(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    questions::unarchive_question(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(
        events::DATA_QUESTION_CHANGED,
        serde_json::json!({ "action": "unarchived", "question_id": id }),
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_question(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    questions::delete_question(&conn, &id, sync_ctx.as_ref())?;
    // The DB layer also cascade-soft-deletes any alive links. Emit a single
    // QUESTION_LINK_CHANGED to let subscribers refetch — per-link granularity
    // would be noisy and isn't needed by the planned UI.
    let _ = app.emit(
        events::DATA_QUESTION_CHANGED,
        serde_json::json!({ "action": "deleted", "question_id": id }),
    );
    let _ = app.emit(
        events::DATA_QUESTION_LINK_CHANGED,
        serde_json::json!({ "action": "unlinked", "question_id": id }),
    );
    Ok(())
}

// ─── question_notes: CRUD ────────────────────────────────────────────────────
// Research notes: multiple timestamped markdown notes per question where the
// user (or an MCP-delegated AI agent) deposits synthesized thinking / stage
// summaries. Independent of the question row, so edits never clobber title /
// status. Each mutation emits DATA_QUESTION_NOTE_CHANGED (scoped event so the
// sidebar question list does not refresh on note edits).

#[tauri::command]
pub async fn cmd_list_question_notes(
    state: tauri::State<'_, Arc<AppState>>,
    question_id: String,
) -> Result<Vec<questions::QuestionNote>, CommandError> {
    let conn = state.conn()?;
    questions::list_question_notes(&conn, &question_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_create_question_note(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    question_id: String,
    content: String,
) -> Result<questions::QuestionNote, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let note = questions::create_question_note(&conn, &question_id, &content, sync_ctx.as_ref())?;
    let _ = app.emit(
        events::DATA_QUESTION_NOTE_CHANGED,
        serde_json::json!({ "action": "created", "question_id": question_id, "note_id": note.id }),
    );
    Ok(note)
}

#[tauri::command]
pub async fn cmd_update_question_note(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    note_id: String,
    content: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    // Fetch first so the event payload carries the parent question_id.
    let note_before = questions::get_question_note(&conn, &note_id)?;
    questions::update_question_note(&conn, &note_id, &content, sync_ctx.as_ref())?;
    let _ = app.emit(
        events::DATA_QUESTION_NOTE_CHANGED,
        serde_json::json!({
            "action": "updated",
            "question_id": note_before.question_id,
            "note_id": note_id,
        }),
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_question_note(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    note_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let note_before = questions::get_question_note(&conn, &note_id)?;
    questions::delete_question_note(&conn, &note_id, sync_ctx.as_ref())?;
    let _ = app.emit(
        events::DATA_QUESTION_NOTE_CHANGED,
        serde_json::json!({
            "action": "deleted",
            "question_id": note_before.question_id,
            "note_id": note_id,
        }),
    );
    Ok(())
}

// ─── question_links: CRUD ────────────────────────────────────────────────────

#[tauri::command]
pub async fn cmd_list_question_links(
    state: tauri::State<'_, Arc<AppState>>,
    question_id: String,
) -> Result<Vec<questions::QuestionLink>, CommandError> {
    let conn = state.conn()?;
    questions::list_links_for_question(&conn, &question_id).map_err(Into::into)
}

/// Like `cmd_list_question_links`, but each link is resolved to its parent
/// resource (+ snippet / anchor for highlights and comments) so the detail view
/// renders in one round-trip instead of an N+1 fetch waterfall.
#[tauri::command]
pub async fn cmd_list_resolved_question_links(
    state: tauri::State<'_, Arc<AppState>>,
    question_id: String,
) -> Result<Vec<questions::ResolvedQuestionLink>, CommandError> {
    let conn = state.conn()?;
    questions::list_resolved_links_for_question(&conn, &question_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_list_questions_for_target(
    state: tauri::State<'_, Arc<AppState>>,
    target_type: String,
    target_id: String,
) -> Result<Vec<questions::Question>, CommandError> {
    let conn = state.conn()?;
    questions::list_questions_for_target(&conn, &target_type, &target_id).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_list_questions_for_resources(
    state: tauri::State<'_, Arc<AppState>>,
    resource_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, Vec<questions::Question>>, CommandError> {
    let conn = state.conn()?;
    questions::list_questions_for_resources(&conn, &resource_ids).map_err(Into::into)
}

#[tauri::command]
pub async fn cmd_link_to_question(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    question_id: String,
    target_type: String,
    target_id: String,
    reason: Option<String>,
) -> Result<questions::QuestionLink, CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    let link = questions::link(
        &conn,
        &question_id,
        &target_type,
        &target_id,
        reason.as_deref(),
        sync_ctx.as_ref(),
    )?;
    let _ = app.emit(
        events::DATA_QUESTION_LINK_CHANGED,
        serde_json::json!({
            "action": "linked",
            "question_id": question_id,
            "target_type": target_type,
            "target_id": target_id,
        }),
    );
    Ok(link)
}

#[tauri::command]
pub async fn cmd_update_link_reason(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    link_id: String,
    reason: Option<String>,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    // Fetch first so we can include question_id / target in the event payload.
    let link_before = questions::get_link(&conn, &link_id)?;
    questions::update_link_reason(&conn, &link_id, reason.as_deref(), sync_ctx.as_ref())?;
    let _ = app.emit(
        events::DATA_QUESTION_LINK_CHANGED,
        serde_json::json!({
            "action": "reason-updated",
            "question_id": link_before.question_id,
            "target_type": link_before.target_type,
            "target_id": link_before.target_id,
        }),
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_unlink(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    link_id: String,
) -> Result<(), CommandError> {
    let conn = state.conn()?;
    let sync_ctx = state.sync_context();
    // Capture the link's coordinates before soft-deleting so the event can
    // tell subscribers exactly which (question, target) pair lost a link.
    let link_before = questions::get_link(&conn, &link_id)?;
    questions::unlink(&conn, &link_id, sync_ctx.as_ref())?;
    let _ = app.emit(
        events::DATA_QUESTION_LINK_CHANGED,
        serde_json::json!({
            "action": "unlinked",
            "question_id": link_before.question_id,
            "target_type": link_before.target_type,
            "target_id": link_before.target_id,
        }),
    );
    Ok(())
}
