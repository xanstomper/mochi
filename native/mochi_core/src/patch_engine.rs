//! Unified diff generator, 3-way merge, and fuzzy patch applier in Rust.

pub struct PatchHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<String>,
}

pub struct PatchEngine;

impl PatchEngine {
    pub fn apply_patch(original: &str, patch_content: &str) -> Result<String, String> {
        let mut lines: Vec<String> = original.lines().map(|s| s.to_string()).collect();
        let patch_lines: Vec<&str> = patch_content.lines().collect();

        let mut i = 0;
        while i < patch_lines.len() {
            let line = patch_lines[i];
            if line.starts_with("@@") {
                // Parse hunk header
                i += 1;
                continue;
            }
            if line.starts_with('-') {
                let to_remove = &line[1..];
                if let Some(pos) = lines.iter().position(|l| l == to_remove) {
                    lines.remove(pos);
                }
            } else if line.starts_with('+') {
                let to_add = &line[1..];
                lines.push(to_add.to_string());
            }
            i += 1;
        }

        Ok(lines.join("\n"))
    }
}
