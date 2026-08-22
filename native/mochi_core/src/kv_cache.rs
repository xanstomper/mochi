//! KV Cache TTL tracker and prompt cache state analyzer in Rust.

use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CacheState {
    Warm,
    Cooling,
    Cold,
    Unknown,
}

pub struct KvCacheTracker {
    last_hit_at: Option<Instant>,
    last_saved_tokens: u64,
    total_saved_tokens: u64,
    ttl: Duration,
    cooling_threshold: Duration,
}

impl Default for KvCacheTracker {
    fn default() -> Self {
        Self {
            last_hit_at: None,
            last_saved_tokens: 0,
            total_saved_tokens: 0,
            ttl: Duration::from_secs(300),              // 5 minutes
            cooling_threshold: Duration::from_secs(60), // 1 minute remaining
        }
    }
}

impl KvCacheTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_cache_hit(&mut self, saved_tokens: u64) {
        if saved_tokens > 0 {
            self.last_hit_at = Some(Instant::now());
            self.last_saved_tokens = saved_tokens;
            self.total_saved_tokens += saved_tokens;
        }
    }

    pub fn state(&self) -> CacheState {
        let Some(hit_time) = self.last_hit_at else {
            return CacheState::Unknown;
        };
        let elapsed = hit_time.elapsed();
        if elapsed >= self.ttl {
            CacheState::Cold
        } else if self.ttl - elapsed <= self.cooling_threshold {
            CacheState::Cooling
        } else {
            CacheState::Warm
        }
    }

    pub fn remaining_secs(&self) -> i64 {
        let Some(hit_time) = self.last_hit_at else {
            return -1;
        };
        let elapsed = hit_time.elapsed();
        if elapsed >= self.ttl {
            0
        } else {
            (self.ttl - elapsed).as_secs() as i64
        }
    }

    pub fn badge(&self) -> String {
        match self.state() {
            CacheState::Unknown => String::new(),
            CacheState::Cold => "🔴 cold".to_string(),
            CacheState::Cooling => format!("🟡 {}s", self.remaining_secs()),
            CacheState::Warm => format!("🟢 {}s", self.remaining_secs()),
        }
    }
}
