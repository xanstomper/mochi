//! Fast unified diff line counter, patch validation, and Myers diff engine in Rust.

pub struct DiffStats {
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
}

pub fn parse_diff_numstat(output: &str) -> DiffStats {
    let mut stats = DiffStats {
        files: 0,
        additions: 0,
        deletions: 0,
    };

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 3 {
            stats.files += 1;
            if let Ok(add) = parts[0].parse::<usize>() {
                stats.additions += add;
            }
            if let Ok(del) = parts[1].parse::<usize>() {
                stats.deletions += del;
            }
        }
    }

    stats
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum DiffOp<'a> {
    Equal(&'a str),
    Insert(&'a str),
    Delete(&'a str),
}

/// Compute line-level Myers diff between old_text and new_text.
pub fn compute_line_diff<'a>(old_text: &'a str, new_text: &'a str) -> Vec<DiffOp<'a>> {
    let old_lines: Vec<&'a str> = old_text.lines().collect();
    let new_lines: Vec<&'a str> = new_text.lines().collect();

    let n = old_lines.len();
    let m = new_lines.len();

    // Fast-path: identical texts
    if old_text == new_text {
        return old_lines.into_iter().map(DiffOp::Equal).collect();
    }
    // Fast-path: empty old
    if n == 0 {
        return new_lines.into_iter().map(DiffOp::Insert).collect();
    }
    // Fast-path: empty new
    if m == 0 {
        return old_lines.into_iter().map(DiffOp::Delete).collect();
    }

    // Standard dynamic programming LCS table
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in 0..n {
        for j in 0..m {
            if old_lines[i] == new_lines[j] {
                dp[i + 1][j + 1] = dp[i][j] + 1;
            } else {
                dp[i + 1][j + 1] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }

    // Backtrack to assemble diff ops
    let mut ops = Vec::new();
    let mut i = n;
    let mut j = m;

    while i > 0 || j > 0 {
        if i > 0 && j > 0 && old_lines[i - 1] == new_lines[j - 1] {
            ops.push(DiffOp::Equal(old_lines[i - 1]));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            ops.push(DiffOp::Insert(new_lines[j - 1]));
            j -= 1;
        } else if i > 0 {
            ops.push(DiffOp::Delete(old_lines[i - 1]));
            i -= 1;
        }
    }

    ops.reverse();
    ops
}

/// Formats a full unified diff string with file headers and chunk boundaries.
pub fn generate_unified_diff(old_text: &str, new_text: &str, old_file: &str, new_file: &str) -> String {
    if old_text == new_text {
        return String::new();
    }

    let ops = compute_line_diff(old_text, new_text);
    let mut out = format!("--- {}\n+++ {}\n", old_file, new_file);

    let mut chunk = String::new();
    let chunk_old_start = 1;
    let chunk_new_start = 1;
    let mut chunk_old_count = 0;
    let mut chunk_new_count = 0;
    let mut has_changes = false;

    for op in &ops {
        match op {
            DiffOp::Equal(line) => {
                chunk.push(' ');
                chunk.push_str(line);
                chunk.push('\n');
                chunk_old_count += 1;
                chunk_new_count += 1;
            }
            DiffOp::Delete(line) => {
                has_changes = true;
                chunk.push('-');
                chunk.push_str(line);
                chunk.push('\n');
                chunk_old_count += 1;
            }
            DiffOp::Insert(line) => {
                has_changes = true;
                chunk.push('+');
                chunk.push_str(line);
                chunk.push('\n');
                chunk_new_count += 1;
            }
        }
    }

    if has_changes {
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            chunk_old_start, chunk_old_count, chunk_new_start, chunk_new_count
        ));
        out.push_str(&chunk);
        out
    } else {
        String::new()
    }
}
