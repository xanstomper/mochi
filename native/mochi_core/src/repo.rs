//! Repository Indexer & Structure Scanner in Rust.

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct RepoFileInfo {
    pub rel_path: String,
    pub size_bytes: u64,
    pub is_dir: bool,
    pub extension: String,
}

pub struct RepoScanner {
    pub root: PathBuf,
    pub ignore_patterns: Vec<String>,
}

impl RepoScanner {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            ignore_patterns: vec![
                ".git".to_string(),
                "node_modules".to_string(),
                "target".to_string(),
                "dist".to_string(),
                ".mochi".to_string(),
            ],
        }
    }

    pub fn scan(&self) -> Vec<RepoFileInfo> {
        let mut results = Vec::new();
        self.walk(&self.root, &mut results);
        results
    }

    fn walk(&self, dir: &Path, results: &mut Vec<RepoFileInfo>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            if self.ignore_patterns.iter().any(|p| &name == p) {
                continue;
            }

            let rel_path = path
                .strip_prefix(&self.root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            if path.is_dir() {
                results.push(RepoFileInfo {
                    rel_path: rel_path.clone(),
                    size_bytes: 0,
                    is_dir: true,
                    extension: String::new(),
                });
                self.walk(&path, results);
            } else if path.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
                results.push(RepoFileInfo {
                    rel_path,
                    size_bytes: size,
                    is_dir: false,
                    extension: ext,
                });
            }
        }
    }
}
