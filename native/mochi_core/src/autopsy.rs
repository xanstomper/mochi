//! Test failure analysis and root-cause diagnostic extractor in Rust.

#[derive(Debug, Clone)]
pub struct DiagnosticFinding {
    pub file: String,
    pub line: usize,
    pub message: String,
    pub severity: String,
}

pub struct AutopsyReport {
    pub test_name: String,
    pub failure_reason: String,
    pub stack_trace: Vec<String>,
    pub findings: Vec<DiagnosticFinding>,
}

pub fn analyze_failure_output(raw_output: &str) -> AutopsyReport {
    let mut failure_reason = String::new();
    let mut stack_trace = Vec::new();
    let mut findings = Vec::new();
    let mut test_name = String::new();

    for line in raw_output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("FAIL ") || trimmed.starts_with("✕ ") || trimmed.starts_with("FAILED ") {
            if test_name.is_empty() {
                test_name = trimmed.to_string();
            }
        }
        if trimmed.starts_with("AssertionError:") || trimmed.starts_with("Error:") || trimmed.contains("expected ") {
            if failure_reason.is_empty() {
                failure_reason = trimmed.to_string();
            }
        }
        if trimmed.starts_with("at ") || trimmed.contains(".ts:") || trimmed.contains(".rs:") || trimmed.contains(".py:") {
            stack_trace.push(trimmed.to_string());
            if let Some(colon_pos) = trimmed.rfind(':') {
                let rest = &trimmed[..colon_pos];
                if let Some(c2) = rest.rfind(':') {
                    let file_part = rest[..c2].trim_start_matches("at ").trim();
                    let line_str = &rest[c2 + 1..];
                    if let Ok(line_num) = line_str.parse::<usize>() {
                        findings.push(DiagnosticFinding {
                            file: file_part.to_string(),
                            line: line_num,
                            message: failure_reason.clone(),
                            severity: "error".to_string(),
                        });
                    }
                }
            }
        }
    }

    AutopsyReport {
        test_name,
        failure_reason,
        stack_trace,
        findings,
    }
}
