/// Extract visible text from a PDF file's bytes.
/// Returns empty string on failure (best-effort, mirrors plain_text.rs pattern).
///
/// Uses `catch_unwind` because `pdf-extract` can panic on certain PDFs
/// (e.g. UTF-16 encoding errors, malformed font tables) instead of
/// returning `Err`.
pub fn extract_plain_text(pdf_bytes: &[u8]) -> String {
    let result = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(pdf_bytes));

    let text = match result {
        Ok(Ok(t)) => t,
        _ => return String::new(), // Err or panic → empty
    };

    // Collapse excessive whitespace, similar to plain_text.rs
    let mut out = String::with_capacity(text.len());
    let mut newline_count = 0;
    for ch in text.chars() {
        if ch == '\n' || ch == '\r' {
            if ch == '\n' {
                newline_count += 1;
                if newline_count <= 2 {
                    out.push('\n');
                }
            }
        } else {
            newline_count = 0;
            out.push(ch);
        }
    }
    out.trim().to_string()
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
        let text = "Hello\n\n\n\n\nWorld";
        let mut result = String::new();
        let mut newline_count = 0;
        for ch in text.chars() {
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
