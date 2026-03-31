mod commands;
mod db;
mod mhtml;
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

/// Load a resource's snapshot HTML. Tries .html first, falls back to .mhtml (legacy).
fn load_resource_html(base_dir: &PathBuf, resource_id: &str) -> Option<String> {
    let html_path = base_dir
        .join("storage")
        .join(resource_id)
        .join("snapshot.html");

    if let Ok(content) = std::fs::read_to_string(&html_path) {
        return Some(content);
    }

    // Fallback: try legacy MHTML
    let mhtml_path = base_dir
        .join("storage")
        .join(resource_id)
        .join("snapshot.mhtml");

    if let Ok(data) = std::fs::read(&mhtml_path) {
        if let Some(archive) = mhtml::parse_mhtml(&data) {
            let html = String::from_utf8_lossy(&archive.html).to_string();
            // For legacy MHTML, inline resources via data URIs
            let mut result = html;
            for part in &archive.parts {
                if let Some(ref loc) = part.content_location {
                    let mime = &part.content_type;
                    let b64 = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &part.body,
                    );
                    let data_uri = format!("data:{};base64,{}", mime, b64);
                    result = result.replace(loc, &data_uri);
                }
            }
            return Some(result);
        }
    }

    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let base_dir = get_app_base_dir();

    // Initialize storage directory
    storage::init_storage(&base_dir).expect("failed to initialize storage");

    // Initialize database
    let db_path = base_dir.join("shibei.db");
    let conn = db::init_db(&db_path).expect("failed to initialize database");

    // Seed demo data if database is empty
    seed_demo_data(&conn);

    // Shared state for Tauri commands
    let cmd_state = Arc::new(commands::AppState {
        conn: TokioMutex::new(conn),
        base_dir: base_dir.clone(),
    });

    // Separate connection for HTTP server
    let server_conn = db::init_db(&db_path).expect("failed to open server db connection");
    let server_token = uuid::Uuid::new_v4().to_string();

    let server_state = Arc::new(server::AppState {
        conn: TokioMutex::new(server_conn),
        base_dir: base_dir.clone(),
        token: server_token,
    });

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
        .setup(move |_app| {
            tauri::async_runtime::spawn(server::start_server(server_state));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Seed demo data on first run (when no folders exist).
fn seed_demo_data(conn: &rusqlite::Connection) {
    use db::{folders, resources, tags};

    let existing = folders::list_children(conn, "__root__").unwrap_or_default();
    if !existing.is_empty() {
        return;
    }

    let tech = folders::create_folder(conn, "技术文章", "__root__").unwrap();
    let research = folders::create_folder(conn, "研究资料", "__root__").unwrap();
    let reading = folders::create_folder(conn, "稍后阅读", "__root__").unwrap();
    let _sub = folders::create_folder(conn, "Rust 笔记", &tech.id).unwrap();

    let tag_rust = tags::create_tag(conn, "Rust", "#E44D26").unwrap();
    let tag_web = tags::create_tag(conn, "Web", "#3B82F6").unwrap();
    let tag_ai = tags::create_tag(conn, "AI", "#8B5CF6").unwrap();
    let _tag_paper = tags::create_tag(conn, "论文", "#10B981").unwrap();

    let r1 = resources::create_resource(conn, resources::CreateResourceInput {
        id: None,
        title: "Rust 异步编程指南".to_string(),
        url: "https://rust-lang.github.io/async-book/".to_string(),
        domain: Some("rust-lang.github.io".to_string()),
        author: Some("Rust Team".to_string()),
        description: Some("Rust 异步编程的官方指南".to_string()),
        folder_id: tech.id.clone(),
        resource_type: "webpage".to_string(),
        file_path: format!("storage/{}/snapshot.html", uuid::Uuid::new_v4()),
        captured_at: "2026-03-28T10:00:00Z".to_string(),
    }).unwrap();

    let r2 = resources::create_resource(conn, resources::CreateResourceInput {
        id: None,
        title: "WebAssembly 与 Rust 实战".to_string(),
        url: "https://rustwasm.github.io/docs/book/".to_string(),
        domain: Some("rustwasm.github.io".to_string()),
        author: None,
        description: Some("使用 Rust 和 WebAssembly 构建高性能 Web 应用".to_string()),
        folder_id: tech.id.clone(),
        resource_type: "webpage".to_string(),
        file_path: format!("storage/{}/snapshot.html", uuid::Uuid::new_v4()),
        captured_at: "2026-03-29T14:30:00Z".to_string(),
    }).unwrap();

    let r3 = resources::create_resource(conn, resources::CreateResourceInput {
        id: None,
        title: "Attention Is All You Need".to_string(),
        url: "https://arxiv.org/abs/1706.03762".to_string(),
        domain: Some("arxiv.org".to_string()),
        author: Some("Vaswani et al.".to_string()),
        description: Some("Transformer 架构的开创性论文".to_string()),
        folder_id: research.id.clone(),
        resource_type: "webpage".to_string(),
        file_path: format!("storage/{}/snapshot.html", uuid::Uuid::new_v4()),
        captured_at: "2026-03-30T09:15:00Z".to_string(),
    }).unwrap();

    let _r4 = resources::create_resource(conn, resources::CreateResourceInput {
        id: None,
        title: "Tauri 2.0 发布公告".to_string(),
        url: "https://tauri.app/blog/tauri-2-0/".to_string(),
        domain: Some("tauri.app".to_string()),
        author: None,
        description: Some("Tauri 2.0 正式发布，支持移动端开发".to_string()),
        folder_id: reading.id.clone(),
        resource_type: "webpage".to_string(),
        file_path: format!("storage/{}/snapshot.html", uuid::Uuid::new_v4()),
        captured_at: "2026-03-31T08:00:00Z".to_string(),
    }).unwrap();

    // Real demo resource (MHTML legacy — backward compat test)
    let now = db::now_iso8601();
    let _ = conn.execute(
        "INSERT OR IGNORE INTO resources (id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at)
         VALUES ('demo', '知识星球 — 真实快照测试', 'https://wx.zsxq.com/group/51111821451424', 'wx.zsxq.com', NULL, '用于测试渲染和标注功能', ?1, 'webpage', 'storage/demo/snapshot.mhtml', ?2, '2026-03-31T16:00:00Z')",
        rusqlite::params![tech.id, now],
    );

    let _ = tags::add_tag_to_resource(conn, &r1.id, &tag_rust.id);
    let _ = tags::add_tag_to_resource(conn, &r2.id, &tag_rust.id);
    let _ = tags::add_tag_to_resource(conn, &r2.id, &tag_web.id);
    let _ = tags::add_tag_to_resource(conn, &r3.id, &tag_ai.id);
}

fn not_found(msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .header("Content-Type", "text/plain")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}
