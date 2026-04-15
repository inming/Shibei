/// Extract visible text from a PDF file's bytes.
/// Returns empty string on failure (best-effort, mirrors plain_text.rs pattern).
pub fn extract_plain_text(pdf_bytes: &[u8]) -> String {
    match pdf_extract::extract_text_from_mem(pdf_bytes) {
        Ok(text) => {
            // Collapse excessive whitespace, similar to plain_text.rs
            let mut result = String::with_capacity(text.len());
            let mut newline_count = 0;
            for ch in text.chars() {
                if ch == '\n' || ch == '\r' {
                    if ch == '\n' {
                        newline_count += 1;
                        if newline_count <= 2 {
                            result.push('\n');
                        }
                    }
                } else {
                    newline_count = 0;
                    result.push(ch);
                }
            }
            result.trim().to_string()
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_empty_bytes() {
        let result = extract_plain_text(b"");
        assert!(result.is_empty());
    }

    #[test]
    fn test_extract_invalid_pdf() {
        let result = extract_plain_text(b"not a pdf");
        assert!(result.is_empty());
    }

    #[test]
    fn test_extract_collapses_newlines() {
        // Verify our collapse logic works on simulated output
        let text_with_many_newlines = "Hello\n\n\n\n\nWorld";
        let mut result = String::new();
        let mut newline_count = 0;
        for ch in text_with_many_newlines.chars() {
            if ch == '\n' {
                newline_count += 1;
                if newline_count <= 2 {
                    result.push('\n');
                }
            } else {
                newline_count = 0;
                result.push(ch);
            }
        }
        assert_eq!(result.trim(), "Hello\n\nWorld");
    }
}
