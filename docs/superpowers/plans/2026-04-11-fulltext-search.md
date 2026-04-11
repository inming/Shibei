# Full-Text Snapshot Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index the full body text of saved web snapshots in the existing FTS5 search index, so users can search page content — not just titles, URLs, and annotations.

**Architecture:** Add a `body_text` column to the FTS5 `search_index` virtual table. Since FTS5 doesn't support `ALTER TABLE ADD COLUMN`, the migration drops and recreates the table. On startup, backfill any resources missing `plain_text`, then rebuild the full index. `search_resources` returns a new `SearchResult` type with a `matched_body` flag so the frontend can show a "body match" label.

**Tech Stack:** Rust (rusqlite FTS5, scraper), React + TypeScript, i18next

**Spec:** `docs/superpowers/specs/2026-04-11-v2.0-fulltext-search-design.md`

---

### Task 1: Migration — Recreate FTS5 table with `body_text` column

**Files:**
- Create: `src-tauri/migrations/007_search_index_body.sql`
- Modify: `src-tauri/src/db/migration.rs:17-42`

- [ ] **Step 1: Create the migration SQL file**

Create `src-tauri/migrations/007_search_index_body.sql`:

```sql
DROP TABLE IF EXISTS search_index;

CREATE VIRTUAL TABLE search_index USING fts5(
    resource_id UNINDEXED,
    title,
    url,
    description,
    highlights_text,
    comments_text,
    body_text,
    tokenize='trigram'
);

-- Reset FTS initialization flag to trigger full rebuild on next startup
DELETE FROM sync_state WHERE key = 'config:fts_initialized';
```

- [ ] **Step 2: Register migration 007 in migration.rs**

In `src-tauri/src/db/migration.rs`, add to the `MIGRATIONS` array (after version 6):

```rust
    Migration {
        version: 7,
        sql: include_str!("../../migrations/007_search_index_body.sql"),
    },
```

- [ ] **Step 3: Update migration test version assertions**

In `src-tauri/src/db/migration.rs`, update `test_migration_is_idempotent` (line 101): change `assert_eq!(version, 6)` to `assert_eq!(version, 7)`.

- [ ] **Step 4: Run migration tests**

Run: `cd src-tauri && cargo test db::migration -- --nocapture`

Expected: All migration tests pass, version is 7.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/migrations/007_search_index_body.sql src-tauri/src/db/migration.rs
git commit -m "feat(search): add migration 007 to recreate FTS5 table with body_text column"
```

---

### Task 2: Update `rebuild_search_index` to include `body_text`

**Files:**
- Modify: `src-tauri/src/db/search.rs:12-63`

- [ ] **Step 1: Write the failing test — search by body text**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/db/search.rs`:

```rust
    #[test]
    fn test_search_by_body_text() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Generic Title", "https://a.com");

        // Set plain_text (simulating what server/sync does after saving HTML)
        resources::set_plain_text(&conn, &r.id, "这篇文章详细介绍了量子计算的基本原理").unwrap();

        rebuild_search_index(&conn, &r.id).unwrap();

        // Should find by body text content
        let results =
            search_resources(&conn, "量子计算", None, &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, r.id);
    }
```

Note: `search_resources` currently returns `Vec<Resource>` — this test will initially work with the old return type. We'll change the return type in Task 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test db::search::tests::test_search_by_body_text -- --nocapture`

Expected: FAIL — body text not indexed, "量子计算" only exists in `plain_text` column which is not in `search_index`.

- [ ] **Step 3: Update `rebuild_search_index` to read and index `plain_text`**

In `src-tauri/src/db/search.rs`, modify `rebuild_search_index` (lines 12-63):

Change the resource metadata query to also read `plain_text`:

```rust
pub fn rebuild_search_index(conn: &Connection, resource_id: &str) -> Result<(), DbError> {
    // Read resource metadata + plain_text
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test db::search::tests::test_search_by_body_text -- --nocapture`

Expected: PASS

- [ ] **Step 5: Write test — body text search with NULL plain_text**

Add to `src-tauri/src/db/search.rs` tests:

```rust
    #[test]
    fn test_search_body_text_null_plain_text() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Article Without Body", "https://a.com");
        // Don't set plain_text — it stays NULL

        rebuild_search_index(&conn, &r.id).unwrap();

        // Title search should still work
        let results =
            search_resources(&conn, "Without Body", None, &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, r.id);
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src-tauri && cargo test db::search::tests::test_search_body_text_null_plain_text -- --nocapture`

Expected: PASS — `plain_text.unwrap_or_default()` writes empty string for `body_text`.

- [ ] **Step 7: Run all search tests**

Run: `cd src-tauri && cargo test db::search -- --nocapture`

Expected: All existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/search.rs
git commit -m "feat(search): index body_text (plain_text) in rebuild_search_index"
```

---

### Task 3: Add `SearchResult` type and `matched_body` detection

**Files:**
- Modify: `src-tauri/src/db/search.rs:92-213`

- [ ] **Step 1: Write the failing test — matched_body flag for body-only match**

Add to `src-tauri/src/db/search.rs` tests:

```rust
    #[test]
    fn test_matched_body_flag_body_only() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "Generic Title", "https://a.com");

        resources::set_plain_text(&conn, &r.id, "深度学习神经网络反向传播算法").unwrap();

        rebuild_search_index(&conn, &r.id).unwrap();

        // "反向传播" only appears in body_text, not in title/url/description/highlights/comments
        let results =
            search_resources(&conn, "反向传播", None, &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].matched_body);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test db::search::tests::test_matched_body_flag_body_only -- --nocapture`

Expected: FAIL — `search_resources` returns `Vec<Resource>`, no `matched_body` field.

- [ ] **Step 3: Add `SearchResult` struct and update `search_resources` return type**

In `src-tauri/src/db/search.rs`, add the struct before `search_resources` function, and add a `use serde::Serialize;` import:

```rust
use serde::Serialize;
```

After the `escape_fts_query` function (before `rebuild_search_index`), add:

```rust
/// A search result with metadata about which field matched.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    #[serde(flatten)]
    pub resource: super::resources::Resource,
    pub matched_body: bool,
}
```

- [ ] **Step 4: Update `search_resources` to return `Vec<SearchResult>` with `matched_body` detection**

Modify the `search_resources` function signature and body. The key changes:

1. Return type: `Vec<SearchResult>` instead of `Vec<Resource>`
2. In the FTS path: JOIN `search_index` to also SELECT `si.title, si.url, si.description, si.highlights_text, si.comments_text` (the metadata stored in FTS)
3. After collecting resources, compute `matched_body` for each

Replace the full `search_resources` function:

```rust
/// Search resources using FTS5 MATCH with optional folder and tag filtering.
pub fn search_resources(
    conn: &Connection,
    query: &str,
    folder_id: Option<&str>,
    tag_ids: &[String],
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

    let use_fts = trimmed.chars().count() >= 3;

    let mut sql;
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_index;

    if use_fts {
        let fts_query = escape_fts_query(trimmed);
        sql = String::from(
            "SELECT r.id, r.title, r.url, r.domain, r.author, r.description, r.folder_id, \
             r.resource_type, r.file_path, r.created_at, r.captured_at, r.selection_meta, \
             si.highlights_text, si.comments_text \
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
             si.highlights_text, si.comments_text \
             FROM resources r \
             JOIN search_index si ON r.id = si.resource_id \
             WHERE r.deleted_at IS NULL \
             AND (si.title LIKE ?1 OR si.url LIKE ?1 OR si.description LIKE ?1 \
                  OR si.highlights_text LIKE ?1 OR si.comments_text LIKE ?1)",
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
    let _ = param_index;

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
        _ => format!(" ORDER BY r.created_at {}", order_dir),
    };
    sql.push_str(&order_clause);

    let params_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();

    let query_lower = trimmed.to_lowercase();

    let mut stmt = conn.prepare(&sql)?;
    let results = stmt
        .query_map(params_refs.as_slice(), |row| {
            let resource = super::resources::Resource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                author: row.get(4)?,
                description: row.get(5)?,
                folder_id: row.get(6)?,
                resource_type: row.get(7)?,
                file_path: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                selection_meta: row.get(11)?,
            };
            let highlights_text: String = row.get(12)?;
            let comments_text: String = row.get(13)?;

            // Determine if match came from metadata or body
            let meta_match = resource.title.to_lowercase().contains(&query_lower)
                || resource.url.to_lowercase().contains(&query_lower)
                || resource.description.as_deref().unwrap_or("").to_lowercase().contains(&query_lower)
                || highlights_text.to_lowercase().contains(&query_lower)
                || comments_text.to_lowercase().contains(&query_lower);

            Ok(SearchResult {
                resource,
                matched_body: !meta_match,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}
```

Key changes vs. the old function:
- SELECT adds `si.highlights_text, si.comments_text` (columns 12, 13)
- LIKE fallback does NOT include `si.body_text` (performance decision from spec)
- `matched_body` computed inline: if no metadata field contains the query, it must be a body match

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src-tauri && cargo test db::search::tests::test_matched_body_flag_body_only -- --nocapture`

Expected: PASS

- [ ] **Step 6: Write test — matched_body is false when title also matches**

```rust
    #[test]
    fn test_matched_body_flag_title_also_matches() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let r = setup_resource(&conn, &folder.id, "量子计算入门", "https://a.com");

        resources::set_plain_text(&conn, &r.id, "本文介绍量子计算的基础知识").unwrap();

        rebuild_search_index(&conn, &r.id).unwrap();

        // "量子计算" matches both title and body — matched_body should be false
        let results =
            search_resources(&conn, "量子计算", None, &[], "created_at", "desc").unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].matched_body);
    }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd src-tauri && cargo test db::search::tests::test_matched_body_flag_title_also_matches -- --nocapture`

Expected: PASS

- [ ] **Step 8: Fix all existing tests to use `SearchResult` field access**

All existing tests that call `search_resources` and access `.id`, `.title` etc. need to go through `.resource`. Update every test that accesses result fields.

For example, change `results[0].id` to `results[0].resource.id` in all these tests:
- `test_rebuild_and_search_by_title`
- `test_search_by_highlight_text`
- `test_search_by_comment_text`
- `test_search_with_folder_filter`
- `test_search_with_tag_filter`
- `test_delete_search_index`
- `test_escape_fts_query_special_chars`
- `test_short_query_like_fallback`
- `test_search_by_body_text` (from Task 2)
- `test_search_body_text_null_plain_text` (from Task 2)

Pattern: replace `results[0].id` with `results[0].resource.id`, `results[0].title` with `results[0].resource.title`, etc.

- [ ] **Step 9: Run all search tests**

Run: `cd src-tauri && cargo test db::search -- --nocapture`

Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/db/search.rs
git commit -m "feat(search): add SearchResult type with matched_body flag"
```

---

### Task 4: Update command and HTTP handler for `SearchResult`

**Files:**
- Modify: `src-tauri/src/commands/mod.rs:344-370`
- Modify: `src-tauri/src/server/mod.rs:740-793`

- [ ] **Step 1: Update `cmd_search_resources` return type**

In `src-tauri/src/commands/mod.rs`, change the return type at line 344:

```rust
#[tauri::command]
pub async fn cmd_search_resources(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    folder_id: Option<String>,
    tag_ids: Vec<String>,
    sort_by: Option<resources::SortBy>,
    sort_order: Option<resources::SortOrder>,
) -> Result<Vec<db::search::SearchResult>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
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
```

The only change is the return type: `Vec<resources::Resource>` → `Vec<db::search::SearchResult>`.

- [ ] **Step 2: Update HTTP search handler return type**

In `src-tauri/src/server/mod.rs`, the function `handle_list_resources` (line 740) returns `Json<Vec<resources::Resource>>`. The search branch (line 772) calls `search::search_resources` which now returns `Vec<SearchResult>`.

The simplest approach: change the handler's return type to `Json<serde_json::Value>` and serialize both paths. Alternatively, keep the non-search path returning `Vec<Resource>` and the search path returning `Vec<SearchResult>` by wrapping each Resource in a SearchResult with `matched_body: false` for the non-search path.

Use the wrapper approach — it keeps a single return type:

```rust
async fn handle_list_resources(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<ResourcesQuery>,
) -> Result<Json<Vec<search::SearchResult>>, (StatusCode, Json<ErrorResponse>)> {
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

    let resources = if let Some(ref folder_id) = q.folder_id {
        resources::list_resources_by_folder(&conn, folder_id, sort_by, sort_order, &tag_ids)
            .map_err(map_db_error)?
    } else {
        resources::list_all_resources(&conn, sort_by, sort_order, &tag_ids)
            .map_err(map_db_error)?
    };

    // Wrap non-search results as SearchResult with matched_body: false
    let results = resources
        .into_iter()
        .map(|r| search::SearchResult { resource: r, matched_body: false })
        .collect();

    Ok(Json(results))
}
```

- [ ] **Step 3: Run cargo check**

Run: `cd src-tauri && cargo check`

Expected: No compilation errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/server/mod.rs
git commit -m "feat(search): update command and HTTP handler for SearchResult type"
```

---

### Task 5: Startup plain_text backfill

**Files:**
- Modify: `src-tauri/src/lib.rs:183-226`
- Modify: `src-tauri/src/db/search.rs` (new function)

- [ ] **Step 1: Add `backfill_plain_text` function to search module**

Add to `src-tauri/src/db/search.rs` (before `rebuild_all_search_index`):

```rust
/// Backfill plain_text for resources that don't have it yet.
/// Reads snapshot HTML from disk, extracts text, and stores in DB.
/// Best-effort: skips resources whose snapshot files can't be read.
pub fn backfill_plain_text(conn: &Connection, base_dir: &std::path::Path) -> Result<u32, DbError> {
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
                let text = crate::plain_text::extract_plain_text(&html);
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
```

- [ ] **Step 2: Update startup thread in lib.rs to backfill before FTS rebuild**

In `src-tauri/src/lib.rs`, the startup FTS block is at lines 209-226. Modify it to also capture `base_dir` and call `backfill_plain_text`:

Before the `fts_pool` line (line 183), add:

```rust
let fts_base_dir = base_dir.clone();
```

Then replace the FTS initialization block (lines 209-226):

```rust
            // Initialize FTS search index if not yet done
            {
                std::thread::spawn(move || {
                    if let Ok(conn) = fts_pool.get() {
                        match db::search::is_fts_initialized(&conn) {
                            Ok(false) => {
                                // Backfill plain_text for resources missing it
                                match db::search::backfill_plain_text(&conn, &fts_base_dir) {
                                    Ok(n) if n > 0 => {
                                        eprintln!("[shibei] Backfilled plain_text for {} resources", n);
                                    }
                                    Err(e) => {
                                        eprintln!("[shibei] plain_text backfill failed: {}", e);
                                    }
                                    _ => {}
                                }
                                // Rebuild FTS index (now includes body_text)
                                if let Err(e) = db::search::rebuild_all_search_index(&conn) {
                                    eprintln!("[shibei] FTS index rebuild failed: {}", e);
                                } else if let Err(e) = db::search::mark_fts_initialized(&conn) {
                                    eprintln!("[shibei] FTS flag write failed: {}", e);
                                }
                            }
                            Err(e) => eprintln!("[shibei] FTS init check failed: {}", e),
                            _ => {}
                        }
                    }
                });
            }
```

Note: `fts_base_dir` needs to be declared before `base_dir` is moved into other closures. Check that `base_dir.clone()` happens at the right point (near line 183 where `fts_pool` is declared, before `server_base_dir` consumes a clone).

- [ ] **Step 3: Run cargo check**

Run: `cd src-tauri && cargo check`

Expected: No compilation errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/search.rs src-tauri/src/lib.rs
git commit -m "feat(search): backfill plain_text on startup before FTS rebuild"
```

---

### Task 6: Frontend — Update types and commands

**Files:**
- Modify: `src/types/index.ts:13-26`
- Modify: `src/lib/commands.ts:74-88`

- [ ] **Step 1: Add `SearchResult` type**

In `src/types/index.ts`, after the `Resource` interface (after line 26), add:

```typescript
export interface SearchResult extends Resource {
  matchedBody: boolean;
}
```

Also update the import in `src/lib/commands.ts` (line 2) to include `SearchResult`:

```typescript
import type { Folder, Resource, Tag, Highlight, Comment, Anchor, SyncConfig, EncryptionStatus, AutoUnlockResult, DeletedResource, DeletedFolder, SearchResult } from "@/types";
```

- [ ] **Step 2: Update `searchResources` return type**

In `src/lib/commands.ts`, change line 80:

```typescript
export function searchResources(
  query: string,
  folderId: string | null,
  tagIds: string[],
  sortBy?: "created_at" | "annotated_at",
  sortOrder?: "asc" | "desc",
): Promise<SearchResult[]> {
  return invoke("cmd_search_resources", {
    query,
    folderId,
    tagIds,
    sortBy: sortBy ?? "created_at",
    sortOrder: sortOrder ?? "desc",
  });
}
```

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`

Expected: Type errors in `useResources.ts` (expects `Resource[]` from `searchResources`, now gets `SearchResult[]`). This is expected — we fix it in the next task.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/lib/commands.ts
git commit -m "feat(search): add SearchResult type with matchedBody field"
```

---

### Task 7: Frontend — Update `useResources` hook

**Files:**
- Modify: `src/hooks/useResources.ts`

- [ ] **Step 1: Update `useResources` to parse `SearchResult` and expose `matchedBodyMap`**

Replace the full `src/hooks/useResources.ts`:

```typescript
import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ALL_RESOURCES_ID, type Resource } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";

export function useResources(
  folderId: string | null,
  sortBy: "created_at" | "annotated_at" = "created_at",
  sortOrder: "asc" | "desc" = "desc",
  searchQuery: string = "",
  selectedTagIds: string[] = [],
) {
  const { t } = useTranslation('lock');
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceTags, setResourceTags] = useState<Record<string, Tag[]>>({});
  const [matchedBodyMap, setMatchedBodyMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!folderId) {
      setResources([]);
      setResourceTags({});
      setMatchedBodyMap({});
      return;
    }
    setLoading(true);
    try {
      let list: Resource[];
      let bodyMap: Record<string, boolean> = {};
      if (searchQuery.length >= 2) {
        const searchResults = await cmd.searchResources(
          searchQuery,
          folderId === ALL_RESOURCES_ID ? null : folderId,
          selectedTagIds,
          sortBy,
          sortOrder,
        );
        list = searchResults;
        for (const sr of searchResults) {
          bodyMap[sr.id] = sr.matchedBody;
        }
      } else if (folderId === ALL_RESOURCES_ID) {
        list = await cmd.listAllResources(sortBy, sortOrder, selectedTagIds);
      } else {
        list = await cmd.listResources(folderId, sortBy, sortOrder, selectedTagIds);
      }
      setResources(list);
      setMatchedBodyMap(bodyMap);
      // Fetch tags for all resources in parallel
      const tagEntries = await Promise.all(
        list.map(async (r) => {
          const tags = await cmd.getTagsForResource(r.id);
          return [r.id, tags] as const;
        }),
      );
      setResourceTags(Object.fromEntries(tagEntries));
    } catch (err) {
      console.error("Failed to load resources:", err);
      toast.error(t('loadResourcesFailed'));
    } finally {
      setLoading(false);
    }
  }, [folderId, sortBy, sortOrder, searchQuery, selectedTagIds]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on domain events
  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.TAG_CHANGED, () => { refresh(); });
    const u3 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    const u4 = listen(DataEvents.ANNOTATION_CHANGED, () => {
      if (searchQuery.length >= 2) refresh();
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
      u4.then((f) => f());
    };
  }, [refresh, searchQuery]);

  return { resources, resourceTags, matchedBodyMap, loading, refresh };
}
```

Key changes:
- New state: `matchedBodyMap: Record<string, boolean>`
- In search path: `searchResources` returns `SearchResult[]` (which extends `Resource`, so `list = searchResults` works)
- Build `bodyMap` from search results
- Clear `bodyMap` in non-search paths
- Return `matchedBodyMap` from the hook

Note: The `Tag` import is missing — add it to the import line:

```typescript
import { ALL_RESOURCES_ID, type Resource, type Tag } from "@/types";
```

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`

Expected: May have errors in `ResourceList.tsx` since it doesn't destructure `matchedBodyMap` yet. This is fine — we fix it next.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useResources.ts
git commit -m "feat(search): expose matchedBodyMap from useResources hook"
```

---

### Task 8: Frontend — "Body match" label in ResourceList

**Files:**
- Modify: `src/components/Sidebar/ResourceList.tsx:43-79, 81-99`
- Modify: `src/components/Sidebar/ResourceList.module.css`
- Modify: `src/locales/zh/search.json`
- Modify: `src/locales/en/search.json`

- [ ] **Step 1: Add i18n keys**

In `src/locales/zh/search.json`:

```json
{
  "placeholder": "搜索...",
  "clearSearch": "清除搜索",
  "bodyMatch": "正文匹配"
}
```

In `src/locales/en/search.json`:

```json
{
  "placeholder": "Search...",
  "clearSearch": "Clear search",
  "bodyMatch": "Body match"
}
```

- [ ] **Step 2: Add `.bodyMatchTag` CSS**

In `src/components/Sidebar/ResourceList.module.css`, add at the end:

```css
.bodyMatchTag {
  display: inline-block;
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 3px;
  background: var(--color-accent-light, #e8f0fe);
  color: var(--color-accent, #1a73e8);
  margin-left: 6px;
  vertical-align: middle;
  flex-shrink: 0;
}
```

- [ ] **Step 3: Update `DraggableResourceItem` to accept and render `matchedBody`**

In `src/components/Sidebar/ResourceList.tsx`, update the `DraggableResourceItem` component:

Change the props type (line 43) to add `matchedBody`:

```typescript
function DraggableResourceItem({ resource, isSelected, searchQuery, matchedBody, onClick, onDoubleClick, onContextMenu }: {
  resource: Resource;
  isSelected: boolean;
  searchQuery: string;
  matchedBody: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
```

In the component's JSX, add the label after the title text inside `.itemTitle` (line 70-73):

```tsx
      <div className={styles.itemTitle}>
        {resource.selection_meta && <span className={styles.clipBadge} title={t('clipBadgeTitle')}>&#9986;</span>}
        {searchQuery.length >= 2 ? highlightMatch(resource.title, searchQuery) : resource.title}
        {matchedBody && <span className={styles.bodyMatchTag}>{tSearch('bodyMatch')}</span>}
      </div>
```

Add the `tSearch` hook: inside `DraggableResourceItem`, add:

```typescript
  const { t: tSearch } = useTranslation('search');
```

(Right after the existing `const { t } = useTranslation('sidebar');` line.)

- [ ] **Step 4: Update `ResourceList` to destructure `matchedBodyMap` and pass it down**

In the `ResourceList` component (line 81), update the `useResources` destructuring:

```typescript
  const { resources, matchedBodyMap, loading } = useResources(
```

Then in the render loop where `DraggableResourceItem` is rendered (around line 300), add the `matchedBody` prop:

```tsx
          <DraggableResourceItem
            key={resource.id}
            resource={resource}
            isSelected={selectedResourceIds.has(resource.id)}
            searchQuery={searchQuery}
            matchedBody={!!matchedBodyMap[resource.id]}
            onClick={(e) => onSelectResource(resource, filteredResources, { metaKey: e.metaKey, shiftKey: e.shiftKey })}
            onDoubleClick={() => onOpen(resource)}
            onContextMenu={(e) => handleContextMenu(e, resource)}
          />
```

- [ ] **Step 5: Run TypeScript check**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar/ResourceList.tsx src/components/Sidebar/ResourceList.module.css src/locales/zh/search.json src/locales/en/search.json
git commit -m "feat(search): show 'body match' label in search results"
```

---

### Task 9: MCP types update

**Files:**
- Modify: `mcp/src/types.ts:1-14`

- [ ] **Step 1: Add `matchedBody` to MCP Resource type**

In `mcp/src/types.ts`, add the optional field to `Resource`:

```typescript
export interface Resource {
  id: string;
  title: string;
  url: string;
  domain: string | null;
  author: string | null;
  description: string | null;
  folder_id: string;
  resource_type: string;
  file_path: string;
  created_at: string;
  captured_at: string;
  selection_meta: string | null;
  matchedBody?: boolean;
}
```

Making it optional (`?`) means existing code that doesn't use it won't break. The MCP search tool formats results as plain text and can simply ignore this field.

- [ ] **Step 2: Commit**

```bash
git add mcp/src/types.ts
git commit -m "chore(mcp): add optional matchedBody field to Resource type"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run all Rust tests**

Run: `cd src-tauri && cargo test -- --nocapture`

Expected: All tests pass.

- [ ] **Step 2: Run cargo clippy**

Run: `cd src-tauri && cargo clippy -- -D warnings`

Expected: No warnings.

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 4: Verify i18n type safety**

Check that `src/types/i18next.d.ts` type augmentation picks up the new `bodyMatch` key (if using typed namespaces — may need manual verification that the key exists in both locale files).

- [ ] **Step 5: Commit any remaining fixes**

If clippy or tsc found issues, fix and commit.
