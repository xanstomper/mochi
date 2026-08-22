//! Test Verification & Quality Gatekeeper in Rust.

pub struct VerificationResult {
    pub passed: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
}

pub fn sanitize_verify_command(command: &str) -> String {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Strip accidental Markdown quotes or prefixes
    let clean = trimmed
        .trim_start_matches("```bash")
        .trim_start_matches("```sh")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    clean.to_string()
}
