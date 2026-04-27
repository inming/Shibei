mod commands;
mod server;

// Phase 2 crate refactor: facade re-exports keep the `crate::db::…`,
// `crate::events::…`, `crate::storage::…`, `crate::plain_text::…`,
// `crate::pdf_text::…`, `crate::sync::…`, `crate::sync::hlc::…`,
// `crate::sync::sync_log::…`, `crate::sync::SyncContext`, and
// `crate::backup::…` call sites in commands/server unchanged while the
// implementations live in their own crates.
pub use shibei_backup as backup;
pub use shibei_db as db;
pub use shibei_events as events;
pub use shibei_storage as storage;
pub use shibei_storage::plain_text;
pub use shibei_storage::pdf_text;
pub use shibei_sync as sync;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};

fn get_app_base_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("shibei")
}

const ANNOTATOR_JS: &str = include_str!("annotator.js");

/// Case-insensitive ASCII byte-level substring search.
fn find_ci(haystack: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let last = haystack.len() - needle.len();
    let mut i = start;
    while i <= last {
        let mut ok = true;
        for j in 0..needle.len() {
            if haystack[i + j].to_ascii_lowercase() != needle[j] {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Strip `<script …>…</script>` blocks from HTML. Matches only when the char after
/// "<script" is `>`, `/`, or ASCII whitespace (so `<scripted>` won't match). Also
/// handles event-handler attributes is out of scope here — those don't mutate DOM
/// at load time (they only fire on user interaction which doesn't happen inside
/// the read-only iframe).
fn strip_script_tags(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let hit = match find_ci(bytes, cursor, b"<script") {
            Some(p) => p,
            None => break,
        };
        // Boundary check: next byte must be `>`, `/`, or whitespace
        let after = hit + 7;
        let boundary = after >= bytes.len()
            || matches!(
                bytes[after],
                b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | 0x0c
            );
        if !boundary {
            // Skip this false hit, advance one byte
            out.push_str(&html[cursor..hit + 1]);
            cursor = hit + 1;
            continue;
        }
        // Emit everything before the tag
        out.push_str(&html[cursor..hit]);
        // Find end of opening tag `>`
        let open_end = match bytes[after..].iter().position(|&b| b == b'>') {
            Some(p) => after + p + 1,
            None => {
                // Malformed: no closing `>` — drop the rest
                cursor = bytes.len();
                break;
            }
        };
        // Find `</script` (case-insensitive)
        let close_hit = match find_ci(bytes, open_end, b"</script") {
            Some(p) => p,
            None => {
                // Unclosed — drop the rest
                cursor = bytes.len();
                break;
            }
        };
        // Find end of closing tag `>`
        let close_end = match bytes[close_hit + 8..].iter().position(|&b| b == b'>') {
            Some(p) => close_hit + 8 + p + 1,
            None => {
                cursor = bytes.len();
                break;
            }
        };
        cursor = close_end;
    }
    if cursor < bytes.len() {
        out.push_str(&html[cursor..]);
    }
    out
}

/// Inject annotator script into HTML content. Strips the page's own `<script>`
/// blocks first so they cannot mutate the DOM on reload (which would break
/// highlight anchor resolution).
fn inject_annotator_script(html: &str) -> String {
    let stripped = strip_script_tags(html);
    let override_css = "<style>*{-webkit-user-select:text!important;user-select:text!important;}</style>";
    let script_tag = format!("{}<script>{}</script>", override_css, ANNOTATOR_JS);
    if let Some(pos) = stripped.find("</head>") {
        let mut result = stripped;
        result.insert_str(pos, &script_tag);
        result
    } else if let Some(pos) = stripped.find("<body") {
        let mut result = stripped;
        result.insert_str(pos, &script_tag);
        result
    } else {
        format!("{}{}", script_tag, stripped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_scripts_removes_script_blocks() {
        let html = "<p>a</p><script>var x = 1;</script><p>b</p>";
        assert_eq!(strip_script_tags(html), "<p>a</p><p>b</p>");
    }

    #[test]
    fn strip_scripts_handles_attrs_and_case() {
        let html = r#"<SCRIPT type="text/javascript" nonce="x">doStuff()</Script>"#;
        assert_eq!(strip_script_tags(html), "");
    }

    #[test]
    fn strip_scripts_keeps_non_script() {
        let html = "<scripted>ok</scripted><p>hi</p>";
        assert_eq!(strip_script_tags(html), "<scripted>ok</scripted><p>hi</p>");
    }

    #[test]
    fn strip_scripts_handles_self_closing_like() {
        let html = "<script src=foo.js></script><p>x</p>";
        assert_eq!(strip_script_tags(html), "<p>x</p>");
    }

    #[test]
    fn strip_scripts_multiple() {
        let html = "a<script>1</script>b<script>2</script>c";
        assert_eq!(strip_script_tags(html), "abc");
    }

    #[test]
    fn strip_scripts_unclosed_drops_tail() {
        let html = "ok<script>never closes";
        assert_eq!(strip_script_tags(html), "ok");
    }
}

/// Load a resource's snapshot HTML.
fn load_resource_html(base_dir: &std::path::Path, resource_id: &str) -> Option<String> {
    let html_path = base_dir
        .join("storage")
        .join(resource_id)
        .join("snapshot.html");

    std::fs::read_to_string(&html_path).ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let base_dir = get_app_base_dir();

    // Initialize storage directory
    storage::init_storage(&base_dir).expect("failed to initialize storage");

    // Initialize database connection pool
    let db_path = base_dir.join("shibei.db");
    let pool = db::init_pool(&db_path).expect("failed to initialize database pool");
    let shared_pool: db::SharedPool = std::sync::Arc::new(std::sync::RwLock::new(pool));

    // Generate a single auth token shared between Tauri commands and HTTP server
    let auth_token = uuid::Uuid::new_v4().to_string();

    // Initialize sync clock and device ID
    let device_id = sync::device::get_or_create_device_id(&base_dir).ok();
    let sync_clock = device_id
        .as_ref()
        .map(|id| sync::hlc::HlcClock::new(id.clone()));

    // Shared state for Tauri commands
    let cmd_state = Arc::new(commands::AppState {
        pool: shared_pool.clone(),
        base_dir: base_dir.clone(),
        auth_token: auth_token.clone(),
        sync_clock,
        device_id: device_id.clone(),
        sync_engine: None, // Engine initialized on first sync or after config
    });

    let server_token = auth_token.clone();
    let server_base_dir = base_dir.clone();

    let mcp_token_path = base_dir.join("mcp-token");
    let mcp_token_value = auth_token.clone();
    let exit_token_path = base_dir.join("mcp-token");

    let protocol_base_dir = base_dir.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // When a second instance is launched (e.g. via deep link),
            // forward the URL to the existing window via event.
            if let Some(url) = argv.iter().find(|a| a.starts_with("shibei://")) {
                let _ = app.emit("deep-link-received", url.clone());
            }
            // Focus the existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(cmd_state)
        .manage(Arc::new(sync::EncryptionState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::cmd_list_folders,
            commands::cmd_get_folder,
            commands::cmd_get_folder_path,
            commands::cmd_create_folder,
            commands::cmd_rename_folder,
            commands::cmd_delete_folder,
            commands::cmd_move_folder,
            commands::cmd_reorder_folder,
            commands::cmd_list_resources,
            commands::cmd_get_resource,
            commands::cmd_delete_resource,
            commands::cmd_move_resource,
            commands::cmd_update_resource,
            commands::cmd_list_all_resources,
            commands::cmd_list_tags,
            commands::cmd_create_tag,
            commands::cmd_delete_tag,
            commands::cmd_get_tags_for_resource,
            commands::cmd_get_tags_for_resources,
            commands::cmd_add_tag_to_resource,
            commands::cmd_remove_tag_from_resource,
            commands::cmd_update_tag,
            commands::cmd_get_resources_by_tag,
            commands::cmd_get_highlights,
            commands::cmd_create_highlight,
            commands::cmd_update_highlight_color,
            commands::cmd_delete_highlight,
            commands::cmd_get_comments,
            commands::cmd_create_comment,
            commands::cmd_update_comment,
            commands::cmd_delete_comment,
            commands::cmd_get_folder_counts,
            commands::cmd_get_non_leaf_folder_ids,
            commands::cmd_get_auth_token,
            commands::cmd_debug_log,
            commands::cmd_sync_now,
            commands::cmd_reset_sync_cursors,
            commands::cmd_force_compact,
            commands::cmd_list_orphan_snapshots,
            commands::cmd_purge_orphan_snapshots,
            commands::cmd_save_sync_config,
            commands::cmd_get_sync_config,
            commands::cmd_test_s3_connection,
            commands::cmd_generate_pairing_payload,
            commands::cmd_download_snapshot,
            commands::cmd_get_snapshot_status,
            commands::cmd_set_sync_interval,
            commands::cmd_setup_encryption,
            commands::cmd_unlock_encryption,
            commands::cmd_change_encryption_password,
            commands::cmd_restore_keyring,
            commands::cmd_get_encryption_status,
            commands::cmd_auto_unlock,
            commands::cmd_set_remember_key,
            commands::cmd_get_remember_key,
            commands::cmd_list_deleted_resources,
            commands::cmd_list_deleted_folders,
            commands::cmd_restore_resource,
            commands::cmd_restore_folder,
            commands::cmd_purge_resource,
            commands::cmd_purge_folder,
            commands::cmd_purge_all_deleted,
            commands::cmd_setup_lock_pin,
            commands::cmd_verify_lock_pin,
            commands::cmd_get_lock_status,
            commands::cmd_set_lock_timeout,
            commands::cmd_disable_lock_pin,
            commands::cmd_search_resources,
            commands::cmd_get_index_stats,
            commands::cmd_get_annotation_counts,
            commands::cmd_get_resource_summary,
            commands::cmd_export_backup,
            commands::cmd_import_backup,
            commands::cmd_read_pdf_bytes,
            commands::cmd_import_pdf,
            commands::cmd_backfill_plain_text,
            commands::cmd_get_mcp_entry_path,
            commands::cmd_read_external_file,
            commands::cmd_write_external_file,
            commands::cmd_get_ai_tool_paths,
        ])
        .register_uri_scheme_protocol("shibei", move |_ctx, request| {
            let path = request.uri().path();
            let parts: Vec<&str> = path.trim_start_matches('/').splitn(2, '/').collect();

            if parts.is_empty() || parts[0] != "resource" || parts.len() < 2 {
                return not_found("unknown route");
            }

            let resource_id = parts[1];

            match load_resource_html(&protocol_base_dir, resource_id) {
                Some(html) => {
                    let with_annotator = inject_annotator_script(&html);
                    tauri::http::Response::builder()
                        .header("Content-Type", "text/html; charset=utf-8")
                        .body(with_annotator.into_bytes())
                        .unwrap()
                }
                None => not_found(&format!("resource not found: {}", resource_id)),
            }
        })
        .setup(move |app| {
            // If launched by the OS autostart mechanism, minimize immediately
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }
            // Create server state with app_handle for event emission
            let server_sync_clock = device_id
                .as_ref()
                .map(|id| sync::hlc::HlcClock::new(id.clone()));
            let fts_pool = shared_pool.clone();
            let fts_base_dir = base_dir.clone();
            let server_state = Arc::new(server::AppState {
                pool: shared_pool.clone(),
                base_dir: server_base_dir,
                token: server_token,
                app_handle: app.handle().clone(),
                sync_clock: server_sync_clock,
                device_id,
            });
            // Write MCP token file for external MCP server process
            if let Err(e) = std::fs::write(&mcp_token_path, &mcp_token_value) {
                eprintln!("[shibei] Failed to write MCP token file: {}", e);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    &mcp_token_path,
                    std::fs::Permissions::from_mode(0o600),
                );
            }
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::start_server(server_state).await {
                    eprintln!("[shibei] HTTP server failed: {}", e);
                }
            });
            // One-shot migration of legacy SQLite-stored S3 credentials to
            // the OS keychain. Best-effort: keystore failures leave the
            // SQLite rows in place so sync still works via the fallback
            // path in `load_credentials`. Next startup retries.
            {
                let mig_pool = shared_pool.clone();
                std::thread::spawn(move || {
                    let pool_guard = match mig_pool.read() {
                        Ok(g) => g,
                        Err(e) => {
                            eprintln!("[shibei] pool lock poisoned at creds migration: {}", e);
                            return;
                        }
                    };
                    let conn = match pool_guard.get() {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[shibei] db conn for creds migration failed: {}", e);
                            return;
                        }
                    };
                    match sync::credentials::migrate_credentials_to_keystore(&conn) {
                        Ok(true) => eprintln!("[shibei] S3 credentials migrated from SQLite to OS keychain"),
                        Ok(false) => { /* nothing to migrate, or keystore busy */ }
                        Err(e) => eprintln!("[shibei] creds migration db error: {}", e),
                    }
                });
            }
            // Initialize FTS search index if not yet done
            {
                std::thread::spawn(move || {
                    let pool_guard = match fts_pool.read() {
                        Ok(g) => g,
                        Err(e) => {
                            eprintln!("[shibei] pool lock poisoned: {}", e);
                            return;
                        }
                    };
                    if let Ok(conn) = pool_guard.get() {
                        match db::search::is_fts_initialized(&conn) {
                            Ok(false) => {
                                // Backfill plain_text for resources missing it
                                match db::search::backfill_plain_text(
                                    &conn,
                                    &fts_base_dir,
                                    plain_text::extract_plain_text,
                                ) {
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = std::fs::remove_file(&exit_token_path);
            }
        });
}

fn not_found(msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .header("Content-Type", "text/plain")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}
