//! High-performance secret-pattern redaction for tool output, traces, and
//! prompts. Mirrors the patterns in `src/security.ts` so a single byte-level
//! matcher defines what counts as a secret — Rust and TS must agree.
//!
//! This module is intentionally ZERO-DEPENDENCY. The mochi_core crate ships
//! with no `regex` dep (see Cargo.toml); we hand-roll a byte-scanner DFA
//! that's faster than `regex`'s allocation per match anyway, and keeps the
//! 1.4MB static-binary footprint that benchmarks (BENCHMARKS.md) promise.
//!
//! Pattern contract (must match `src/security.ts` SECRET_PATTERNS exactly):
//!   * Each match is replaced byte-for-byte with the literal `[secret-redacted]`.
//!   * Matching is ASCII-only. UTF-8 sequences whose continuation bytes could
//!     plausibly extend a key (none of the patterns include non-ASCII) are
//!     not at risk.
//!   * Patterns are tried in order; after a match, the scanner advances past
//!     it. Overlap is impossible because patterns can't share a prefix that
//!     admits a valid match in two ways.
//!   * Idempotent: redacting a redacted string yields the same string.

const REDACTED: &[u8] = b"[secret-redacted]";

/// Single pattern. Stored as a flat byte vector with the marker positions
/// for each "must have ≥N of class X" check.
struct Pattern {
    /// Bytes that must match exactly at the start of any hit (lowercased for
    /// case-insensitive patterns). Use lowercase.
    prefix: &'static [u8],
    /// If true, the prefix is matched case-insensitively (Bearer/bearer).
    case_insensitive: bool,
    /// After the prefix, accept any byte in `charset` for the next
    /// `min_suffix..=max_suffix` bytes (inclusive).
    charset: &'static [u8],
    min_suffix: usize,
    /// For JWT, require a second `eyJ` after the first dot. We model this as
    /// a "second clause" — after the first suffix run, expect `.`, then a
    /// second suffix run of the same shape, then another `.` + suffix.
    two_clause: bool,
}

const PATTERNS: &[Pattern] = &[
    // sk-... OpenAI-style: prefix "sk-", then 16+ of [A-Za-z0-9_-]
    Pattern { prefix: b"sk-",      case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", min_suffix: 16, two_clause: false },
    // sk-ant-... Anthropic
    Pattern { prefix: b"sk-ant-",  case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", min_suffix: 20, two_clause: false },
    // AIza... Google (note: 30+ of [0-9A-Za-z_-])
    Pattern { prefix: b"AIza",     case_insensitive: false, charset: b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-",  min_suffix: 30, two_clause: false },
    // gh[pousr]_... GitHub (prefixes: ghp, gho, ghu, ghs, ghr)
    Pattern { prefix: b"ghp_",     case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_",  min_suffix: 20, two_clause: false },
    Pattern { prefix: b"gho_",     case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_",  min_suffix: 20, two_clause: false },
    Pattern { prefix: b"ghu_",     case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_",  min_suffix: 20, two_clause: false },
    Pattern { prefix: b"ghs_",     case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_",  min_suffix: 20, two_clause: false },
    Pattern { prefix: b"ghr_",     case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_",  min_suffix: 20, two_clause: false },
    // AKIA + 16 uppercase alnum — AWS
    Pattern { prefix: b"AKIA",     case_insensitive: false, charset: b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",                            min_suffix: 16, two_clause: false },
    // JWT: eyJ + 12+ of [A-Za-z0-9_-] + . + 12+ + . + 12+
    Pattern { prefix: b"eyJ",      case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", min_suffix: 12, two_clause: true  },
    // Bearer (case-insensitive) + space + 20+ of [A-Za-z0-9._~+/=-]
    Pattern { prefix: b"Bearer ",  case_insensitive: true,  charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-", min_suffix: 20, two_clause: false },
    // -----BEGIN ... PRIVATE KEY-----  (must end with exact 5 dashes after "PRIVATE KEY")
    // We treat the entire literal as the match. (Special-cased in the loop.)
    // Slack xox[baprs]- + 10+ alnum/dash
    Pattern { prefix: b"xoxb-",    case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-",  min_suffix: 10, two_clause: false },
    Pattern { prefix: b"xoxa-",    case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-",  min_suffix: 10, two_clause: false },
    Pattern { prefix: b"xoxp-",    case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-",  min_suffix: 10, two_clause: false },
    Pattern { prefix: b"xoxr-",    case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-",  min_suffix: 10, two_clause: false },
    Pattern { prefix: b"xoxs-",    case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-",  min_suffix: 10, two_clause: false },
    // glpat-... GitLab
    Pattern { prefix: b"glpat-",   case_insensitive: false, charset: b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", min_suffix: 20, two_clause: false },
];

/// Match a single pattern starting at `start`. Returns the index one past
/// the end of the match, or None.
#[inline(always)]
fn match_pattern(input: &[u8], start: usize, p: &Pattern) -> Option<usize> {
    let bytes = input;
    let plen = p.prefix.len();
    if start + plen > bytes.len() {
        return None;
    }
    // Prefix check
    if p.case_insensitive {
        for i in 0..plen {
            let a = bytes[start + i];
            let b = p.prefix[i];
            if !a.eq_ignore_ascii_case(&b) {
                return None;
            }
        }
    } else {
        if &bytes[start..start + plen] != p.prefix {
            return None;
        }
    }
    let mut i = start + plen;
    // Suffix run of charset bytes
    let mut run = 0usize;
    while i < bytes.len() && run < 4096 && p.charset.contains(&bytes[i]) {
        i += 1;
        run += 1;
    }
    if run < p.min_suffix {
        return None;
    }
    if !p.two_clause {
        return Some(i);
    }
    // JWT clause 2: '.', 12+ charset, '.', 12+ charset
    if i >= bytes.len() || bytes[i] != b'.' { return None; }
    i += 1;
    let mut run2 = 0usize;
    while i < bytes.len() && run2 < 4096 && p.charset.contains(&bytes[i]) {
        i += 1;
        run2 += 1;
    }
    if run2 < 12 { return None; }
    if i >= bytes.len() || bytes[i] != b'.' { return None; }
    i += 1;
    let mut run3 = 0usize;
    while i < bytes.len() && run3 < 4096 && p.charset.contains(&bytes[i]) {
        i += 1;
        run3 += 1;
    }
    if run3 < 12 { return None; }
    Some(i)
}

/// Locate the literal "-----BEGIN ... PRIVATE KEY-----" (any variant) at `start`.
/// Returns the end index if found. Mirrors the TS regex
/// `/-----BEGIN [A-Z ]*PRIVATE KEY-----/`. The variant part ([A-Z ]*) is
/// matched greedily with single-byte backtracking so patterns like
/// "BEGIN OPENSSH PRIVATE KEY-----" still match.
#[inline]
fn match_private_key(input: &[u8], start: usize) -> Option<usize> {
    const BEGIN: &[u8] = b"-----BEGIN ";
    const KEY_TAIL: &[u8] = b"PRIVATE KEY-----";
    if start + BEGIN.len() + KEY_TAIL.len() > input.len() {
        return None;
    }
    if &input[start..start + BEGIN.len()] != BEGIN {
        return None;
    }
    // After "BEGIN ", scan uppercase letters / spaces; whenever we see 'P' OR
    // we have a non-empty variant, try to match the tail. If not, keep
    // scanning (the TS regex's `[A-Z ]*` is greedy with implicit backtrack).
    let mut i = start + BEGIN.len();
    let variant_end = (i + 32).min(input.len());
    while i < variant_end {
        let b = input[i];
        if b == b'P' && i + KEY_TAIL.len() <= input.len()
            && &input[i..i + KEY_TAIL.len()] == KEY_TAIL
        {
            return Some(i + KEY_TAIL.len());
        }
        if b == b' ' || (b'A'..=b'Z').contains(&b) {
            i += 1;
            continue;
        }
        return None;
    }
    None
}

/// Replace every secret-shaped match in `input` with `[secret-redacted]`.
pub fn redact_secrets(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let mut matched = false;
        // Special-case private key literal first (most specific)
        if let Some(end) = match_private_key(bytes, i) {
            out.extend_from_slice(REDACTED);
            i = end;
            continue;
        }
        for p in PATTERNS {
            if let Some(end) = match_pattern(bytes, i, p) {
                out.extend_from_slice(REDACTED);
                i = end;
                matched = true;
                break;
            }
        }
        if !matched {
            out.push(bytes[i]);
            i += 1;
        }
    }
    // SAFETY: we only ever copied ASCII bytes from the original (which is
    // valid UTF-8) into positions that preserve UTF-8 boundaries, or wrote
    // the ASCII literal REDACTED.
    unsafe { String::from_utf8_unchecked(out) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_redacted(input: &str) {
        let out = redact_secrets(input);
        assert!(out.contains("[secret-redacted]"), "should redact: {:?}", input);
        // No known secret prefix should remain in the output
        for needle in &["sk-", "sk-ant-", "AIza", "ghp_", "gho_", "ghu_", "ghs_", "ghr_",
                        "AKIA", "eyJ", "Bearer ", "xoxb-", "xoxa-", "xoxp-", "xoxr-",
                        "xoxs-", "glpat-", "BEGIN "] {
            assert!(!out.contains(needle), "unredacted needle {:?} in {:?}", needle, out);
        }
    }

    #[test]
    fn redacts_openai() {
        assert_redacted("key=sk-abcdefghijklmnop1234 end");
    }

    #[test]
    fn redacts_anthropic() {
        assert_redacted("sk-ant-abcdefghijklmnop1234");
    }

    #[test]
    fn redacts_github_all_variants() {
        for p in &["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
            let s = format!("{}abcdefghijklmnop1234", p);
            assert_redacted(&s);
        }
    }

    #[test]
    fn redacts_aws() {
        assert_redacted("AKIAIOSFODNN7EXAMPLE");
    }

    #[test]
    fn redacts_jwt_three_part() {
        let s = "eyJabcdefghijkl.eyJabcdefghijkl.signature123abc";
        assert_redacted(s);
    }

    #[test]
    fn does_not_redact_eyJ_without_three_parts() {
        // The two-clause guard: eyJ + 12+ but no second dot-segment → not a JWT.
        let s = "eyJabcdefghijkl";
        assert_eq!(redact_secrets(s), s);
    }

    #[test]
    fn redacts_bearer_case_insensitive() {
        assert_redacted("Authorization: Bearer abcdefghijklmnopqrst1234");
        assert_redacted("authorization: bearer abcdefghijklmnopqrst1234");
        assert_redacted("AUTHORIZATION: BEARER abcdefghijklmnopqrst1234");
    }

    #[test]
    fn redacts_google_aiza() {
        assert_redacted("AIzaSyA-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    }

    #[test]
    fn redacts_rsa_private_key() {
        let s = "-----BEGIN RSA PRIVATE KEY----- data";
        let r = redact_secrets(s);
        assert!(r.starts_with("[secret-redacted]"));
    }

    #[test]
    fn redacts_open_ssh_private_key() {
        let s = "-----BEGIN OPENSSH PRIVATE KEY----- data";
        let r = redact_secrets(s);
        assert!(r.starts_with("[secret-redacted]"));
    }

    #[test]
    fn redacts_slack_all_variants() {
        for p in &["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"] {
            let s = format!("{}1234567890abcdef", p);
            assert_redacted(&s);
        }
    }

    #[test]
    fn redacts_gitlab() {
        assert_redacted("glpat-Abcdefghijklmnopqrstuv");
    }

    #[test]
    fn idempotent() {
        let s = "sk-abcdefghijklmnop1234 other text";
        let once = redact_secrets(s);
        let twice = redact_secrets(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn empty_passthrough() {
        assert_eq!(redact_secrets(""), "");
    }

    #[test]
    fn short_sk_does_not_redact() {
        // OpenAI requires 16+; 5 chars must not match.
        let s = "sk-abc";
        assert_eq!(redact_secrets(s), s);
    }

    #[test]
    fn no_secret_passthrough() {
        let s = "Hello world, this string has no secrets in it at all.";
        assert_eq!(redact_secrets(s), s);
    }

    #[test]
    fn redacts_inside_json_value() {
        let s = r#"{"api_key":"sk-abcdefghijklmnop1234","ok":true}"#;
        let r = redact_secrets(s);
        assert!(r.contains(r#""api_key":"[secret-redacted]""#));
    }

    #[test]
    fn redacts_inside_fenced_code_block() {
        let s = "```js\nconst k='sk-abcdefghijklmnop1234';\n```";
        let r = redact_secrets(s);
        assert!(r.contains("[secret-redacted]"));
    }

    #[test]
    fn multiple_secrets_in_one_string() {
        let s = "sk-abcdefghijklmnop1234 then AKIAIOSFODNN7EXAMPLE then glpat-Abcdefghijklmnopqrstuv";
        let r = redact_secrets(s);
        // Three redactions, all distinct positions
        assert_eq!(r.matches("[secret-redacted]").count(), 3);
    }

    #[test]
    fn utf8_passthrough_safe() {
        // UTF-8 outside any match must be preserved.
        let s = "Hello 🎉 sk-abcdefghijklmnop1234 world ✨";
        let r = redact_secrets(s);
        assert!(r.contains("🎉"));
        assert!(r.contains("✨"));
        assert!(!r.contains("sk-abcdefghijklmnop1234"));
    }
}
