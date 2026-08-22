//! Zero-allocation reasoning sanitizer and streaming chunk processor.

pub fn strip_think_tags_native(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '<' {
            let mut tag = String::new();
            while let Some(&next_c) = chars.peek() {
                if next_c == '>' {
                    chars.next();
                    break;
                }
                tag.push(next_c);
                chars.next();
                if tag.len() > 12 {
                    break;
                }
            }
            let tag_lower = tag.to_ascii_lowercase();
            if tag_lower == "think" || tag_lower == "thought" {
                let close_tag1 = format!("</{}>", tag_lower);
                let close_tag2 = format!("</{}>", if tag_lower == "think" { "thought" } else { "think" });
                let mut buf = String::new();
                while let Some(inner_c) = chars.next() {
                    buf.push(inner_c);
                    if buf.ends_with(&close_tag1) || buf.ends_with(&close_tag2) {
                        break;
                    }
                }
                continue;
            } else {
                result.push('<');
                result.push_str(&tag);
                result.push('>');
            }
        } else {
            result.push(c);
        }
    }

    result.trim().to_string()
}
