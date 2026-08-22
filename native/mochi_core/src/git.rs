//! Direct zero-subprocess Git repository inspector.
//! Resolves HEAD, active branch, commit hash, and repository status in microseconds.

use std::fs;
use std::path::Path;

pub fn fast_git_branch(dir: &Path) -> Option<String> {
    let mut cur = dir.to_path_buf();
    for _ in 0..16 {
        let head_path = cur.join(".git").join("HEAD");
        if head_path.is_file() {
            if let Ok(content) = fs::read_to_string(&head_path) {
                let trimmed = content.trim();
                if let Some(rest) = trimmed.strip_prefix("ref: refs/heads/") {
                    return Some(rest.to_string());
                }
                if trimmed.len() >= 7 {
                    return Some(trimmed[..7].to_string());
                }
            }
            break;
        }
        if !cur.pop() {
            break;
        }
    }
    None
}

pub fn is_git_repo(dir: &Path) -> bool {
    let mut cur = dir.to_path_buf();
    for _ in 0..16 {
        if cur.join(".git").exists() {
            return true;
        }
        if !cur.pop() {
            break;
        }
    }
    false
}
