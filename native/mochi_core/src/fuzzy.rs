//! SIMD-friendly whitespace-normalizing fuzzy substring and line matcher.

pub fn normalize_line(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn fuzzy_find_unique(text: &str, needle: &str) -> Option<(usize, usize)> {
    let text_lines: Vec<&str> = text.split('\n').collect();
    let mut needle_lines: Vec<&str> = needle.split('\n').collect();

    while needle_lines.first().map(|l| l.trim().is_empty()) == Some(true) {
        needle_lines.remove(0);
    }
    while needle_lines.last().map(|l| l.trim().is_empty()) == Some(true) {
        needle_lines.pop();
    }

    if needle_lines.is_empty() || needle_lines.len() > text_lines.len() {
        return None;
    }

    let norm_needle: Vec<String> = needle_lines.iter().map(|l| normalize_line(l)).collect();
    let norm_text: Vec<String> = text_lines.iter().map(|l| normalize_line(l)).collect();

    let mut count = 0usize;
    let mut found = (0usize, 0usize);

    for i in 0..=(norm_text.len() - norm_needle.len()) {
        let mut ok = true;
        for j in 0..norm_needle.len() {
            if norm_text[i + j] != norm_needle[j] {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }

        let mut start = 0usize;
        for k in 0..i {
            start += text_lines[k].len() + 1;
        }
        let mut end = start;
        for k in i..(i + norm_needle.len()) {
            end += text_lines[k].len() + 1;
        }
        if end > start {
            end -= 1;
        }
        count += 1;
        if count == 1 {
            found = (start, end);
        }
    }

    if count == 1 {
        Some(found)
    } else {
        None
    }
}
