use std::collections::HashMap;

/// A parsed MHTML part (one MIME section).
#[derive(Debug)]
pub struct MhtmlPart {
    pub content_type: String,
    pub content_id: Option<String>,
    pub content_location: Option<String>,
    pub body: Vec<u8>,
}

/// Parsed MHTML archive.
#[derive(Debug)]
pub struct MhtmlArchive {
    /// The main HTML document (first text/html part).
    pub html: Vec<u8>,
    /// Resources keyed by Content-ID (without angle brackets).
    pub by_content_id: HashMap<String, usize>,
    /// Resources keyed by Content-Location.
    pub by_location: HashMap<String, usize>,
    /// All parts.
    pub parts: Vec<MhtmlPart>,
}

impl MhtmlArchive {
    /// Look up a resource by `cid:xxx` reference or URL.
    pub fn find_resource(&self, reference: &str) -> Option<&MhtmlPart> {
        if let Some(cid) = reference.strip_prefix("cid:") {
            self.by_content_id
                .get(cid)
                .map(|&idx| &self.parts[idx])
        } else {
            self.by_location
                .get(reference)
                .map(|&idx| &self.parts[idx])
        }
    }
}

/// Parse an MHTML file into its constituent parts.
pub fn parse_mhtml(data: &[u8]) -> Option<MhtmlArchive> {
    let text = String::from_utf8_lossy(data);

    // Extract boundary from Content-Type header
    let boundary = extract_boundary(&text)?;
    let separator = format!("--{}", boundary);

    let mut parts = Vec::new();
    let mut by_content_id = HashMap::new();
    let mut by_location = HashMap::new();
    let mut html_index: Option<usize> = None;

    // Split by boundary
    let sections: Vec<&str> = text.split(&separator).collect();

    for section in &sections[1..] {
        // Skip closing boundary
        if section.starts_with("--") {
            continue;
        }

        let section = section.trim_start_matches("\r\n").trim_start_matches('\n');

        // Split headers from body
        let (headers_str, body_str) = if let Some(pos) = section.find("\r\n\r\n") {
            (&section[..pos], &section[pos + 4..])
        } else if let Some(pos) = section.find("\n\n") {
            (&section[..pos], &section[pos + 2..])
        } else {
            continue;
        };

        let headers = parse_headers(headers_str);
        let content_type = headers
            .get("content-type")
            .cloned()
            .unwrap_or_default();
        let transfer_encoding = headers
            .get("content-transfer-encoding")
            .cloned()
            .unwrap_or_default();
        let content_id = headers.get("content-id").cloned();
        let content_location = headers.get("content-location").cloned();

        // Decode body based on transfer encoding
        let body = decode_body(body_str, &transfer_encoding);

        let idx = parts.len();

        if let Some(ref cid) = content_id {
            // Strip angle brackets: <xxx> -> xxx
            let clean_cid = cid.trim_start_matches('<').trim_end_matches('>');
            by_content_id.insert(clean_cid.to_string(), idx);
        }
        if let Some(ref loc) = content_location {
            by_location.insert(loc.clone(), idx);
        }

        if html_index.is_none() && content_type.starts_with("text/html") {
            html_index = Some(idx);
        }

        parts.push(MhtmlPart {
            content_type,
            content_id,
            content_location,
            body,
        });
    }

    let html_idx = html_index?;
    let html = parts[html_idx].body.clone();

    Some(MhtmlArchive {
        html,
        by_content_id,
        by_location,
        parts,
    })
}

fn extract_boundary(text: &str) -> Option<String> {
    // Look for boundary="..." in the preamble headers
    for line in text.lines().take(20) {
        if let Some(pos) = line.find("boundary=") {
            let rest = &line[pos + 9..];
            let boundary = rest
                .trim_matches('"')
                .trim_end_matches(';')
                .trim_matches('"')
                .to_string();
            return Some(boundary);
        }
    }
    None
}

fn parse_headers(headers_str: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut current_key = String::new();
    let mut current_value = String::new();

    for line in headers_str.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            // Continuation of previous header
            current_value.push_str(line.trim());
        } else if let Some(colon_pos) = line.find(':') {
            // Save previous header
            if !current_key.is_empty() {
                map.insert(current_key.to_lowercase(), current_value.trim().to_string());
            }
            current_key = line[..colon_pos].to_string();
            current_value = line[colon_pos + 1..].to_string();
        }
    }
    // Save last header
    if !current_key.is_empty() {
        map.insert(current_key.to_lowercase(), current_value.trim().to_string());
    }

    map
}

fn decode_body(body: &str, encoding: &str) -> Vec<u8> {
    match encoding.to_lowercase().as_str() {
        "base64" => decode_base64(body),
        "quoted-printable" => decode_quoted_printable(body),
        _ => body.as_bytes().to_vec(),
    }
}

fn decode_base64(input: &str) -> Vec<u8> {
    // Strip whitespace and decode
    let clean: String = input.chars().filter(|c| !c.is_whitespace()).collect();

    // Simple base64 decoder
    let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = Vec::new();
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;

    for byte in clean.bytes() {
        if byte == b'=' {
            break;
        }
        let val = match table.iter().position(|&b| b == byte) {
            Some(v) => v as u32,
            None => continue,
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }

    output
}

fn decode_quoted_printable(input: &str) -> Vec<u8> {
    let mut output = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '=' {
            // Check for soft line break
            match chars.peek() {
                Some('\r') => {
                    chars.next(); // consume \r
                    if chars.peek() == Some(&'\n') {
                        chars.next(); // consume \n
                    }
                    // Soft line break — skip
                }
                Some('\n') => {
                    chars.next(); // consume \n
                    // Soft line break — skip
                }
                Some(_) => {
                    // Hex-encoded byte
                    let high = chars.next().unwrap_or('0');
                    let low = chars.next().unwrap_or('0');
                    let hex_str: String = [high, low].iter().collect();
                    if let Ok(byte) = u8::from_str_radix(&hex_str, 16) {
                        output.push(byte);
                    }
                }
                None => {}
            }
        } else {
            // Regular character — encode as UTF-8
            let mut buf = [0u8; 4];
            let encoded = ch.encode_utf8(&mut buf);
            output.extend_from_slice(encoded.as_bytes());
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_quoted_printable() {
        assert_eq!(
            decode_quoted_printable("hello=20world"),
            b"hello world"
        );
        assert_eq!(
            decode_quoted_printable("line1=\r\nline2"),
            b"line1line2"
        );
        assert_eq!(
            decode_quoted_printable("=3D"),
            b"="
        );
    }

    #[test]
    fn test_decode_base64() {
        assert_eq!(decode_base64("SGVsbG8="), b"Hello");
        assert_eq!(decode_base64("SGVs\nbG8="), b"Hello"); // with newline
    }

    #[test]
    fn test_extract_boundary() {
        let text = "Content-Type: multipart/related;\n\tboundary=\"----MyBoundary----\"\n\n";
        assert_eq!(extract_boundary(text), Some("----MyBoundary----".to_string()));
    }

    #[test]
    fn test_parse_simple_mhtml() {
        let mhtml = r#"From: test
Content-Type: multipart/related;
	boundary="BOUNDARY"

--BOUNDARY
Content-Type: text/html
Content-Location: https://example.com

<html><body>Hello</body></html>
--BOUNDARY
Content-Type: image/png
Content-ID: <img1@test>
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--BOUNDARY--
"#;
        let archive = parse_mhtml(mhtml.as_bytes()).unwrap();
        assert_eq!(archive.parts.len(), 2);
        assert!(String::from_utf8_lossy(&archive.html).contains("Hello"));
        assert!(archive.by_content_id.contains_key("img1@test"));
        assert!(archive.by_location.contains_key("https://example.com"));
    }
}
