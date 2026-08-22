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
