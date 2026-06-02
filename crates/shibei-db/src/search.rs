use rusqlite::{params, Connection};
use serde::Serialize;

use super::DbError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    #[serde(flatten)]
    pub resource: super::resources::Resource,
    pub matched_body: bool,
    pub match_fields: Vec<String>,
    pub snippet: Option<String>,
}

/// A question search hit with which field(s) matched and a context snippet, so
/// the UI can show *why* a question surfaced (esp. when the match is in its
/// description or research notes rather than the visible title). `match_fields`
/// ⊆ {"title","description","notes"}; `snippet` is context from the matched
/// notes (priority) or description, and `None` when only the title matched
/// (the title is already shown). JSON flattens the question fields, so older
/// consumers that expect a bare `Question` still parse it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionSearchResult {
    #[serde(flatten)]
    pub question: super::questions::Question,
    pub match_fields: Vec<String>,
    pub snippet: Option<String>,
}

/// Extract a text snippet around the first occurrence of `query` (case-insensitive).
/// Returns None if query is not found. `context_chars` = chars to include before/after.
fn extract_snippet(text: &str, query: &str, context_chars: usize) -> Option<String> {
    let text_lower = text.to_lowercase();
    let query_lower = query.to_lowercase();
    let byte_pos = text_lower.find(&query_lower)?;

    let char_pos = text[..byte_pos].chars().count();
    let query_char_len = query.chars().count();
    let total_chars = text.chars().count();

    let start = char_pos.saturating_sub(context_chars);
    let end = (char_pos + query_char_len + context_chars).min(total_chars);

    let snippet: String = text.chars().skip(start).take(end - start).collect();

    let prefix = if start > 0 { "..." } else { "" };
    let suffix = if end < total_chars { "..." } else { "" };

    Some(format!("{}{}{}", prefix, snippet, suffix))
}

/// Escape user input for FTS5 MATCH: wrap in double quotes, escape internal quotes.
fn escape_fts_query(input: &str) -> String {
    let escaped = input.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

/// Rebuild the FTS index for a single resource.
pub fn rebuild_search_index(conn: &Connection, resource_id: &str) -> Result<(), DbError> {
    // Read resource metadata
    let (title, url, description, plain_text): (String, String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT title, url, description, plain_text FROM resources WHERE id = ?1 AND deleted_at IS NULL",
            params![resource_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                DbError::NotFound(format!("resource {}", resource_id))
            }
            other => DbError::Sqlite(other),
        })?;

    // Collect all non-deleted highlight text_content
    let mut stmt = conn.prepare(
        "SELECT text_content FROM highlights WHERE resource_id = ?1 AND deleted_at IS NULL",
    )?;
    let highlights_text: Vec<String> = stmt
        .query_map(params![resource_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let highlights_joined = highlights_text.join("\n");

    // Collect all non-deleted comment content
    let mut stmt = conn.prepare(
        "SELECT content FROM comments WHERE resource_id = ?1 AND deleted_at IS NULL",
    )?;
    let comments_text: Vec<String> = stmt
        .query_map(params![resource_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let comments_joined = comments_text.join("\n");

    // DELETE existing entry then INSERT
    conn.execute(
        "DELETE FROM search_index WHERE resource_id = ?1",
        params![resource_id],
    )?;
    conn.execute(
        "INSERT INTO search_index (resource_id, title, url, description, highlights_text, comments_text, body_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            resource_id,
            title,
            url,
            description.unwrap_or_default(),
            highlights_joined,
            comments_joined,
            plain_text.unwrap_or_default(),
        ],
    )?;

    Ok(())
}

/// Delete the FTS index entry for a resource. Idempotent.
pub fn delete_search_index(conn: &Connection, resource_id: &str) -> Result<(), DbError> {
    conn.execute(
        "DELETE FROM search_index WHERE resource_id = ?1",
        params![resource_id],
    )?;
    Ok(())
}

/// Backfill plain_text for resources that don't have it yet.
/// Reads snapshot HTML from disk, extracts text via the injected extractor,
/// and stores in DB. Best-effort: skips resources whose snapshot files can't
/// be read.
///
/// `extract` is injected (not hard-coded to `scraper`) so shibei-db stays
/// free of HTML / PDF parsing dependencies. The desktop caller wires in
/// `plain_text::extract_plain_text`.
pub fn backfill_plain_text<F>(
    conn: &Connection,
    base_dir: &std::path::Path,
    extract: F,
) -> Result<u32, DbError>
where
    F: Fn(&str) -> String,
{
    let mut stmt = conn.prepare(
        "SELECT id FROM resources WHERE plain_text IS NULL AND deleted_at IS NULL",
    )?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut filled = 0u32;
    for id in &ids {
        let html_path = base_dir.join("storage").join(id).join("snapshot.html");
        match std::fs::read_to_string(&html_path) {
            Ok(html) => {
                let text = extract(&html);
                if !text.is_empty() {
                    let _ = super::resources::set_plain_text(conn, id, &text);
                    filled += 1;
                }
            }
            Err(e) => {
                eprintln!("[shibei] backfill: skip {}, read failed: {}", id, e);
            }
        }
    }

    Ok(filled)
}

/// Rebuild FTS index for all non-deleted resources.
/// Rebuild the FTS index for a single question. Idempotent.
pub fn rebuild_question_search_index(
    conn: &Connection,
    question_id: &str,
) -> Result<(), DbError> {
    let (title, description): (String, Option<String>) = conn
        .query_row(
            "SELECT title, description FROM questions WHERE id = ?1 AND deleted_at IS NULL",
            params![question_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                DbError::NotFound(format!("question {}", question_id))
            }
            other => DbError::Sqlite(other),
        })?;

    // Aggregate every alive note's content so a search can hit a question by
    // the thinking deposited in its research notes (order is irrelevant for
    // trigram matching).
    let notes_text: String = {
        let mut stmt = conn.prepare(
            "SELECT content FROM question_notes
             WHERE question_id = ?1 AND deleted_at IS NULL",
        )?;
        let parts = stmt
            .query_map(params![question_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        parts.join("\n")
    };

    conn.execute(
        "DELETE FROM question_index WHERE question_id = ?1",
        params![question_id],
    )?;
    conn.execute(
        "INSERT INTO question_index (question_id, title, description, notes_text)
         VALUES (?1, ?2, ?3, ?4)",
        params![question_id, title, description.unwrap_or_default(), notes_text],
    )?;

    Ok(())
}

/// Delete the FTS index entry for a question. Idempotent.
pub fn delete_question_search_index(
    conn: &Connection,
    question_id: &str,
) -> Result<(), DbError> {
    conn.execute(
        "DELETE FROM question_index WHERE question_id = ?1",
        params![question_id],
    )?;
    Ok(())
}

/// One-time backfill of question_index for all alive questions. Used on first
/// startup after migration 009 (gated by `config:question_fts_initialized`).
pub fn rebuild_all_question_search_index(conn: &Connection) -> Result<(), DbError> {
    conn.execute("DELETE FROM question_index", [])?;
    let mut stmt = conn.prepare("SELECT id FROM questions WHERE deleted_at IS NULL")?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in &ids {
        rebuild_question_search_index(conn, id)?;
    }
    Ok(())
}

pub fn is_question_fts_initialized(conn: &Connection) -> Result<bool, DbError> {
    let row: Option<String> = conn
        .query_row(
            "SELECT value FROM sync_state WHERE key = 'config:question_fts_initialized'",
            [],
            |row| row.get(0),
        )
        .ok();
    Ok(row.as_deref() == Some("1"))
}

pub fn mark_question_fts_initialized(conn: &Connection) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('config:question_fts_initialized', '1')",
        [],
    )?;
    Ok(())
}

/// Search questions via FTS5 MATCH (>= 3 chars) or LIKE fallback for shorter
/// queries (esp. 2-char CJK words). Returns ranked alive questions; archived
/// rows are included so users can find historical context.
pub fn search_questions(
    conn: &Connection,
    query: &str,
) -> Result<Vec<QuestionSearchResult>, DbError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }

    let use_fts = trimmed.chars().count() >= 3;

    // notes_text comes from the FTS row so we can flag a notes match + snippet
    // without a second per-question fetch.
    let sql = if use_fts {
        "SELECT q.id, q.title, q.description, q.status, q.archived_at,
                q.created_at, q.updated_at, qi.notes_text
         FROM questions q
         JOIN question_index qi ON q.id = qi.question_id
         WHERE q.deleted_at IS NULL AND question_index MATCH ?1
         ORDER BY q.status ASC, q.updated_at DESC"
    } else {
        "SELECT q.id, q.title, q.description, q.status, q.archived_at,
                q.created_at, q.updated_at, qi.notes_text
         FROM questions q
         JOIN question_index qi ON q.id = qi.question_id
         WHERE q.deleted_at IS NULL
           AND (qi.title LIKE ?1 OR qi.description LIKE ?1 OR qi.notes_text LIKE ?1)
         ORDER BY q.status ASC, q.updated_at DESC"
    };

    let mut stmt = conn.prepare(sql)?;
    let param = if use_fts {
        escape_fts_query(trimmed)
    } else {
        format!("%{}%", trimmed)
    };
    let query_lower = trimmed.to_lowercase();
    let rows = stmt
        .query_map(params![param], |row| {
            let question = super::questions::Question {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                archived_at: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            };
            let notes_text: String = row.get(7)?;

            let mut match_fields = Vec::new();
            if question.title.to_lowercase().contains(&query_lower) {
                match_fields.push("title".to_string());
            }
            let desc_match = question
                .description
                .as_deref()
                .map(|d| d.to_lowercase().contains(&query_lower))
                .unwrap_or(false);
            if desc_match {
                match_fields.push("description".to_string());
            }
            let notes_match = notes_text.to_lowercase().contains(&query_lower);
            if notes_match {
                match_fields.push("notes".to_string());
            }

            // Snippet only when the match is outside the (already-visible)
            // title — notes take priority over description.
            let snippet = if notes_match {
                extract_snippet(&notes_text, trimmed, 20)
            } else if desc_match {
                question
                    .description
                    .as_deref()
                    .and_then(|d| extract_snippet(d, trimmed, 20))
            } else {
                None
            };

            Ok(QuestionSearchResult {
                question,
                match_fields,
                snippet,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn rebuild_all_search_index(conn: &Connection) -> Result<(), DbError> {
    conn.execute("DELETE FROM search_index", [])?;

    let mut stmt =
        conn.prepare("SELECT id FROM resources WHERE deleted_at IS NULL")?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for id in &ids {
        rebuild_search_index(conn, id)?;
    }

    Ok(())
}

/// Search resources using FTS5 MATCH with optional folder and tag filtering.
pub fn search_resources(
    conn: &Connection,
    query: &str,
    folder_id: Option<&str>,
    tag_ids: &[String],
    filter_tag_ids: &[String],
    sort_by: &str,
    sort_order: &str,
) -> Result<Vec<SearchResult>, DbError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }

    let order_dir = match sort_order {
        "asc" | "ASC" => "ASC",
        _ => "DESC",
    };

    // Trigram tokenizer requires >= 3 chars for MATCH.
    // For shorter queries (e.g. 2-char Chinese words), fall back to LIKE on indexed columns.
    let use_fts = trimmed.chars().count() >= 3;

    let mut sql;
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_index;

    if use_fts {
        let fts_query = escape_fts_query(trimmed);
        sql = String::from(
            "SELECT r.id, r.title, r.url, r.domain, r.author, r.description, r.folder_id, \
             r.resource_type, r.file_path, r.created_at, r.captured_at, r.selection_meta, \
             si.highlights_text, si.comments_text, si.body_text, r.content_time \
             FROM resources r \
             JOIN search_index si ON r.id = si.resource_id \
             WHERE r.deleted_at IS NULL \
             AND search_index MATCH ?1",
        );
        param_values.push(Box::new(fts_query));
        param_index = 2;
    } else {
        let like_pattern = format!("%{}%", trimmed);
        sql = String::from(
            "SELECT r.id, r.title, r.url, r.domain, r.author, r.description, r.folder_id, \
             r.resource_type, r.file_path, r.created_at, r.captured_at, r.selection_meta, \
             si.highlights_text, si.comments_text, si.body_text, r.content_time \
             FROM resources r \
             JOIN search_index si ON r.id = si.resource_id \
             WHERE r.deleted_at IS NULL \
             AND (si.title LIKE ?1 OR si.url LIKE ?1 OR si.description LIKE ?1 \
                  OR si.highlights_text LIKE ?1 OR si.comments_text LIKE ?1 \
                  OR si.body_text LIKE ?1)",
        );
        param_values.push(Box::new(like_pattern));
        param_index = 2;
    }

    if let Some(fid) = folder_id {
        sql.push_str(&format!(" AND r.folder_id = ?{}", param_index));
        param_values.push(Box::new(fid.to_string()));
        param_index += 1;
    }

    if !tag_ids.is_empty() {
        let placeholders: Vec<String> = tag_ids
            .iter()
            .enumerate()
            .map(|_| {
                let ph = format!("?{}", param_index);
                param_index += 1;
                ph
            })
            .collect();
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM resource_tags rt WHERE rt.resource_id = r.id \
             AND rt.tag_id IN ({}) AND rt.deleted_at IS NULL)",
            placeholders.join(", ")
        ));
        for tag_id in tag_ids {
            param_values.push(Box::new(tag_id.clone()));
        }
    }

    // AND filter: resource must have ALL filter_tag_ids (INTERSECT)
    if !filter_tag_ids.is_empty() {
        let mut parts: Vec<String> = Vec::with_capacity(filter_tag_ids.len());
        for _ in filter_tag_ids.iter() {
            let ph = format!("?{}", param_index);
            param_index += 1;
            parts.push(format!(
                "SELECT resource_id FROM resource_tags WHERE tag_id = {} AND deleted_at IS NULL",
                ph
            ));
        }
        sql.push_str(&format!(
            " AND r.id IN ({})",
            parts.join(" INTERSECT ")
        ));
        for tag_id in filter_tag_ids {
            param_values.push(Box::new(tag_id.clone()));
        }
    }
    // suppress unused assignment warning
    let _ = param_index;

    // Sort order
    let order_clause = match sort_by {
        "annotated_at" => format!(
            " ORDER BY COALESCE(\
               (SELECT MAX(created_at) FROM (\
                 SELECT created_at FROM highlights WHERE resource_id = r.id AND deleted_at IS NULL \
                 UNION ALL \
                 SELECT created_at FROM comments WHERE resource_id = r.id AND deleted_at IS NULL\
               )), r.created_at) {}",
            order_dir
        ),
        "content_time" => format!(
            " ORDER BY COALESCE(r.content_time, r.created_at) {}",
            order_dir
        ),
        _ => format!(" ORDER BY r.created_at {}", order_dir),
    };
    sql.push_str(&order_clause);

    let params_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();

    let query_lower = trimmed.to_lowercase();

    let mut stmt = conn.prepare(&sql)?;
    let results = stmt
        .query_map(params_refs.as_slice(), |row| {
            let title: String = row.get(1)?;
            let url: String = row.get(2)?;
            let description: Option<String> = row.get(5)?;
            let highlights_text: String = row.get(12)?;
            let comments_text: String = row.get(13)?;

            let mut match_fields = Vec::new();

            if title.to_lowercase().contains(&query_lower) {
                match_fields.push("title".to_string());
            }
            if url.to_lowercase().contains(&query_lower) {
                match_fields.push("url".to_string());
            }
            if description
                .as_deref()
                .map(|d| d.to_lowercase().contains(&query_lower))
                .unwrap_or(false)
            {
                match_fields.push("description".to_string());
            }
            if highlights_text.to_lowercase().contains(&query_lower) {
                match_fields.push("highlights".to_string());
            }
            if comments_text.to_lowercase().contains(&query_lower) {
                match_fields.push("comments".to_string());
            }

            let body_text: String = row.get(14)?;
            let snippet = if body_text.to_lowercase().contains(&query_lower) {
                match_fields.push("body".to_string());
                extract_snippet(&body_text, trimmed, 20)
            } else {
                None
            };

            // matched_body = true when ONLY body matched (or nothing matched due to trigram/LIKE divergence)
            let matched_body = match_fields.is_empty()
                || (match_fields.len() == 1 && match_fields[0] == "body");

            Ok(SearchResult {
                resource: super::resources::Resource {
                    id: row.get(0)?,
                    title,
                    url,
                    domain: row.get(3)?,
                    author: row.get(4)?,
                    description,
                    folder_id: row.get(6)?,
                    resource_type: row.get(7)?,
                    file_path: row.get(8)?,
                    created_at: row.get(9)?,
                    captured_at: row.get(10)?,
                    selection_meta: row.get(11)?,
                    content_time: row.get(15)?,
                },
                matched_body,
                match_fields,
                snippet,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Check if FTS index has been initialized.
pub fn is_fts_initialized(conn: &Connection) -> Result<bool, DbError> {
    let result: Option<String> = conn
        .query_row(
            "SELECT value FROM sync_state WHERE key = 'config:fts_initialized'",
            [],
            |row| row.get(0),
        )
        .ok();
    Ok(result.is_some())
}

/// Get FTS index statistics: total resources, indexed (plain_text not null), and FTS initialized flag.
pub fn get_index_stats(conn: &Connection) -> Result<IndexStats, DbError> {
    let total: u32 = conn.query_row(
        "SELECT COUNT(*) FROM resources WHERE deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    let indexed: u32 = conn.query_row(
        "SELECT COUNT(*) FROM resources WHERE deleted_at IS NULL AND plain_text IS NOT NULL",
        [],
        |row| row.get(0),
    )?;
    let fts_initialized = is_fts_initialized(conn)?;
    Ok(IndexStats { total, indexed, pending: total - indexed, fts_initialized })
}

/// FTS index statistics.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub total: u32,
    pub indexed: u32,
    pub pending: u32,
    pub fts_initialized: bool,
}

/// Clear FTS initialized flag (used before restore to force full rebuild).
pub fn clear_fts_initialized(conn: &Connection) -> Result<(), DbError> {
    conn.execute(
        "DELETE FROM sync_state WHERE key = 'config:fts_initialized'",
        [],
    )?;
    Ok(())
}

/// Mark FTS index as initialized.
pub fn mark_fts_initialized(conn: &Connection) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('config:fts_initialized', 'true')",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{comments, folders, highlights, resources, tags, test_db};

    fn test_anchor() -> highlights::Anchor {
        serde_json::json!({
            "text_position": { "start": 0, "end": 10 },
            "text_quote": {
                "exact": "test",
                "prefix": "",
                "suffix": ""
            }
        })
    }

    fn setup_resource(
        conn: &Connection,
        folder_id: &str,
        title: &str,
        url: &str,
    ) -> resources::Resource {
        resources::create_resource(
            conn,
            resources::CreateResourceInput {
                id: None,
                title: title.to_string(),
                url: url.to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder_id.to_string(),
                resource_type: "webpage".to_string(),
                file_path: "x".to_string(),
                captured_at: "2026-01-01T00:00:00Z".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap()
    }

    #[test]
    fn test_rebuild_and_search_by_title() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r1 = setup_resource(&conn, &folder.id, "深度学习入门指南", "https://a.com");
        let _r2 = setup_resource(&conn, &folder.id, "Rust编程语言", "https://b.com");

        rebuild_search_index(&conn, &r1.id).unwrap();
        rebuild_search_index(&conn, &_r2.id).unwrap();

        let results =
            search_resources(&conn, "深度学习", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r1.id);
    }

    #[test]
    fn test_search_by_highlight_text() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Article", "https://a.com");

        highlights::create_highlight(
            &conn,
            &r.id,
            "这是一段重要的高亮文本",
            &test_anchor(),
            "#FFFF00",
            None,
        )
        .unwrap();

        rebuild_search_index(&conn, &r.id).unwrap();

        let results =
            search_resources(&conn, "高亮文本", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r.id);
    }

    #[test]
    fn test_search_by_comment_text() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Article", "https://a.com");

        comments::create_comment(&conn, &r.id, None, "这篇文章很有启发性", None).unwrap();

        rebuild_search_index(&conn, &r.id).unwrap();

        let results =
            search_resources(&conn, "启发性", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r.id);
    }

    #[test]
    fn test_search_with_folder_filter() {
        let conn = test_db();
        let f1 = folders::create_folder(&conn, "tech", "__root__", None).unwrap();
        let f2 = folders::create_folder(&conn, "life", "__root__", None).unwrap();
        let r1 = setup_resource(&conn, &f1.id, "Rust Programming", "https://a.com");
        let r2 = setup_resource(&conn, &f2.id, "Rust Cooking Pan", "https://b.com");

        rebuild_search_index(&conn, &r1.id).unwrap();
        rebuild_search_index(&conn, &r2.id).unwrap();

        // Without folder filter: both match
        let results =
            search_resources(&conn, "Rust", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 2);

        // With folder filter: only one matches
        let results = search_resources(
            &conn,
            "Rust",
            Some(&f1.id),
            &[], &[],
            "created_at",
            "desc",
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r1.id);
    }

    #[test]
    fn test_search_with_tag_filter() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r1 = setup_resource(&conn, &folder.id, "Tagged Article", "https://a.com");
        let _r2 = setup_resource(&conn, &folder.id, "Untagged Article", "https://b.com");

        let tag = tags::create_tag(&conn, "important", "#FF0000", None).unwrap();
        tags::add_tag_to_resource(&conn, &r1.id, &tag.id, None).unwrap();

        rebuild_search_index(&conn, &r1.id).unwrap();
        rebuild_search_index(&conn, &_r2.id).unwrap();

        // Without tag filter: both match
        let results =
            search_resources(&conn, "Article", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 2);

        // With tag filter: only tagged one matches
        let results = search_resources(
            &conn,
            "Article",
            None,
            &[tag.id.clone()],
            &[],
            "created_at",
            "desc",
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r1.id);
    }

    #[test]
    fn test_delete_search_index() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "To Be Deleted", "https://a.com");

        rebuild_search_index(&conn, &r.id).unwrap();

        let results =
            search_resources(&conn, "Deleted", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);

        delete_search_index(&conn, &r.id).unwrap();

        let results =
            search_resources(&conn, "Deleted", None, &[], &[], "created_at", "desc").unwrap();
        assert!(results.is_empty());

        // Idempotent: second delete should not error
        delete_search_index(&conn, &r.id).unwrap();
    }

    #[test]
    fn test_rebuild_all_search_index() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r1 = setup_resource(&conn, &folder.id, "First Article", "https://a.com");
        let r2 = setup_resource(&conn, &folder.id, "Second Article", "https://b.com");
        let r3 = setup_resource(&conn, &folder.id, "Third Article", "https://c.com");

        rebuild_all_search_index(&conn).unwrap();

        let results =
            search_resources(&conn, "Article", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 3);

        // Verify individual resources are searchable
        let results = search_resources(&conn, "First", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r1.id);

        let results =
            search_resources(&conn, "Second", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r2.id);

        let results = search_resources(&conn, "Third", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r3.id);
    }

    #[test]
    fn test_escape_fts_query_special_chars() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "C++ AND Rust OR Go", "https://a.com");

        rebuild_search_index(&conn, &r.id).unwrap();

        // FTS5 operators AND/OR should be escaped by quoting
        let results =
            search_resources(&conn, "AND Rust OR", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r.id);
    }

    #[test]
    fn test_short_query_like_fallback() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r1 = setup_resource(&conn, &folder.id, "算法导论", "https://a.com");
        let r2 = setup_resource(&conn, &folder.id, "数据结构", "https://b.com");

        rebuild_search_index(&conn, &r1.id).unwrap();
        rebuild_search_index(&conn, &r2.id).unwrap();

        // 2-char Chinese query should work via LIKE fallback
        let results = search_resources(&conn, "算法", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r1.id);

        // Single char should also work
        let results = search_resources(&conn, "算", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);

        // No match
        let results = search_resources(&conn, "AI", None, &[], &[], "created_at", "desc").unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_fts_initialized_flag() {
        let conn = test_db();

        assert!(!is_fts_initialized(&conn).unwrap());

        mark_fts_initialized(&conn).unwrap();

        assert!(is_fts_initialized(&conn).unwrap());

        // Idempotent
        mark_fts_initialized(&conn).unwrap();
        assert!(is_fts_initialized(&conn).unwrap());
    }

    #[test]
    fn test_search_by_body_text() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Generic Title", "https://a.com");
        resources::set_plain_text(&conn, &r.id, "这篇文章详细介绍了量子计算的基本原理").unwrap();
        rebuild_search_index(&conn, &r.id).unwrap();
        let results =
            search_resources(&conn, "量子计算", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r.id);
    }

    #[test]
    fn test_search_body_text_null_plain_text() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Article Without Body", "https://a.com");
        rebuild_search_index(&conn, &r.id).unwrap();
        let results =
            search_resources(&conn, "Without Body", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].resource.id, r.id);
    }

    #[test]
    fn test_matched_body_flag_body_only() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Generic Title", "https://a.com");
        resources::set_plain_text(&conn, &r.id, "深度学习神经网络反向传播算法").unwrap();
        rebuild_search_index(&conn, &r.id).unwrap();
        let results =
            search_resources(&conn, "反向传播", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].matched_body);
    }

    #[test]
    fn test_matched_body_flag_title_also_matches() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "量子计算入门", "https://a.com");
        resources::set_plain_text(&conn, &r.id, "本文介绍量子计算的基础知识").unwrap();
        rebuild_search_index(&conn, &r.id).unwrap();
        let results =
            search_resources(&conn, "量子计算", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].matched_body);
    }

    #[test]
    fn test_extract_snippet() {
        let text = "这是一段很长的文本内容，包含了我们要搜索的关键词，关键词出现在文本的中间位置，后面还有一些额外的文字用于测试。";
        let snippet = extract_snippet(text, "关键词", 20);
        assert!(snippet.is_some());
        let s = snippet.unwrap();
        assert!(s.contains("关键词"));
    }

    #[test]
    fn test_extract_snippet_at_start() {
        let text = "关键词在开头的文本内容还有更多";
        let snippet = extract_snippet(text, "关键词", 20);
        assert!(snippet.is_some());
        let s = snippet.unwrap();
        assert!(s.starts_with("关键词"));
    }

    #[test]
    fn test_extract_snippet_no_match() {
        let text = "这段文本不包含搜索词";
        let snippet = extract_snippet(text, "不存在的词", 20);
        assert!(snippet.is_none());
    }

    #[test]
    fn test_extract_snippet_case_insensitive() {
        let text = "This text contains a Keyword in the middle of a sentence with more words";
        let snippet = extract_snippet(text, "keyword", 15);
        assert!(snippet.is_some());
        assert!(snippet.unwrap().contains("Keyword"));
    }

    #[test]
    fn test_search_returns_match_fields_and_snippet() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "学习笔记", "https://example.com");
        resources::set_plain_text(
            &conn,
            &r.id,
            "这是一篇关于Rust编程语言的详细教程，包含了很多示例代码和最佳实践",
        )
        .unwrap();
        rebuild_search_index(&conn, &r.id).unwrap();

        let results =
            search_resources(&conn, "Rust编程", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].match_fields.contains(&"body".to_string()));
        assert!(results[0].snippet.is_some());
        assert!(results[0].snippet.as_ref().unwrap().contains("Rust编程"));
    }

    #[test]
    fn test_search_match_fields_title() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Rust入门指南", "https://example.com");
        rebuild_search_index(&conn, &r.id).unwrap();

        let results =
            search_resources(&conn, "Rust入门", None, &[], &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].match_fields.contains(&"title".to_string()));
        assert!(!results[0].matched_body);
        assert!(results[0].snippet.is_none());
    }

    // ─── question FTS ───────────────────────────────────────────────

    #[test]
    fn test_search_questions_by_title_fts() {
        let conn = test_db();
        crate::questions::create_question(&conn, "可观测性体系", Some("微服务"), None).unwrap();
        crate::questions::create_question(&conn, "估值方法", None, None).unwrap();

        let results = search_questions(&conn, "可观测").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].question.title, "可观测性体系");
        assert!(results[0].match_fields.contains(&"title".to_string()));
    }

    #[test]
    fn test_search_questions_by_description() {
        let conn = test_db();
        crate::questions::create_question(
            &conn,
            "Topic A",
            Some("we want to study distributed tracing strategies"),
            None,
        )
        .unwrap();
        let results = search_questions(&conn, "distributed tracing").unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_search_questions_includes_archived() {
        let conn = test_db();
        let q = crate::questions::create_question(&conn, "可观测性", None, None).unwrap();
        crate::questions::archive_question(&conn, &q.id, None).unwrap();
        let results = search_questions(&conn, "可观测").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].question.status, "archived");
    }

    #[test]
    fn test_search_questions_excludes_deleted() {
        let conn = test_db();
        let q = crate::questions::create_question(&conn, "可观测性", None, None).unwrap();
        crate::questions::delete_question(&conn, &q.id, None).unwrap();
        let results = search_questions(&conn, "可观测").unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_questions_updates_on_edit() {
        let conn = test_db();
        let q = crate::questions::create_question(&conn, "旧标题", None, None).unwrap();
        assert_eq!(search_questions(&conn, "旧标题").unwrap().len(), 1);
        assert!(search_questions(&conn, "新标题").unwrap().is_empty());

        crate::questions::update_question(&conn, &q.id, "新标题啊", None, None).unwrap();
        assert!(search_questions(&conn, "旧标题").unwrap().is_empty());
        assert_eq!(search_questions(&conn, "新标题").unwrap().len(), 1);
    }

    #[test]
    fn test_search_questions_short_query_like_fallback() {
        let conn = test_db();
        crate::questions::create_question(&conn, "AI研究计划", None, None).unwrap();
        // 2-char CJK is below the trigram MATCH threshold; expect LIKE fallback.
        let results = search_questions(&conn, "AI").unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_search_questions_empty_query_returns_empty() {
        let conn = test_db();
        crate::questions::create_question(&conn, "Q", None, None).unwrap();
        assert!(search_questions(&conn, "").unwrap().is_empty());
        assert!(search_questions(&conn, "   ").unwrap().is_empty());
    }

    #[test]
    fn test_search_questions_by_note_content() {
        let conn = test_db();
        // A keyword that appears ONLY in a research note, not in title/desc.
        let q = crate::questions::create_question(&conn, "投资方向", None, None).unwrap();
        crate::questions::create_question_note(&conn, &q.id, "阶段结论：新质生产力是核心抓手", None)
            .unwrap();
        let results = search_questions(&conn, "新质生产力").unwrap();
        assert_eq!(results.len(), 1, "should find a question by its note content");
        assert_eq!(results[0].question.id, q.id);
        assert!(results[0].match_fields.contains(&"notes".to_string()));
        // A note match must carry a snippet so the UI can show why it matched.
        assert!(
            results[0].snippet.as_deref().map(|s| s.contains("新质生产力")).unwrap_or(false),
            "note match should yield a snippet containing the query",
        );
    }

    #[test]
    fn test_search_questions_note_delete_updates_index() {
        let conn = test_db();
        let q = crate::questions::create_question(&conn, "题目", None, None).unwrap();
        let n = crate::questions::create_question_note(&conn, &q.id, "关键词阿尔法测试内容", None)
            .unwrap();
        assert_eq!(search_questions(&conn, "阿尔法测试").unwrap().len(), 1);
        // Deleting the note must drop its text from the question's FTS row.
        crate::questions::delete_question_note(&conn, &n.id, None).unwrap();
        assert!(search_questions(&conn, "阿尔法测试").unwrap().is_empty());
    }

    #[test]
    fn test_rebuild_all_question_search_index() {
        let conn = test_db();
        crate::questions::create_question(&conn, "first", None, None).unwrap();
        crate::questions::create_question(&conn, "second", None, None).unwrap();

        // Wipe and rebuild — should still find both.
        conn.execute("DELETE FROM question_index", []).unwrap();
        assert!(search_questions(&conn, "first").unwrap().is_empty());

        rebuild_all_question_search_index(&conn).unwrap();
        assert_eq!(search_questions(&conn, "first").unwrap().len(), 1);
        assert_eq!(search_questions(&conn, "second").unwrap().len(), 1);
    }
}
