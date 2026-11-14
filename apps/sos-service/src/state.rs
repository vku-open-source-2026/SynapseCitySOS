// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Shared process state, RED metrics and in-process rate limiting.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use serde_json::Value;
use synapsedx::Client;

use crate::config::Config;

pub struct Metrics {
    started: Instant,
    requests: AtomicU64,
    errors: AtomicU64,
    routes: Mutex<HashMap<String, RouteMetric>>,
    counters: Mutex<HashMap<String, u64>>,
    dependencies: Mutex<Vec<DependencySample>>,
}

#[derive(Clone, Debug, Default)]
struct RouteMetric {
    count: u64,
    errors: u64,
    total_ms: f64,
    max_ms: f64,
}

#[derive(Clone, Debug)]
struct DependencySample {
    ok: bool,
    duration_ms: u64,
    error: Option<String>,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            requests: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            routes: Mutex::new(HashMap::new()),
            counters: Mutex::new(HashMap::new()),
            dependencies: Mutex::new(Vec::new()),
        }
    }

    pub fn observe(&self, route: &str, duration_ms: f64, status: u16) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        if status >= 500 {
            self.errors.fetch_add(1, Ordering::Relaxed);
        }
        let mut routes = self.routes.lock().unwrap_or_else(|poison| poison.into_inner());
        let metric = routes.entry(route.to_string()).or_default();
        metric.count += 1;
        metric.total_ms += duration_ms;
        metric.max_ms = metric.max_ms.max(duration_ms);
        if status >= 500 {
            metric.errors += 1;
        }
    }

    pub fn increment(&self, name: &str) {
        let mut counters = self.counters.lock().unwrap_or_else(|poison| poison.into_inner());
        *counters.entry(name.to_string()).or_insert(0) += 1;
    }

    pub fn dependency(&self, ok: bool, duration_ms: u64, error: Option<String>) {
        let mut samples = self.dependencies.lock().unwrap_or_else(|poison| poison.into_inner());
        samples.push(DependencySample {
            ok,
            duration_ms,
            error,
        });
        if samples.len() > 200 {
            let excess = samples.len() - 200;
            samples.drain(0..excess);
        }
    }

    pub fn render(&self) -> String {
        let routes = self.routes.lock().unwrap_or_else(|poison| poison.into_inner());
        let counters = self.counters.lock().unwrap_or_else(|poison| poison.into_inner());
        let dependencies = self.dependencies.lock().unwrap_or_else(|poison| poison.into_inner());
        let mut lines = Vec::new();
        lines.push("# HELP sos_request_total Total HTTP requests.".into());
        lines.push("# TYPE sos_request_total counter".into());
        for (route, metric) in routes.iter() {
            let label = sanitize(route);
            lines.push(format!("sos_request_total{{route=\"{label}\"}} {}", metric.count));
            lines.push(format!(
                "sos_request_errors_total{{route=\"{label}\"}} {}",
                metric.errors
            ));
            lines.push(format!(
                "sos_request_duration_ms_sum{{route=\"{label}\"}} {}",
                metric.total_ms.round() as u64
            ));
            lines.push(format!(
                "sos_request_duration_ms_max{{route=\"{label}\"}} {}",
                metric.max_ms.round() as u64
            ));
        }
        let ok = dependencies.iter().filter(|sample| sample.ok).count();
        let failed = dependencies.len() - ok;
        lines.push("# HELP sos_tier2_calls_total Recent Tier-2 dependency calls.".into());
        lines.push("# TYPE sos_tier2_calls_total counter".into());
        lines.push(format!(
            "sos_tier2_calls_total{{dependency=\"synapsedx\",result=\"ok\"}} {ok}"
        ));
        lines.push(format!(
            "sos_tier2_calls_total{{dependency=\"synapsedx\",result=\"error\"}} {failed}"
        ));
        if !dependencies.is_empty() {
            let durations: Vec<u64> = dependencies.iter().map(|sample| sample.duration_ms).collect();
            lines.push("# HELP sos_tier2_duration_ms Recent Tier-2 call latency.".into());
            lines.push("# TYPE sos_tier2_duration_ms gauge".into());
            lines.push(format!(
                "sos_tier2_duration_ms{{dependency=\"synapsedx\",stat=\"last\"}} {}",
                durations[durations.len() - 1]
            ));
            lines.push(format!(
                "sos_tier2_duration_ms{{dependency=\"synapsedx\",stat=\"max\"}} {}",
                durations.iter().max().copied().unwrap_or(0)
            ));
        }
        if !counters.is_empty() {
            lines.push("# HELP sos_events_total Product-level counters.".into());
            lines.push("# TYPE sos_events_total counter".into());
            for (name, value) in counters.iter() {
                lines.push(format!("sos_{}_total {value}", sanitize(name)));
            }
        }
        lines.push("# HELP sos_uptime_seconds Process uptime.".into());
        lines.push("# TYPE sos_uptime_seconds gauge".into());
        lines.push(format!("sos_uptime_seconds {}", self.started.elapsed().as_secs()));
        lines.join("\n") + "\n"
    }
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '/' | '{' | '}' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[derive(Clone)]
struct Bucket {
    hits: Vec<Instant>,
}

pub struct RateLimiter {
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn check(&self, disabled: bool, name: &str, headers: &HeaderMap, window: Duration, max: u32) -> Option<u64> {
        if disabled {
            return None;
        }
        let key = format!("{name}:{}", client_key(headers));
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|poison| poison.into_inner());
        let bucket = buckets.entry(key.clone()).or_insert_with(|| Bucket { hits: Vec::new() });
        bucket.hits.retain(|hit| now.duration_since(*hit) < window);
        if bucket.hits.len() >= max as usize {
            let oldest = bucket.hits.first().copied().unwrap_or(now);
            let retry = window.saturating_sub(now.duration_since(oldest)).as_secs().max(1);
            return Some(retry);
        }
        bucket.hits.push(now);
        if buckets.len() > 10_000 {
            let cutoff = window;
            buckets.retain(|_, value| value.hits.iter().any(|hit| now.duration_since(*hit) < cutoff));
        }
        None
    }
}

pub fn client_key(headers: &HeaderMap) -> String {
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.rsplit(',').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());
    forwarded.unwrap_or_else(|| "unknown".into())
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub tier2: Arc<Client>,
    pub metrics: Arc<Metrics>,
    pub limiter: Arc<RateLimiter>,
    pub ai_status_cache: Arc<Mutex<Option<(Instant, Value)>>>,
    pub hazard_cache: Arc<Mutex<HashMap<i64, (Instant, Vec<Value>)>>>,
    pub hazard_status_cache: Arc<Mutex<Option<(Instant, Value)>>>,
    pub brief_cache: Arc<Mutex<Option<(Instant, String, Value)>>>,
}

impl AppState {
    pub fn new(config: Config, tier2: Client) -> Self {
        Self {
            config: Arc::new(config),
            tier2: Arc::new(tier2),
            metrics: Arc::new(Metrics::new()),
            limiter: Arc::new(RateLimiter::new()),
            ai_status_cache: Arc::new(Mutex::new(None)),
            hazard_cache: Arc::new(Mutex::new(HashMap::new())),
            hazard_status_cache: Arc::new(Mutex::new(None)),
            brief_cache: Arc::new(Mutex::new(None)),
        }
    }
}
