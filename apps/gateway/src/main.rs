// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseCitySOS public gateway in Rust.
//!
//! Owns the emergency-operations edge: it rejects every City or unknown `/v1`
//! namespace before any upstream call, proxies owned SOS API traffic, streams
//! SSE responses, and serves the console SPA for non-API paths.

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::header::HeaderValue;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use regex::Regex;
use serde_json::json;
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;

const BOUNDARY_PRODUCT: &str = "synapsecity-sos";
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

const OWNED_V1_PREFIXES: &[&str] = &[
    "/v1/sos",
    "/v1/auth",
    "/v1/emergency",
    "/v1/hazards",
    "/v1/geo",
    "/v1/map",
    "/v1/ai",
];

const FOREIGN_V1_PREFIXES: &[&str] = &[
    "/v1/assets",
    "/v1/incidents",
    "/v1/maintenance",
    "/v1/iot",
    "/v1/alerts",
    "/v1/budgets",
    "/v1/reports",
    "/v1/notifications",
    "/v1/users",
    "/v1/geofences",
    "/v1/ingest",
    "/v1/city",
    "/v1/public/assets",
    "/v1/public/incidents",
];

const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "accept",
    "if-match",
    "if-none-match",
    "last-event-id",
];

const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "cache-control",
    "etag",
    "x-record-version",
    "x-sos-scan-truncated",
    "location",
    "retry-after",
];

#[derive(Clone)]
pub struct AppState {
    pub upstream: String,
    pub console: String,
    pub cors_origin: String,
    pub timeout: Duration,
    pub console_timeout: Duration,
    pub client: reqwest::Client,
    pub metrics: Arc<Mutex<BTreeMap<String, GatewayMetric>>>,
    pub id_regex: Arc<Regex>,
    pub correlation_regex: Arc<Regex>,
}

#[derive(Clone, Debug, Default)]
pub struct GatewayMetric {
    pub count: u64,
    pub errors: u64,
    pub total_ms: f64,
    pub max_ms: f64,
}

#[derive(Clone, Debug)]
pub struct CorrelationId(pub String);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum V1Boundary {
    Owned,
    Foreign,
    Unknown,
}

fn has_valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

fn decoded_path(value: &str) -> Option<String> {
    let mut current = value.to_string();
    for _ in 0..3 {
        if !has_valid_percent_encoding(&current) {
            return None;
        }
        let decoded = match percent_encoding::percent_decode_str(&current).decode_utf8() {
            Ok(cow) => cow.into_owned(),
            Err(_) => return None,
        };
        if decoded == current {
            return Some(current);
        }
        current = decoded;
    }
    Some(current)
}

/// Decode, resolve dot segments, collapse duplicate separators, lowercase and
/// strip trailing slashes before classifying a `/v1` path.
pub fn normalize_v1_path(raw: &str) -> String {
    let without_query = raw
        .split('?')
        .next()
        .unwrap_or("/")
        .split('#')
        .next()
        .unwrap_or("/");
    let decoded = match decoded_path(without_query) {
        Some(value) => value,
        None => return "/__invalid_path__".to_string(),
    };
    let mut segments = Vec::new();
    for segment in decoded.replace('\\', "/").split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            segments.pop();
            continue;
        }
        segments.push(segment.to_ascii_lowercase());
    }
    format!("/{}", segments.join("/"))
}

/// Decode the `/v1` prefix and resolve dot segments while preserving path case
/// and the original query string.
pub fn canonical_api_url(raw: &str) -> Option<String> {
    let (raw_path, query) = match raw.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (raw, None),
    };
    let decoded = decoded_path(if raw_path.is_empty() { "/" } else { raw_path })?;
    let sanitized = decoded.replace('\\', "/");
    let mut segments = Vec::new();
    for segment in sanitized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    let path = format!("/{}", segments.join("/"));
    Some(match query {
        Some(query) => format!("{path}?{query}"),
        None => path,
    })
}

fn within(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

pub fn classify_v1_path(raw: &str) -> V1Boundary {
    let path = normalize_v1_path(raw);
    if OWNED_V1_PREFIXES.iter().any(|prefix| within(&path, prefix)) {
        return V1Boundary::Owned;
    }
    if FOREIGN_V1_PREFIXES
        .iter()
        .any(|prefix| within(&path, prefix))
    {
        return V1Boundary::Foreign;
    }
    V1Boundary::Unknown
}

fn assert_upstream(value: &str, var_name: &str) -> Result<String, String> {
    let url = Url::parse(value)
        .map_err(|e| format!("{var_name} is not an absolute URL: {value} ({e})"))?;
    let host = url.host_str().unwrap_or("");
    if host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" {
        return Err(format!("{var_name} may not point to localhost"));
    }
    Ok(value.trim_end_matches('/').to_string())
}

fn not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        [("content-type", "application/json")],
        json!({
            "error": "not_found",
            "product": BOUNDARY_PRODUCT
        })
        .to_string(),
    )
        .into_response()
}

fn cors_headers(origin: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert("access-control-allow-origin", value);
    }
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static(
            "authorization,content-type,x-api-key,x-correlation-id,if-match,if-none-match,last-event-id",
        ),
    );
    headers.insert(
        "access-control-expose-headers",
        HeaderValue::from_static(
            "etag,x-record-version,x-sos-scan-truncated,location,retry-after,x-correlation-id",
        ),
    );
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "strict-transport-security",
        HeaderValue::from_static("max-age=31536000; includeSubDomains"),
    );
    headers
}

pub fn create_app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/ready", get(ready_handler))
        .route("/metrics", get(metrics_handler))
        .fallback(gateway_dispatcher)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            request_context,
        ))
        .with_state(state)
}

async fn request_context(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let incoming = req
        .headers()
        .get("x-correlation-id")
        .and_then(|value| value.to_str().ok());
    let correlation_id = match incoming {
        Some(value) if state.correlation_regex.is_match(value) => value.to_string(),
        _ => Uuid::new_v4().to_string(),
    };
    req.extensions_mut()
        .insert(CorrelationId(correlation_id.clone()));

    if req.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        for (name, value) in cors_headers(&state.cors_origin) {
            if let Some(name) = name {
                response.headers_mut().insert(name, value);
            }
        }
        if let Ok(value) = HeaderValue::from_str(&correlation_id) {
            response.headers_mut().insert("x-correlation-id", value);
        }
        return response;
    }

    let method = req.method().as_str().to_string();
    let label = route_label(&state, req.uri().path());
    let started = Instant::now();
    let mut response = next.run(req).await;
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let status = response.status();
    record_metric(&state, &label, elapsed, status.as_u16());

    for (name, value) in cors_headers(&state.cors_origin) {
        if let Some(name) = name {
            response.headers_mut().insert(name, value);
        }
    }
    if let Ok(value) = HeaderValue::from_str(&correlation_id) {
        response.headers_mut().insert("x-correlation-id", value);
    }
    tracing::info!(
        service = "synapsecity-sos-gateway",
        method = %method,
        path = %label,
        status = status.as_u16(),
        duration_ms = elapsed,
        correlation_id = %correlation_id,
        "request"
    );
    response
}

fn route_label(state: &AppState, raw_path: &str) -> String {
    let path = state.id_regex.replace_all(raw_path, "/{id}").to_string();
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() > 4 {
        format!("{}/*", segments[..4].join("/"))
    } else {
        path
    }
}

fn sanitize_metric_label(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '{' | '}' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn record_metric(state: &AppState, route: &str, duration_ms: f64, status: u16) {
    let key = sanitize_metric_label(route);
    let mut metrics = state.metrics.lock().unwrap_or_else(|e| e.into_inner());
    let metric = metrics.entry(key).or_default();
    metric.count += 1;
    metric.total_ms += duration_ms;
    metric.max_ms = metric.max_ms.max(duration_ms);
    if status >= 500 {
        metric.errors += 1;
    }
}

async fn metrics_handler(State(state): State<AppState>) -> Response {
    let metrics = state.metrics.lock().unwrap_or_else(|e| e.into_inner());
    let mut lines = vec![
        "# HELP sos_gateway_request_total Total gateway requests.".to_string(),
        "# TYPE sos_gateway_request_total counter".to_string(),
        "# HELP sos_gateway_request_errors_total Total gateway 5xx responses.".to_string(),
        "# TYPE sos_gateway_request_errors_total counter".to_string(),
        "# HELP sos_gateway_request_duration_ms_sum Cumulative gateway request duration."
            .to_string(),
        "# TYPE sos_gateway_request_duration_ms_sum counter".to_string(),
    ];
    for (route, metric) in metrics.iter() {
        lines.push(format!(
            "sos_gateway_request_total{{route=\"{route}\"}} {}",
            metric.count
        ));
        lines.push(format!(
            "sos_gateway_request_errors_total{{route=\"{route}\"}} {}",
            metric.errors
        ));
        lines.push(format!(
            "sos_gateway_request_duration_ms_sum{{route=\"{route}\"}} {}",
            metric.total_ms.round() as u64
        ));
    }
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        lines.join("\n") + "\n",
    )
        .into_response()
}

async fn upstream_health(state: &AppState, path: &str) -> Response {
    let url = format!("{}{}", state.upstream, path);
    match state.client.get(&url).timeout(state.timeout).send().await {
        Ok(res) => {
            let ok = res.status().is_success();
            let text = res.text().await.unwrap_or_default();
            let upstream: serde_json::Value =
                serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }));
            let body = json!({
                "status": if ok {
                    if path == "/ready" { "ready" } else { "ok" }
                } else {
                    "degraded"
                },
                "service": "synapsecity-sos-gateway",
                "upstream": upstream,
            });
            let code = if ok {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            (
                code,
                [("content-type", "application/json")],
                body.to_string(),
            )
                .into_response()
        }
        Err(error) if error.is_timeout() => (
            StatusCode::GATEWAY_TIMEOUT,
            [("content-type", "application/json")],
            json!({
                "status": "degraded",
                "service": "synapsecity-sos-gateway",
                "error": "upstream_timeout",
            })
            .to_string(),
        )
            .into_response(),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [("content-type", "application/json")],
            json!({
                "status": "degraded",
                "service": "synapsecity-sos-gateway",
                "error": error.to_string(),
            })
            .to_string(),
        )
            .into_response(),
    }
}

async fn health_handler(State(state): State<AppState>) -> Response {
    upstream_health(&state, "/health").await
}

async fn ready_handler(State(state): State<AppState>) -> Response {
    upstream_health(&state, "/ready").await
}

async fn gateway_dispatcher(State(state): State<AppState>, req: Request) -> Response {
    let correlation_id = req
        .extensions()
        .get::<CorrelationId>()
        .map(|value| value.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let raw_uri = req.uri().to_string();
    let normalized = normalize_v1_path(&raw_uri);

    if normalized == "/__invalid_path__" {
        return not_found_response();
    }

    if normalized == "/v1" || normalized.starts_with("/v1/") {
        if classify_v1_path(&raw_uri) != V1Boundary::Owned {
            return not_found_response();
        }
        let target = match canonical_api_url(&raw_uri) {
            Some(target) if target == "/v1" || target.starts_with("/v1/") => target,
            _ => return not_found_response(),
        };
        return proxy_to_sos(state, req, &target, &correlation_id).await;
    }

    if req.method() != Method::GET && req.method() != Method::HEAD {
        return not_found_response();
    }
    if let Some(decoded) = canonical_api_url(&raw_uri) {
        if decoded.eq_ignore_ascii_case("/v1") || decoded.to_ascii_lowercase().starts_with("/v1/") {
            return not_found_response();
        }
    }

    proxy_to_console(state, req, &raw_uri).await
}

async fn proxy_to_sos(
    state: AppState,
    req: Request,
    target: &str,
    correlation_id: &str,
) -> Response {
    let method = req.method().clone();
    let headers = req.headers().clone();
    let content_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let is_body_method = method != Method::GET && method != Method::HEAD;

    let mut upstream = state
        .client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            format!("{}{}", state.upstream, target),
        )
        .timeout(state.timeout);

    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(value) = headers.get(*name) {
            upstream = upstream.header(*name, value);
        }
    }
    upstream = upstream.header("x-correlation-id", correlation_id);

    if is_body_method {
        let body = match axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES).await {
            Ok(body) => body,
            Err(error) => {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    [("content-type", "application/json")],
                    json!({
                        "error": "payload_too_large",
                        "message": error.to_string(),
                    })
                    .to_string(),
                )
                    .into_response();
            }
        };
        let body = if body.is_empty() {
            Bytes::from_static(b"{}")
        } else {
            body
        };
        upstream = upstream.body(body);
        upstream = upstream.header(
            "content-type",
            content_type.unwrap_or_else(|| "application/json".to_string()),
        );
    }

    match upstream.send().await {
        Ok(res) => {
            let status = StatusCode::from_u16(res.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let content_type = res
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_string();

            let mut response_headers = HeaderMap::new();
            if !content_type.is_empty() {
                if let Ok(value) = HeaderValue::from_str(&content_type) {
                    response_headers.insert("content-type", value);
                }
            }
            for name in FORWARDED_RESPONSE_HEADERS {
                if let Some(value) = res.headers().get(*name) {
                    response_headers.insert(*name, value.clone());
                }
            }

            if content_type.contains("text/event-stream") {
                if !response_headers.contains_key("cache-control") {
                    response_headers.insert(
                        "cache-control",
                        HeaderValue::from_static("no-cache, no-transform"),
                    );
                }
                response_headers
                    .insert("connection", HeaderValue::from_static("keep-alive"));
                response_headers
                    .insert("x-accel-buffering", HeaderValue::from_static("no"));
                let body = Body::from_stream(res.bytes_stream());
                let mut response = Response::new(body);
                *response.status_mut() = status;
                *response.headers_mut() = response_headers;
                return response;
            }

            if method == Method::HEAD
                || status == StatusCode::NO_CONTENT
                || status == StatusCode::NOT_MODIFIED
            {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = status;
                *response.headers_mut() = response_headers;
                return response;
            }

            let body = res.bytes().await.unwrap_or_default();
            response_headers.insert("content-length", HeaderValue::from(body.len()));
            let mut response = Response::new(Body::from(body));
            *response.status_mut() = status;
            *response.headers_mut() = response_headers;
            response
        }
        Err(error) if error.is_timeout() => (
            StatusCode::GATEWAY_TIMEOUT,
            [("content-type", "application/json")],
            json!({
                "error": "upstream_timeout",
                "message": format!("sos-service did not respond within {}ms", state.timeout.as_millis()),
            })
            .to_string(),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            [("content-type", "application/json")],
            json!({
                "error": "sos_upstream_unavailable",
                "message": error.to_string(),
            })
            .to_string(),
        )
            .into_response(),
    }
}

async fn proxy_to_console(state: AppState, req: Request, raw_uri: &str) -> Response {
    let method = req.method().clone();
    let accept = req
        .headers()
        .get("accept")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/html")
        .to_string();

    let upstream = state
        .client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            format!("{}{}", state.console, raw_uri),
        )
        .timeout(state.console_timeout)
        .header("accept", accept);

    match upstream.send().await {
        Ok(res) => {
            let status = StatusCode::from_u16(res.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let mut headers = HeaderMap::new();
            if let Some(value) = res.headers().get("content-type") {
                headers.insert("content-type", value.clone());
            }
            if method == Method::HEAD {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = status;
                *response.headers_mut() = headers;
                return response;
            }
            let body = res.bytes().await.unwrap_or_default();
            headers.insert("content-length", HeaderValue::from(body.len()));
            let mut response = Response::new(Body::from(body));
            *response.status_mut() = status;
            *response.headers_mut() = headers;
            response
        }
        Err(error) if error.is_timeout() => (
            StatusCode::GATEWAY_TIMEOUT,
            [("content-type", "application/json")],
            json!({
                "error": "upstream_timeout",
                "message": format!("console did not respond within {}ms", state.console_timeout.as_millis()),
            })
            .to_string(),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            [("content-type", "application/json")],
            json!({
                "error": "sos_upstream_unavailable",
                "message": error.to_string(),
            })
            .to_string(),
        )
            .into_response(),
    }
}

async fn check_health_cli(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    match client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080);

    if std::env::args().any(|arg| arg == "--healthcheck") {
        std::process::exit(if check_health_cli(port).await { 0 } else { 1 });
    }

    let upstream = assert_upstream(
        &std::env::var("SOS_SERVICE_URL").unwrap_or_else(|_| "http://sos-service:8084".into()),
        "SOS_SERVICE_URL",
    )?;
    let console = assert_upstream(
        &std::env::var("CONSOLE_URL").unwrap_or_else(|_| "http://console:80".into()),
        "CONSOLE_URL",
    )?;
    let cors_origin =
        std::env::var("CORS_ORIGIN").unwrap_or_else(|_| "https://sos.synapsecity.sbs".into());
    let timeout = Duration::from_millis(
        std::env::var("GATEWAY_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000),
    );
    let console_timeout = Duration::from_millis(
        std::env::var("GATEWAY_CONSOLE_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(15_000),
    );

    let state = AppState {
        upstream,
        console,
        cors_origin,
        timeout,
        console_timeout,
        client: reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()?,
        metrics: Arc::new(Mutex::new(BTreeMap::new())),
        id_regex: Arc::new(Regex::new(r"(?i)/[0-9a-f]{8,}")?),
        correlation_regex: Arc::new(Regex::new(r"^[A-Za-z0-9_.:-]{1,128}$")?),
    };

    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await?;
    tracing::info!(service = "synapsecity-sos-gateway", port, "listening");
    axum::serve(listener, create_app(state)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::routing::any;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state(upstream: &str, console: &str) -> AppState {
        AppState {
            upstream: upstream.trim_end_matches('/').to_string(),
            console: console.trim_end_matches('/').to_string(),
            cors_origin: "https://sos.synapsecity.sbs".to_string(),
            timeout: Duration::from_millis(500),
            console_timeout: Duration::from_millis(500),
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            metrics: Arc::new(Mutex::new(BTreeMap::new())),
            id_regex: Arc::new(Regex::new(r"(?i)/[0-9a-f]{8,}").unwrap()),
            correlation_regex: Arc::new(Regex::new(r"^[A-Za-z0-9_.:-]{1,128}$").unwrap()),
        }
    }

    async fn spawn(app: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn request(path: &str, method: Method) -> Request {
        Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .unwrap()
    }

    #[test]
    fn normalizes_and_classifies_boundary_paths() {
        assert_eq!(normalize_v1_path("/v1/EMERGENCY/eop/"), "/v1/emergency/eop");
        assert_eq!(
            normalize_v1_path("/v1/hazards/../emergency"),
            "/v1/emergency"
        );
        assert_eq!(normalize_v1_path("/%76%31/emergency"), "/v1/emergency");
        assert_eq!(normalize_v1_path("/%zz"), "/__invalid_path__");

        for owned in [
            "/v1/sos",
            "/v1/auth/login",
            "/v1/emergency/eop",
            "/v1/emergency/sitrep",
            "/v1/hazards/recent",
            "/v1/geo/search-address",
            "/v1/map/config",
            "/v1/ai/chat",
            "/%76%31/emergency",
        ] {
            assert_eq!(classify_v1_path(owned), V1Boundary::Owned, "{owned}");
        }
        for foreign in [
            "/v1/assets",
            "/v1/incidents/1",
            "/v1/public/assets",
            "/v1/city",
            "/%76%31/assets",
        ] {
            assert_eq!(classify_v1_path(foreign), V1Boundary::Foreign, "{foreign}");
        }
        for unknown in ["/v1", "/v1/unknown", "/v1/public/other"] {
            assert_eq!(classify_v1_path(unknown), V1Boundary::Unknown, "{unknown}");
        }
    }

    #[test]
    fn canonicalizes_api_urls() {
        assert_eq!(
            canonical_api_url("/%76%31/emergency").unwrap(),
            "/v1/emergency"
        );
        assert_eq!(
            canonical_api_url("/%76%31/EMERGENCY/eop/?limit=5").unwrap(),
            "/v1/EMERGENCY/eop?limit=5"
        );
        assert_eq!(
            canonical_api_url("/v1/assets/../emergency").unwrap(),
            "/v1/emergency"
        );
        assert_eq!(canonical_api_url("/%zz"), None);
    }

    #[tokio::test]
    async fn foreign_and_unknown_namespaces_are_rejected_without_upstream() {
        let app = create_app(test_state("http://127.0.0.1:9", "http://127.0.0.1:9"));
        for path in [
            "/v1/assets",
            "/v1/ASSETS/asset-1",
            "/v1/%61ssets",
            "/v1/public/incidents",
            "/v1/city",
            "/v1/unknown",
            "/v1",
            "/%76%31/assets",
        ] {
            let response = app
                .clone()
                .oneshot(request(path, Method::GET))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            let body = body_json(response).await;
            assert_eq!(
                body,
                json!({"error": "not_found", "product": "synapsecity-sos"}),
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn proxies_owned_paths_with_canonical_url_and_binary_body() {
        let upstream = spawn(Router::new().fallback(any(|request: Request| async move {
            let path = request.uri().to_string();
            if path.contains("/tiles/") {
                return (
                    StatusCode::OK,
                    [("content-type", "image/png")],
                    vec![0x89, 0x50, 0x4e, 0x47, 0x0a, 0x1a, 0x0a, 0xff, 0x00],
                )
                    .into_response();
            }
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                json!({"upstreamPath": path}).to_string(),
            )
                .into_response()
        })))
        .await;
        let console = spawn(Router::new().fallback(any(|| async {
            (
                StatusCode::OK,
                [("content-type", "text/html")],
                "<html>console</html>",
            )
        })))
        .await;
        let app = create_app(test_state(&upstream, &console));

        let response = app
            .clone()
            .oneshot(request("/%76%31/EMERGENCY/eop/?limit=5", Method::GET))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({"upstreamPath": "/v1/EMERGENCY/eop?limit=5"})
        );

        let response = app
            .clone()
            .oneshot(request("/v1/hazards", Method::GET))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({"upstreamPath": "/v1/hazards"})
        );

        let response = app
            .clone()
            .oneshot(request("/v1/map/tiles/1", Method::GET))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4e, 0x47]);
    }

    #[tokio::test]
    async fn proxies_console_html_and_head() {
        let console = spawn(Router::new().fallback(any(|request: Request| async move {
            if request.uri().path() == "/icons/icon-192x192.png" {
                return (
                    StatusCode::OK,
                    [("content-type", "image/png")],
                    vec![0x89, 0x50, 0x4e, 0x47],
                )
                    .into_response();
            }
            (
                StatusCode::OK,
                [("content-type", "text/html")],
                "<!doctype html><html><body>console</body></html>",
            )
                .into_response()
        })))
        .await;
        let app = create_app(test_state("http://127.0.0.1:9", &console));

        let response = app
            .clone()
            .oneshot(request("/", Method::GET))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("text/html"));
        let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("console"));

        let response = app
            .oneshot(request("/icons/icon-192x192.png", Method::HEAD))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(bytes.is_empty());
    }

    #[tokio::test]
    async fn forwards_sse_streams_without_buffering() {
        let upstream = spawn(Router::new().fallback(any(|| async {
            (
                StatusCode::OK,
                [("content-type", "text/event-stream")],
                "data: hazard\n\ndata: update\n\n",
            )
                .into_response()
        })))
        .await;
        let app = create_app(test_state(&upstream, "http://127.0.0.1:9"));

        let response = app
            .oneshot(request("/v1/emergency/stream/hazards", Method::GET))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("x-accel-buffering")
                .unwrap()
                .to_str()
                .unwrap(),
            "no"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"data: hazard\n\ndata: update\n\n");
    }

    #[tokio::test]
    async fn slow_upstream_returns_504_and_health_degrades() {
        let upstream = spawn(Router::new().fallback(any(|| async {
            tokio::time::sleep(Duration::from_millis(250)).await;
            (StatusCode::OK, "late")
        })))
        .await;
        let mut state = test_state(&upstream, "http://127.0.0.1:9");
        state.timeout = Duration::from_millis(25);
        state.console_timeout = Duration::from_millis(25);
        let app = create_app(state);

        let response = app
            .clone()
            .oneshot(request("/v1/emergency", Method::GET))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(body_json(response).await["error"], "upstream_timeout");

        let response = app.oneshot(request("/health", Method::GET)).await.unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(body_json(response).await["error"], "upstream_timeout");
    }

    #[tokio::test]
    async fn cors_preflight_advertises_put_and_delete() {
        let app = create_app(test_state("http://127.0.0.1:9", "http://127.0.0.1:9"));
        let response = app
            .oneshot(request("/v1/sos", Method::OPTIONS))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let methods = response
            .headers()
            .get("access-control-allow-methods")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(methods.contains("PUT"));
        assert!(methods.contains("DELETE"));
    }

    #[tokio::test]
    async fn metrics_report_request_counts() {
        let upstream = spawn(Router::new().fallback(any(|| async {
            (StatusCode::OK, [("content-type", "application/json")], "{}")
        })))
        .await;
        let app = create_app(test_state(&upstream, "http://127.0.0.1:9"));
        let _ = app
            .clone()
            .oneshot(request("/v1/sos", Method::GET))
            .await
            .unwrap();
        let response = app.oneshot(request("/metrics", Method::GET)).await.unwrap();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("sos_gateway_request_total{route=\"/v1/sos\"} 1"));
    }
}
