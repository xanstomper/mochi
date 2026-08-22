// Mochi native recursive search + structure extractor (Rust).
//
// Finds pattern occurrences in a directory with outline hints,
// outperforming JS walks and avoiding child process spawn overhead when compiled.
//
// Build: rustc -O -o native/bin/search_rust native/rust/search.rs
//
// Usage: ./native/bin/search_rust <dir> <query> [glob_ext]

use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const MAX_TOTAL_OUTPUT: usize = 256_000;
const MAX_TOTAL_MATCHES: usize = 200;
const MAX_FILE_SIZE: u64 = 5_000_000;

fn should_ignore_dir(name: &str) -> bool {
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

fn matches_glob(path: &Path, glob: &str) -> bool {
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

fn extract_outline(path: &Path) -> String {
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
            || trimmed.starts_with("const ") && trimmed.contains(" = ") && (trimmed.contains("=>") || trimmed.contains("function"));

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

fn walk_and_search(
    dir: &Path,
    root: &Path,
    query: &str,
    glob: &str,
    out: &mut String,
    total_matches: &mut usize,
) {
    if *total_matches >= MAX_TOTAL_MATCHES || out.len() >= MAX_TOTAL_OUTPUT {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut files = Vec::new();
    let mut subdirs = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        if path.is_dir() {
            if !should_ignore_dir(&name) {
                subdirs.push(path);
            }
        } else if path.is_file() {
            if let Ok(meta) = entry.metadata() {
                if meta.len() <= MAX_FILE_SIZE && matches_glob(&path, glob) {
                    files.push(path);
                }
            }
        }
    }

    // Process files in current directory
    for file_path in files {
        if *total_matches >= MAX_TOTAL_MATCHES || out.len() >= MAX_TOTAL_OUTPUT {
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
                *total_matches += 1;
            }

            let outline = extract_outline(&file_path);
            if !outline.is_empty() {
                out.push_str(&outline);
                out.push('\n');
            }
        }
    }

    // Recurse into subdirectories
    for subdir in subdirs {
        walk_and_search(&subdir, root, query, glob, out, total_matches);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: search_rust <dir> <query> [glob]");
        return;
    }

    let dir_str = &args[1];
    let query = &args[2];
    let glob = if args.len() > 3 { &args[3] } else { "" };

    let root_path = PathBuf::from(dir_str);
    let mut out = String::with_capacity(32_768);
    let mut total_matches = 0;

    walk_and_search(&root_path, &root_path, query, glob, &mut out, &mut total_matches);

    if out.is_empty() {
        print!("No matches found for \"{query}\"");
    } else {
        print!("{out}");
    }
}
