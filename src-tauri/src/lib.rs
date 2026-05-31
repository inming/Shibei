mod commands;
mod server;
mod sync_engine_factory;

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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// Process-wide flag set when a real quit is requested (tray menu / app.exit).
/// Used by the CloseRequested handler to bypass close-to-tray.
struct QuittingFlag(AtomicBool);

fn close_to_tray_enabled(pool: &db::SharedPool) -> bool {
    let pool_guard = match pool.read() {
        Ok(g) => g,
        Err(_) => return true,
    };
    let conn = match pool_guard.get() {
        Ok(c) => c,
        Err(_) => return true,
    };
    sync::sync_state::get(&conn, "config:close_to_tray")
        .ok()
        .flatten()
        .map(|v| v != "false")
        .unwrap_or(true)
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

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
            // Surface the existing window (may be hidden by close-to-tray).
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(cmd_state)
        .manage(Arc::new(sync::EncryptionState::new()))
        .manage(Arc::new(QuittingFlag(AtomicBool::new(false))))
        .on_window_event({
            let close_pool = shared_pool.clone();
            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window.label() != "main" {
                        return;
                    }
                    let app = window.app_handle();
                    let quitting = app
                        .state::<Arc<QuittingFlag>>()
                        .0
                        .load(Ordering::SeqCst);
                    if quitting {
                        return;
                    }
                    if close_to_tray_enabled(&close_pool) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
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
            commands::cmd_list_tags_in_folder,
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
            commands::cmd_get_close_to_tray,
            commands::cmd_set_close_to_tray,
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
            commands::cmd_import_audio,
            commands::cmd_backfill_plain_text,
            commands::cmd_get_mcp_entry_path,
            commands::cmd_read_external_file,
            commands::cmd_write_external_file,
            commands::cmd_get_ai_tool_paths,
            commands::cmd_get_highlight,
            commands::cmd_get_comment,
            commands::cmd_list_questions,
            commands::cmd_search_questions,
            commands::cmd_get_question,
            commands::cmd_create_question,
            commands::cmd_update_question,
            commands::cmd_archive_question,
            commands::cmd_unarchive_question,
            commands::cmd_delete_question,
            commands::cmd_list_question_links,
            commands::cmd_list_questions_for_target,
            commands::cmd_list_questions_for_resources,
            commands::cmd_link_to_question,
            commands::cmd_update_link_reason,
            commands::cmd_unlink,
        ])
        .register_uri_scheme_protocol("shibei", move |_ctx, request| {
            let path = request.uri().path();
            let parts: Vec<&str> = path.trim_start_matches('/').splitn(2, '/').collect();

            if parts.is_empty() || parts[0] != "resource" || parts.len() < 2 {
                return not_found("unknown route");
            }

            let resource_id = parts[1];

            // HTML snapshot: inject annotator and serve as a document.
            if let Some(html) = load_resource_html(&protocol_base_dir, resource_id) {
                let with_annotator = inject_annotator_script(&html);
                return tauri::http::Response::builder()
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(with_annotator.into_bytes())
                    .unwrap();
            }

            // Audio snapshot: serve raw bytes with HTTP Range support so the
            // WebView's <audio> element can stream and seek without loading the
            // whole file (see audio-support-design §3).
            if let Some(audio_path) = find_audio_snapshot(&protocol_base_dir, resource_id) {
                return serve_file_with_range(&audio_path, request.headers().get("Range"));
            }

            not_found(&format!("resource not found: {}", resource_id))
        })
        .setup(move |app| {
            // If launched by the OS autostart mechanism, hide the window
            // entirely so the app sits silently in the tray.
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            // System tray with menu (open / sync now / quit)
            let tray_open = MenuItem::with_id(app, "tray:open", "Open Shibei", true, None::<&str>)?;
            let tray_sync = MenuItem::with_id(app, "tray:sync", "Sync now", true, None::<&str>)?;
            let tray_quit = MenuItem::with_id(app, "tray:quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&tray_open, &separator, &tray_sync, &separator, &tray_quit],
            )?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("missing default window icon")?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(false)
                .tooltip("Shibei")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray:open" => show_main_window(app),
                    "tray:sync" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let cmd_state = app.state::<Arc<commands::AppState>>();
                            let enc_state = app.state::<Arc<sync::EncryptionState>>();
                            if let Err(e) =
                                commands::cmd_sync_now(cmd_state, enc_state, app.clone()).await
                            {
                                eprintln!("[shibei] tray sync failed: {:?}", e);
                            }
                        });
                    }
                    "tray:quit" => {
                        app.state::<Arc<QuittingFlag>>()
                            .0
                            .store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
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
                        // Question FTS init — separate flag so existing FTS
                        // users still get the new index built on upgrade.
                        match db::search::is_question_fts_initialized(&conn) {
                            Ok(false) => {
                                if let Err(e) = db::search::rebuild_all_question_search_index(&conn) {
                                    eprintln!("[shibei] question FTS rebuild failed: {}", e);
                                } else if let Err(e) = db::search::mark_question_fts_initialized(&conn) {
                                    eprintln!("[shibei] question FTS flag write failed: {}", e);
                                }
                            }
                            Err(e) => eprintln!("[shibei] question FTS init check failed: {}", e),
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

/// Audio container extensions served over the `shibei://` protocol. Mirrors
/// `commands::AUDIO_IMPORT_EXTENSIONS` and the frontend file-dialog filter.
const AUDIO_EXTENSIONS: &[&str] =
    &["mp3", "m4a", "aac", "mp4", "wav", "ogg", "oga", "opus", "flac", "weba", "webm"];

/// Locate a resource's audio snapshot on disk (`storage/{id}/snapshot.{ext}`),
/// trying only known audio extensions so a `snapshot.pdf` is never mistaken for
/// audio.
fn find_audio_snapshot(base_dir: &std::path::Path, resource_id: &str) -> Option<std::path::PathBuf> {
    let dir = base_dir.join("storage").join(resource_id);
    AUDIO_EXTENSIONS
        .iter()
        .map(|ext| dir.join(format!("snapshot.{ext}")))
        .find(|p| p.is_file())
}

/// Map an audio file's extension to its MIME type. The WebView decides
/// playability from this header, not the URL.
fn audio_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("m4a") | Some("aac") | Some("mp4") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("flac") => "audio/flac",
        Some("weba") | Some("webm") => "audio/webm",
        _ => "application/octet-stream",
    }
}

/// Parse an HTTP `Range: bytes=...` header into an inclusive (start, end) byte
/// range clamped to `total`. Supports `bytes=START-`, `bytes=START-END`, and
/// suffix `bytes=-N`. Returns None for unsatisfiable or malformed ranges.
fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    // Only the first range of a possibly-comma-separated list is honored.
    let spec = spec.split(',').next()?.trim();
    let (start_s, end_s) = spec.split_once('-')?;
    if start_s.is_empty() {
        // Suffix range: last N bytes.
        let n: u64 = end_s.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((total.saturating_sub(n), total - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    if start >= total {
        return None;
    }
    let end: u64 = if end_s.is_empty() {
        total - 1
    } else {
        end_s.parse::<u64>().ok()?.min(total - 1)
    };
    if start > end {
        return None;
    }
    Some((start, end))
}

/// Serve a file with Range support: 206 + Content-Range for a ranged request,
/// otherwise 200 with the full body. Always advertises `Accept-Ranges: bytes`.
fn serve_file_with_range(
    path: &std::path::Path,
    range_header: Option<&tauri::http::HeaderValue>,
) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let total = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return not_found("audio file missing"),
    };
    let mime = audio_mime(path);

    if let Some((start, end)) = range_header
        .and_then(|v| v.to_str().ok())
        .and_then(|h| parse_byte_range(h, total))
    {
        let len = end - start + 1;
        let mut buf = vec![0u8; len as usize];
        let read_ok = std::fs::File::open(path)
            .and_then(|mut f| {
                f.seek(SeekFrom::Start(start))?;
                f.read_exact(&mut buf)?;
                Ok(())
            })
            .is_ok();
        if read_ok {
            return tauri::http::Response::builder()
                .status(206)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes {}-{}/{}", start, end, total))
                .header("Content-Length", len.to_string())
                .body(buf)
                .unwrap();
        }
    }

    match std::fs::read(path) {
        Ok(data) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", total.to_string())
            .body(data)
            .unwrap(),
        Err(_) => not_found("audio file unreadable"),
    }
}

#[cfg(test)]
mod audio_protocol_tests {
    use super::parse_byte_range;

    #[test]
    fn parses_open_ended_range() {
        assert_eq!(parse_byte_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_byte_range("bytes=500-", 1000), Some((500, 999)));
    }

    #[test]
    fn parses_closed_range_and_clamps_end() {
        assert_eq!(parse_byte_range("bytes=0-499", 1000), Some((0, 499)));
        assert_eq!(parse_byte_range("bytes=900-5000", 1000), Some((900, 999)));
    }

    #[test]
    fn parses_suffix_range() {
        assert_eq!(parse_byte_range("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_byte_range("bytes=-5000", 1000), Some((0, 999)));
    }

    #[test]
    fn rejects_malformed_or_unsatisfiable() {
        assert_eq!(parse_byte_range("bytes=2000-3000", 1000), None);
        assert_eq!(parse_byte_range("items=0-10", 1000), None);
        assert_eq!(parse_byte_range("bytes=abc", 1000), None);
        assert_eq!(parse_byte_range("bytes=0-0", 0), None);
    }
}
