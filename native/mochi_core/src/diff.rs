//! Fast unified diff line counter and patch validation engine.

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
