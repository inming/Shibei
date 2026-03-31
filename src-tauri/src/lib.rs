mod commands;
mod db;
mod mhtml;
mod server;
mod storage;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

fn get_app_base_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("shibei")
}

/// Rewrite resource references in HTML so they go through the custom protocol.
/// Both `cid:xxx` and `https://...` references become `shibei://localhost/res/{resource_id}/...`
fn rewrite_html_references(html: &str, resource_id: &str, archive: &mhtml::MhtmlArchive) -> String {
    let mut result = html.to_string();

    // Collect all Content-Location values and create URL rewrites
    for part in &archive.parts {
        if let Some(ref loc) = part.content_location {
            let encoded = urlencode_path(loc);
            let new_url = format!("shibei://localhost/res/{}/{}", resource_id, encoded);
            result = result.replace(loc, &new_url);
        }
    }

    result
}

/// Simple URL encoding for path segments (encode non-ASCII and special chars).
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

/// Decode percent-encoded path back to original string.
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

/// Cache for parsed MHTML archives, keyed by resource_id.
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
    let _conn = db::init_db(&db_path).expect("failed to initialize database");

    let cache = Mutex::new(MhtmlCache {
        entries: HashMap::new(),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("shibei", move |_ctx, request| {
            let path = request.uri().path();
            let parts: Vec<&str> = path.trim_start_matches('/').splitn(3, '/').collect();

            if parts.is_empty() {
                return not_found("empty path");
            }

            match parts[0] {
                // shibei://localhost/resource/{resource_id}
                // Parse MHTML, cache it, return rewritten HTML
                "resource" if parts.len() >= 2 => {
                    let resource_id = parts[1];
                    let file_path = base_dir
                        .join("storage")
                        .join(resource_id)
                        .join("snapshot.mhtml");

                    let data = match std::fs::read(&file_path) {
                        Ok(d) => d,
                        Err(_) => {
                            return not_found(&format!(
                                "file not found: {}",
                                file_path.display()
                            ))
                        }
                    };

                    let archive = match mhtml::parse_mhtml(&data) {
                        Some(a) => a,
                        None => return not_found("failed to parse MHTML"),
                    };

                    let html_str = String::from_utf8_lossy(&archive.html);
                    let rewritten = rewrite_html_references(&html_str, resource_id, &archive);

                    // Cache the archive for sub-resource requests
                    if let Ok(mut c) = cache.lock() {
                        c.entries.insert(resource_id.to_string(), archive);
                    }

                    tauri::http::Response::builder()
                        .header("Content-Type", "text/html; charset=utf-8")
                        .body(rewritten.into_bytes())
                        .unwrap()
                }
                // shibei://localhost/res/{resource_id}/{encoded_content_location}
                // Serve a sub-resource by its original Content-Location
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
