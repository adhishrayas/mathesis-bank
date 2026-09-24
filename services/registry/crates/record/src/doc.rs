//! A docstring, rendered. The author's Markdown is reduced to paragraphs, lists,
//! inline code, strong, emphasis and links over http(s); every other character
//! is text, escaped, so no HTML written in a docstring reaches a page. The text
//! the page carries — every text node, concatenated — is returned beside the
//! HTML, because that is what the value check reads back.

use crate::html::escape;

struct Out {
    html: String,
    text: String,
}

impl Out {
    fn text(&mut self, s: &str) {
        self.html.push_str(&escape(s));
        self.text.push_str(s);
    }
}

pub fn render(md: &str) -> (String, String) {
    let mut o = Out {
        html: String::new(),
        text: String::new(),
    };
    let normalized = md.replace("\r\n", "\n");
    let mut lines = normalized.lines().peekable();
    while let Some(line) = lines.next() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("```") {
            let mut code: Vec<&str> = Vec::new();
            for l in lines.by_ref() {
                if l.trim().starts_with("```") {
                    break;
                }
                code.push(l);
            }
            // Not a `<pre>`: that element is reserved for the roles the record
            // declares (a statement, a log, a report); the whitespace is CSS.
            o.html.push_str("<div class=\"mth-docstring__code\"><code>");
            o.text(&code.join("\n"));
            o.html.push_str("</code></div>");
        } else if is_item(t) {
            o.html.push_str("<ul>");
            let mut item = item_text(t).to_string();
            while let Some(next) = lines.peek() {
                let nt = next.trim();
                if nt.is_empty() {
                    break;
                }
                lines.next();
                if is_item(nt) {
                    o.html.push_str("<li>");
                    inline(&mut o, &item);
                    o.html.push_str("</li>");
                    item = item_text(nt).to_string();
                } else {
                    item.push(' ');
                    item.push_str(nt);
                }
            }
            o.html.push_str("<li>");
            inline(&mut o, &item);
            o.html.push_str("</li></ul>");
        } else {
            let mut para = t.trim_start_matches('#').trim().to_string();
            while let Some(next) = lines.peek() {
                let nt = next.trim();
                if nt.is_empty() || nt.starts_with("```") || is_item(nt) {
                    break;
                }
                lines.next();
                para.push(' ');
                para.push_str(nt);
            }
            o.html.push_str("<p>");
            inline(&mut o, &para);
            o.html.push_str("</p>");
        }
    }
    (o.html, o.text)
}

fn is_item(t: &str) -> bool {
    t.starts_with("- ") || t.starts_with("* ")
}

fn item_text(t: &str) -> &str {
    t[2..].trim_start()
}

/// Inline spans. An unclosed marker is text.
fn inline(o: &mut Out, s: &str) {
    let mut rest = s;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('`') {
            if let Some(end) = after.find('`') {
                o.html.push_str("<code>");
                o.text(&after[..end]);
                o.html.push_str("</code>");
                rest = &after[end + 1..];
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("**") {
            if let Some(end) = after.find("**") {
                if end > 0 {
                    o.html.push_str("<strong>");
                    inline(o, &after[..end]);
                    o.html.push_str("</strong>");
                    rest = &after[end + 2..];
                    continue;
                }
            }
        }
        if let Some(after) = rest.strip_prefix('*') {
            if !after.starts_with([' ', '*']) {
                if let Some(end) = after.find('*') {
                    if end > 0 {
                        o.html.push_str("<em>");
                        inline(o, &after[..end]);
                        o.html.push_str("</em>");
                        rest = &after[end + 1..];
                        continue;
                    }
                }
            }
        }
        if let Some(after) = rest.strip_prefix('[') {
            if let Some(close) = after.find("](") {
                let label = &after[..close];
                let tail = &after[close + 2..];
                if let Some(end) = tail.find(')') {
                    let url = &tail[..end];
                    if (url.starts_with("https://") || url.starts_with("http://"))
                        && !url.contains(|c: char| c.is_whitespace() || c == '"' || c == '<')
                    {
                        o.html.push_str(&format!(
                            "<a href=\"{}\" rel=\"nofollow noopener noreferrer\">",
                            escape(url)
                        ));
                        inline(o, label);
                        o.html.push_str("</a>");
                        rest = &tail[end + 1..];
                        continue;
                    }
                }
            }
        }
        // Advance by one whole character, never one byte: `𝒜` is four.
        let first = rest.chars().next().map_or(1, char::len_utf8);
        let next = rest[first..]
            .find(['`', '*', '['])
            .map_or(rest.len(), |i| i + first);
        o.text(&rest[..next]);
        rest = &rest[next..];
    }
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn spans_and_paragraphs() {
        let (html, text) = render("**Pajor's inequality**, with no `A`\nhypothesis.\n\nSecond *part*.");
        assert_eq!(
            html,
            "<p><strong>Pajor&#39;s inequality</strong>, with no <code>A</code> hypothesis.</p>\
             <p>Second <em>part</em>.</p>"
        );
        assert_eq!(text, "Pajor's inequality, with no A hypothesis.Second part.");
    }

    #[test]
    fn no_markup_escapes() {
        let (html, text) = render("<script>alert(1)</script> & [x](javascript:alert(1)) \"q\"");
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("href"), "{html}");
        assert!(html.contains("&lt;script&gt;"));
        assert_eq!(text, "<script>alert(1)</script> & [x](javascript:alert(1)) \"q\"");
    }

    #[test]
    fn links_lists_and_code_blocks() {
        let (html, _) = render("See [the paper](https://arxiv.org/abs/1).\n\n- one\n- two\n  cont.\n\n```\nx := 1\n```");
        assert!(html.contains("<a href=\"https://arxiv.org/abs/1\" rel=\"nofollow noopener noreferrer\">the paper</a>"));
        assert!(html.contains("<ul><li>one</li><li>two cont.</li></ul>"));
        assert!(html.contains("<div class=\"mth-docstring__code\"><code>x := 1</code></div>"));
    }

    #[test]
    fn multibyte_text_at_every_position() {
        let (html, text) = render("𝒜 shatters `A`; ⊤ ≤ ⊤ **α** and *𝒜*");
        assert_eq!(text, "𝒜 shatters A; ⊤ ≤ ⊤ α and 𝒜");
        assert!(html.contains("<strong>α</strong>") && html.contains("<em>𝒜</em>"));
        let (_, text) = render("*𝒜");
        assert_eq!(text, "*𝒜");
    }

    #[test]
    fn unclosed_markers_are_text() {
        let (html, text) = render("a * b ** c ` d [e](f");
        assert_eq!(text, "a * b ** c ` d [e](f");
        assert!(!html.contains("<em>") && !html.contains("<strong>") && !html.contains("<code>"));
    }
}
