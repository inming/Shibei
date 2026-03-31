mod commands;
mod db;
mod mhtml;
mod server;
mod storage;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::Mutex as TokioMutex;

fn get_app_base_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("shibei")
}

/// Rewrite resource references in HTML so they go through the custom protocol.
fn rewrite_html_references(html: &str, resource_id: &str, archive: &mhtml::MhtmlArchive) -> String {
    let mut result = html.to_string();
    for part in &archive.parts {
        if let Some(ref loc) = part.content_location {
            let encoded = urlencode_path(loc);
            let new_url = format!("shibei://localhost/res/{}/{}", resource_id, encoded);
            result = result.replace(loc, &new_url);
        }
    }
    result
}

fn urlencode_path(s: &str) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

fn urldecode_path(s: &str) -> String {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                &String::from_utf8_lossy(&bytes[i + 1..i + 3]),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

struct MhtmlCache {
    entries: HashMap<String, mhtml::MhtmlArchive>,
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

    // MHTML cache for custom protocol (uses std Mutex since protocol handler is sync)
    let cache = StdMutex::new(MhtmlCache {
        entries: HashMap::new(),
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
            let parts: Vec<&str> = path.trim_start_matches('/').splitn(3, '/').collect();

            if parts.is_empty() {
                return not_found("empty path");
            }

            match parts[0] {
                "resource" if parts.len() >= 2 => {
                    let resource_id = parts[1];
                    let file_path = protocol_base_dir
                        .join("storage")
                        .join(resource_id)
                        .join("snapshot.mhtml");

                    let data = match std::fs::read(&file_path) {
                        Ok(d) => d,
                        Err(_) => {
                            return not_found(&format!("file not found: {}", file_path.display()))
                        }
                    };

                    let archive = match mhtml::parse_mhtml(&data) {
                        Some(a) => a,
                        None => return not_found("failed to parse MHTML"),
                    };

                    let html_str = String::from_utf8_lossy(&archive.html);
                    let rewritten = rewrite_html_references(&html_str, resource_id, &archive);

                    if let Ok(mut c) = cache.lock() {
                        c.entries.insert(resource_id.to_string(), archive);
                    }

                    tauri::http::Response::builder()
                        .header("Content-Type", "text/html; charset=utf-8")
                        .body(rewritten.into_bytes())
                        .unwrap()
                }
                "res" if parts.len() >= 3 => {
                    let resource_id = parts[1];
                    let encoded_location = parts[2];
                    let location = urldecode_path(encoded_location);

                    if let Ok(c) = cache.lock() {
                        if let Some(archive) = c.entries.get(resource_id) {
                            if let Some(&idx) = archive.by_location.get(&location) {
                                let part = &archive.parts[idx];
                                return tauri::http::Response::builder()
                                    .header("Content-Type", &part.content_type)
                                    .body(part.body.clone())
                                    .unwrap();
                            }
                        }
                    }

                    not_found(&format!("resource not found: {}", location))
                }
                _ => not_found("unknown route"),
            }
        })
        .setup(move |_app| {
            // Start HTTP server for browser extension communication
            tauri::async_runtime::spawn(server::start_server(server_state));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Seed demo data on first run (when no folders exist).
fn seed_demo_data(conn: &rusqlite::Connection) {
    use db::{folders, resources, tags};

    // Check if we already have folders
    let existing = folders::list_children(conn, "__root__").unwrap_or_default();
    if !existing.is_empty() {
        return;
    }

    // Create folders
    let tech = folders::create_folder(conn, "技术文章", "__root__").unwrap();
    let research = folders::create_folder(conn, "研究资料", "__root__").unwrap();
    let reading = folders::create_folder(conn, "稍后阅读", "__root__").unwrap();
    let _sub = folders::create_folder(conn, "Rust 笔记", &tech.id).unwrap();

    // Create tags
    let tag_rust = tags::create_tag(conn, "Rust", "#E44D26").unwrap();
    let tag_web = tags::create_tag(conn, "Web", "#3B82F6").unwrap();
    let tag_ai = tags::create_tag(conn, "AI", "#8B5CF6").unwrap();
    let _tag_paper = tags::create_tag(conn, "论文", "#10B981").unwrap();

    // Create demo resources
    let r1 = resources::create_resource(conn, resources::CreateResourceInput {
        title: "Rust 异步编程指南".to_string(),
        url: "https://rust-lang.github.io/async-book/".to_string(),
        domain: Some("rust-lang.github.io".to_string()),
        author: Some("Rust Team".to_string()),
        description: Some("Rust 异步编程的官方指南，覆盖 Future、async/await 等核心概念".to_string()),
        folder_id: tech.id.clone(),
        resource_type: "webpage".to_string(),
        file_path: format!("storage/{}/snapshot.mhtml", uuid::Uuid::new_v4()),
        captured_at: "2026-03-28T10:00:00Z".to_string(),
    }).unwrap();

    let r2 = resources::create_resource(conn, resources::CreateResourceInput {
        title: "WebAssembly 与 Rust 实战".to_string(),
        url: "https://rustwasm.github.io/docs/book/".to_string(),
        domain: Some("rustwasm.github.io".to_string()),
        author: None,
        description: Some("使用 Rust 和 WebAssembly 构建高性能 Web 应用".to_string()),
        folder_id: tech.id.clone(),
        resource_type: "webpage".to_string(),
        file_path: format!("storage/{}/snapshot.mhtml", uuid::Uuid::new_v4()),
        captured_at: "2026-03-29T14:30:00Z".to_string(),
    }).unwrap();

    let r3 = resources::create_resource(conn, resources::CreateResourceInput {
        title: "Attention Is All You Need".to_string(),
        url: "https://arxiv.org/abs/1706.03762".to_string(),
        domain: Some("arxiv.org".to_string()),
        author: Some("Vaswani et al.".to_string()),
        description: Some("Transformer 架构的开创性论文".to_string()),
        folder_id: research.id.clone(),
        resource_type: "webpage".to_string(),
        file_path: format!("storage/{}/snapshot.mhtml", uuid::Uuid::new_v4()),
        captured_at: "2026-03-30T09:15:00Z".to_string(),
    }).unwrap();

    let _r4 = resources::create_resource(conn, resources::CreateResourceInput {
        title: "Tauri 2.0 发布公告".to_string(),
        url: "https://tauri.app/blog/tauri-2-0/".to_string(),
        domain: Some("tauri.app".to_string()),
        author: None,
        description: Some("Tauri 2.0 正式发布，支持移动端开发".to_string()),
        folder_id: reading.id.clone(),
        resource_type: "webpage".to_string(),
        file_path: format!("storage/{}/snapshot.mhtml", uuid::Uuid::new_v4()),
        captured_at: "2026-03-31T08:00:00Z".to_string(),
    }).unwrap();

    // Tag resources
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
