mod commands;
mod db;
mod server;
mod storage;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex as TokioMutex;

fn get_app_base_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("shibei")
}

const ANNOTATOR_JS: &str = include_str!("annotator.js");

/// Inject annotator script into HTML content.
fn inject_annotator_script(html: &str) -> String {
    let script_tag = format!("<script>{}</script>", ANNOTATOR_JS);
    if let Some(pos) = html.find("</head>") {
        let mut result = html.to_string();
        result.insert_str(pos, &script_tag);
        result
    } else if let Some(pos) = html.find("<body") {
        let mut result = html.to_string();
        result.insert_str(pos, &script_tag);
        result
    } else {
        format!("{}{}", script_tag, html)
    }
}

/// Load a resource's snapshot HTML.
fn load_resource_html(base_dir: &PathBuf, resource_id: &str) -> Option<String> {
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

    // Initialize database
    let db_path = base_dir.join("shibei.db");
    let conn = db::init_db(&db_path).expect("failed to initialize database");

    // Shared state for Tauri commands
    let cmd_state = Arc::new(commands::AppState {
        conn: TokioMutex::new(conn),
        base_dir: base_dir.clone(),
    });

    // Separate connection for HTTP server (app_handle added in setup)
    let server_conn = db::init_db(&db_path).expect("failed to open server db connection");
    let server_token = uuid::Uuid::new_v4().to_string();
    let server_base_dir = base_dir.clone();
    let server_token_clone = server_token.clone();

    let protocol_base_dir = base_dir.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(cmd_state)
        .invoke_handler(tauri::generate_handler![
            commands::cmd_list_folders,
            commands::cmd_create_folder,
            commands::cmd_rename_folder,
            commands::cmd_delete_folder,
            commands::cmd_move_folder,
            commands::cmd_list_resources,
            commands::cmd_get_resource,
            commands::cmd_delete_resource,
            commands::cmd_list_tags,
            commands::cmd_create_tag,
            commands::cmd_delete_tag,
            commands::cmd_get_tags_for_resource,
            commands::cmd_get_highlights,
            commands::cmd_create_highlight,
            commands::cmd_delete_highlight,
            commands::cmd_get_comments,
            commands::cmd_create_comment,
            commands::cmd_update_comment,
            commands::cmd_delete_comment,
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
            // Create server state with app_handle for event emission
            let server_state = Arc::new(server::AppState {
                conn: TokioMutex::new(server_conn),
                base_dir: server_base_dir,
                token: server_token_clone,
                app_handle: app.handle().clone(),
            });
            tauri::async_runtime::spawn(server::start_server(server_state));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn not_found(msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .header("Content-Type", "text/plain")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}
