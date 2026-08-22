//! High-performance HTTP client, request signer, rate limiter, and SSE streaming pipeline in Rust.

use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub latency_ms: u128,
}

pub struct RateLimiter {
    pub max_requests_per_minute: u32,
    pub window_start: Instant,
    pub request_count: u32,
    pub backoff_delay_ms: u64,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            max_requests_per_minute: 60,
            window_start: Instant::now(),
            request_count: 0,
            backoff_delay_ms: 500,
        }
    }
}

impl RateLimiter {
    pub fn new(rpm: u32) -> Self {
        Self {
            max_requests_per_minute: rpm,
            ..Default::default()
        }
    }

    pub fn acquire(&mut self) -> Result<Duration, Duration> {
        let now = Instant::now();
        if now.duration_since(self.window_start) >= Duration::from_secs(60) {
            self.window_start = now;
            self.request_count = 0;
        }

        if self.request_count < self.max_requests_per_minute {
            self.request_count += 1;
            Ok(Duration::ZERO)
        } else {
            let wait_time = Duration::from_secs(60).saturating_sub(now.duration_since(self.window_start));
            Err(wait_time)
        }
    }

    pub fn record_retry_after(&mut self, seconds: u64) {
        self.backoff_delay_ms = seconds * 1000;
    }
}
