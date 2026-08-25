//! Prompt token estimation and 64-bit FNV-1a KV-cache hash signature calculator.

pub fn fnv1a_64_hash(bytes: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut hash = FNV_OFFSET;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

pub fn estimate_tokens_approx(text: &str) -> usize {
    let bytes = text.len();
    if bytes == 0 {
        return 0;
    }
    // Standard approximation: ~4 characters / bytes per token for English & code
    (bytes + 3) / 4
}

/// Zero-regex high-speed ANSI escape code stripper.
pub fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'm' {
                i += 1;
            }
            if i < bytes.len() {
                i += 1; // skip 'm'
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi() {
        assert_eq!(strip_ansi("\x1b[31mHello\x1b[0m World"), "Hello World");
        assert_eq!(strip_ansi("No ANSI"), "No ANSI");
    }

    #[test]
    fn test_estimate_tokens() {
        assert_eq!(estimate_tokens_approx("abcd"), 1);
        assert_eq!(estimate_tokens_approx(""), 0);
    }
}
