// Mochi native fuzzy line matcher (Rust).
//
// Same contract as TypeScript fuzzyFindUnique in src/tools/fuzzy-match.ts:
// finds the unique region in `text` that matches `needle` after whitespace
// normalization. Multiple matches => ambiguous => NONE, so the agent never
// edits the wrong occurrence.
//
// Wire protocol (stdin lines -> stdout one line):
//   first line:  "NEEDLE"
//   needle lines...
//   a line with exactly "---TEXT---" separates needle from text
//   text lines...
// Output: OK <start> <end>  |  NONE  |  ERR <message>
//
// Build: rustc -O -o bin/fuzzy_rust native/rust/fuzzy.rs
use std::io::{self, Read};

/// Collapse runs of whitespace to a single space (and trim), matching the TS
/// normalizeLine(): `line.trim().replace(/\s+/g, ' ')`.
fn normalize(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn find_unique_range(needle: &[String], text: &[String]) -> Option<(usize, usize)> {
    if needle.is_empty() || needle.len() > text.len() {
        return None;
    }
    let norm_needle: Vec<String> = needle.iter().map(|l| normalize(l)).collect();
    let norm_text: Vec<String> = text.iter().map(|l| normalize(l)).collect();

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
            start += text[k].len() + 1;
        }
        let mut end = start;
        for k in i..(i + norm_needle.len()) {
            end += text[k].len() + 1;
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

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        println!("ERR read-failed");
        return;
    }
    let mut lines: Vec<String> = input.split('\n').map(|s| s.to_string()).collect();
    // Protocol: first line is the marker "NEEDLE" (ignored); then needle,
    // then separator, then text.
    let mut needle: Vec<String> = Vec::new();
    let mut text: Vec<String> = Vec::new();
    let mut in_text = false;
    for line in lines.drain(..) {
        if line.trim() == "---TEXT---" {
            in_text = true;
            continue;
        }
        if in_text {
            text.push(line);
        } else {
            needle.push(line);
        }
    }
    // Drop the leading "NEEDLE" marker line if present.
    if needle.first().map(|l| l.trim()) == Some("NEEDLE") {
        needle.remove(0);
    }
    // Drop empty leading/trailing needle lines, matching the TS impl.
    while needle.first().map(|l| l.trim().is_empty()) == Some(true) {
        needle.remove(0);
    }
    while needle.last().map(|l| l.trim().is_empty()) == Some(true) {
        needle.pop();
    }
    if needle.is_empty() {
        println!("NONE");
        return;
    }
    match find_unique_range(&needle, &text) {
        Some((s, e)) => println!("OK {} {}", s, e),
        None => println!("NONE"),
    }
}