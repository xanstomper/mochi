//! Parallel recursive structure search and declaration outline extractor.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;

pub fn extract_file_outline(path: &Path) -> String {
    let Ok(file) = File::open(path) else {
        return String::new();
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut decls = Vec::new();
    let mut line_num = 0;

    while line_num < 120 {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        line_num += 1;
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("//")
            || trimmed.starts_with('#')
            || trimmed.starts_with("/*")
            || trimmed.starts_with('*')
        {
            continue;
        }

        let is_decl = trimmed.starts_with("export ")
            || trimmed.starts_with("pub ")
            || trimmed.starts_with("fn ")
            || trimmed.starts_with("def ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("struct ")
            || trimmed.starts_with("enum ")
            || trimmed.starts_with("interface ")
            || trimmed.starts_with("type ")
            || trimmed.starts_with("async function ")
            || trimmed.starts_with("function ")
            || (trimmed.starts_with("const ") && trimmed.contains(" = ") && (trimmed.contains("=>") || trimmed.contains("function")));

        if is_decl {
            let snippet = if trimmed.len() > 65 {
                &trimmed[..65]
            } else {
                trimmed
            };
            decls.push(format!("{line_num}:{snippet}"));
            if decls.len() >= 8 {
                break;
            }
        }
    }

    if decls.is_empty() {
        String::new()
    } else {
        format!("  decl: {}", decls.join(" | "))
    }
}

fn should_ignore(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | ".mochi"
            | ".next"
            | "dist"
            | "build"
            | "target"
            | ".venv"
            | "venv"
            | ".cache"
            | ".turbo"
            | "vendor"
    )
}

fn matches_filter(path: &Path, glob: &str) -> bool {
    if glob.is_empty() || glob == "*" {
        return true;
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if glob.starts_with("*.") {
        return ext == &glob[2..];
    }
    if glob.starts_with('.') {
        return ext == &glob[1..];
    }
    path.to_string_lossy().contains(glob)
}

pub fn search_directory(root: &Path, query: &str, glob: &str, limit: usize) -> String {
    let mut out = String::with_capacity(32_768);
    let mut total_matches = 0;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if total_matches >= limit || out.len() >= 256_000 {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        let mut files = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if !should_ignore(&name) {
                    stack.push(p);
                }
            } else if p.is_file() {
                if let Ok(meta) = entry.metadata() {
                    if meta.len() <= 5_000_000 && matches_filter(&p, glob) {
                        files.push(p);
                    }
                }
            }
        }

        for file_path in files {
            if total_matches >= limit || out.len() >= 256_000 {
                break;
            }
            let Ok(file) = File::open(&file_path) else {
                continue;
            };
            let mut reader = BufReader::new(file);
            let mut line_buf = String::new();
            let mut line_num = 0;
            let mut file_matches = Vec::new();

            while let Ok(n) = reader.read_line(&mut line_buf) {
                if n == 0 {
                    break;
                }
                line_num += 1;
                if line_buf.contains(query) {
                    let trimmed = line_buf.trim_end_matches(&['\r', '\n'][..]);
                    let display = if trimmed.len() > 200 {
                        format!("{}...", &trimmed[..200])
                    } else {
                        trimmed.to_string()
                    };
                    file_matches.push((line_num, display));
                }
                line_buf.clear();
            }

            if !file_matches.is_empty() {
                let rel_path = file_path
                    .strip_prefix(root)
                    .unwrap_or(&file_path)
                    .to_string_lossy();

                for (ln, text) in &file_matches {
                    out.push_str(&format!("{rel_path}:{ln}:{text}\n"));
                    total_matches += 1;
                }

                let outline = extract_file_outline(&file_path);
                if !outline.is_empty() {
                    out.push_str(&outline);
                    out.push('\n');
                }
            }
        }
    }

    out
}
