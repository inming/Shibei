use scraper::Html;
use std::collections::HashSet;

/// Tags whose text content should be excluded from extraction.
const EXCLUDED_TAGS: &[&str] = &["script", "style", "noscript", "svg", "math"];

/// Block-level elements that should produce line breaks in output.
const BLOCK_TAGS: &[&str] = &[
    "p", "div", "section", "article", "aside", "header", "footer", "nav", "main", "h1", "h2",
    "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "li", "table", "tr", "td", "th",
    "br", "hr", "figcaption", "figure", "details", "summary", "dd", "dt", "dl", "address",
];

/// Extract visible plain text from HTML content.
///
/// Filters out script, style, noscript, svg, and math elements.
/// Preserves paragraph structure with newline separation for block-level elements.
/// Collapses multiple consecutive newlines into at most 2.
pub fn extract_plain_text(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }

    let document = Html::parse_document(html);

    // Collect node IDs that belong to excluded elements (including descendants)
    let mut excluded_ids = HashSet::new();
    for node_ref in document.tree.nodes() {
        if let scraper::Node::Element(el) = node_ref.value() {
            if EXCLUDED_TAGS.contains(&el.name()) {
                // Mark this node and all descendants as excluded
                for desc in node_ref.descendants() {
                    excluded_ids.insert(desc.id());
                }
            }
        }
    }

    // Walk all nodes in document order, collecting text
    let mut result = String::new();

    for node_ref in document.tree.nodes() {
        if excluded_ids.contains(&node_ref.id()) {
            continue;
        }

        match node_ref.value() {
            scraper::Node::Element(el) => {
                let tag = el.name();
                if BLOCK_TAGS.contains(&tag)
                    && !result.is_empty()
                    && !result.ends_with('\n')
                {
                    result.push('\n');
                }
            }
            scraper::Node::Text(text) => {
                let t = text.text.as_ref();
                let collapsed: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
                if !collapsed.is_empty() {
                    if !result.is_empty()
                        && !result.ends_with('\n')
                        && !result.ends_with(' ')
                        && !collapsed.starts_with(' ')
                    {
                        result.push(' ');
                    }
                    result.push_str(&collapsed);
                }
            }
            _ => {}
        }
    }

    // Collapse multiple newlines into at most 2
    let mut collapsed = String::with_capacity(result.len());
    let mut newline_count = 0;
    for ch in result.chars() {
        if ch == '\n' {
            newline_count += 1;
            if newline_count <= 2 {
                collapsed.push(ch);
            }
        } else {
            newline_count = 0;
            collapsed.push(ch);
        }
    }

    collapsed.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_extraction() {
        let html =
            r#"<html><head><title>Test</title></head><body><p>Hello world</p></body></html>"#;
        let text = extract_plain_text(html);
        assert!(text.contains("Hello world"));
    }

    #[test]
    fn test_filters_script_style() {
        let html = r#"<html><head><style>body{color:red}</style></head><body>
            <script>alert('hi')</script>
            <p>Visible text</p>
            <noscript>No JS</noscript>
        </body></html>"#;
        let text = extract_plain_text(html);
        assert!(text.contains("Visible text"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("color:red"));
        assert!(!text.contains("No JS"));
    }

    #[test]
    fn test_preserves_paragraph_structure() {
        let html = "<html><body><p>First paragraph</p><p>Second paragraph</p></body></html>";
        let text = extract_plain_text(html);
        assert!(text.contains("First paragraph"));
        assert!(text.contains("Second paragraph"));
        let first_pos = text.find("First paragraph").unwrap();
        let second_pos = text.find("Second paragraph").unwrap();
        let between = &text[first_pos + "First paragraph".len()..second_pos];
        assert!(between.contains('\n'));
    }

    #[test]
    fn test_empty_html() {
        let text = extract_plain_text("");
        assert!(text.is_empty() || text.trim().is_empty());
    }

    #[test]
    fn test_chinese_content() {
        let html = "<html><body><p>这是中文内容</p><p>第二段</p></body></html>";
        let text = extract_plain_text(html);
        assert!(text.contains("这是中文内容"));
        assert!(text.contains("第二段"));
    }
}
