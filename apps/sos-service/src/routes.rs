// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! HTTP dispatcher for the SOS service.
//!
//! Routes mirror the former Express contract. Persistent data always goes
//! through the Tier-2 `synapsedx` client; domain decisions live in
//! `crate::domain`.

use std::collections::HashMap;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use serde_json::{json, Map, Value};
use synapsedx::RequestOptions;

use crate::ai;
use crate::auth::{self, AuthUser, Claims, SessionExtras};
use crate::config::Config;
use crate::domain;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::tier2::{self, AllRows, DatasetSpec};
use crate::web;

const MAX_BODY: usize = 4 * 1024 * 1024;

struct Ctx<'a> {
    state: &'a AppState,
    headers: &'a HeaderMap,
    uri: &'a Uri,
    query: &'a HashMap<String, String>,
    body: &'a Map<String, Value>,
    session: Option<&'a Claims>,
}

impl<'a> Ctx<'a> {
    fn config(&self) -> &Config {
        &self.state.config
    }

    fn opts(&self) -> RequestOptions {
        tier2::request_options(self.config(), self.headers, self.session)
    }

    fn client(&self) -> &synapsedx::Client {
        &self.state.tier2
    }

    fn actor(&self) -> Option<String> {
        self.session.map(|claims| claims.username.clone())
    }
}

fn to_data(map: &Map<String, Value>) -> Map<String, Value> {
    map.clone()
}

fn from_data(data: Map<String, Value>) -> Value {
    Value::Object(data)
}

fn maps_to_data(items: &[Map<String, Value>]) -> Vec<Map<String, Value>> {
    items.to_vec()
}

fn query_data(query: &HashMap<String, String>) -> Map<String, Value> {
    query
        .iter()
        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
        .collect()
}

fn data_to_values(items: Vec<Map<String, Value>>) -> Vec<Value> {
    items.into_iter().map(Value::Object).collect()
}

async fn list_and_filter(
    ctx: &Ctx<'_>,
    spec: DatasetSpec,
    max: Option<usize>,
) -> ApiResult<(Vec<Map<String, Value>>, bool)> {
    let opts = ctx.opts();
    let AllRows {
        items, truncated, ..
    } = tier2::list_all(
        ctx.client(),
        &opts,
        spec,
        max.unwrap_or(ctx.config().max_scan_records),
    )
    .await?;
    let rows = domain::filters::filter_rows(
        &maps_to_data(&items),
        &query_data(ctx.query),
        chrono::Utc::now().timestamp_millis(),
    );
    Ok((rows, truncated))
}

fn paginate<T>(rows: Vec<T>, query: &HashMap<String, String>, fallback: i64) -> Vec<T> {
    let limit = tier2::limit_of(query, fallback).max(0) as usize;
    let offset = tier2::offset_of(query).max(0) as usize;
    rows.into_iter().skip(offset).take(limit).collect()
}

fn json_array(values: Vec<Value>) -> Response {
    web::json_response(Value::Array(values))
}

fn zero_body() -> Map<String, Value> {
    Map::new()
}

pub fn route_label(path: &str) -> String {
    let path = path.split('?').next().unwrap_or("/");
    let mut segments: Vec<&str> = path.split('/').filter(|value| !value.is_empty()).collect();
    if segments.len() > 4 {
        segments.truncate(4);
        return format!("/{}{}/*", segments.join("/"), "");
    }
    format!("/{}", segments.join("/"))
}

fn method_name(method: &axum::http::Method) -> &'static str {
    match *method {
        axum::http::Method::GET => "GET",
        axum::http::Method::POST => "POST",
        axum::http::Method::PUT => "PUT",
        axum::http::Method::PATCH => "PATCH",
        axum::http::Method::DELETE => "DELETE",
        axum::http::Method::HEAD => "HEAD",
        _ => "OTHER",
    }
}

fn is_foreign(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    let prefixes = [
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
    prefixes
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

fn is_public(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    path == "/v1/sos"
        || path.starts_with("/v1/geo")
        || path.starts_with("/v1/map")
        || path.starts_with("/v1/ai")
        || path == "/v1/emergency/public"
        || path.starts_with("/v1/emergency/public/")
        || path == "/v1/emergency/stream/hazards"
        || path == "/v1/emergency/resources/shelters/near"
        || path == "/v1/hazards"
        || path == "/v1/hazards/recent"
        || path == "/v1/hazards/vndms-live"
        || path == "/v1/hazards/ingest/status"
        || path.starts_with("/v1/hazards/geo")
}

fn required_permission(path: &str, method: &str) -> Option<&'static str> {
    if method == "GET" || method == "HEAD" {
        return Some("emergency:read");
    }
    let path = path.to_ascii_lowercase();
    if path.starts_with("/v1/hazards") {
        return Some("emergency:dispatch");
    }
    if path.starts_with("/v1/emergency/eop") {
        if path.ends_with("/approve") || path.ends_with("/publish") || path.ends_with("/submit") {
            return Some("emergency:eop");
        }
        return Some("emergency:write");
    }
    if path.starts_with("/v1/emergency/dispatch") || path.starts_with("/v1/emergency/resources") {
        return Some("emergency:dispatch");
    }
    if path.starts_with("/v1/emergency/sitrep") {
        return Some(if path.ends_with("/publish") {
            "emergency:dispatch"
        } else {
            "emergency:write"
        });
    }
    if path.starts_with("/v1/emergency/after-action") {
        return Some(if path.ends_with("/publish") {
            "emergency:eop"
        } else {
            "emergency:write"
        });
    }
    if path.ends_with("/resolve") {
        return Some("emergency:dispatch");
    }
    if path.starts_with("/v1/emergency") {
        return Some("emergency:write");
    }
    Some("emergency:admin")
}

fn rate_limit(state: &AppState, name: &str, headers: &HeaderMap, max: u32) -> Result<(), ApiError> {
    if let Some(retry) = state.limiter.check(
        state.config.rate_limit_disabled,
        name,
        headers,
        Duration::from_secs(60),
        max,
    ) {
        let mut error = ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many requests; retry later.",
        );
        error.details =
            Some(json!({ "retry_after_seconds": retry, "limit": max, "window_seconds": 60 }));
        return Err(error);
    }
    Ok(())
}

pub async fn dispatch(State(state): State<AppState>, req: Request) -> ApiResult<Response> {
    let method = method_name(req.method());
    let headers = req.headers().clone();
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    let query = web::query_map(&uri);

    if is_foreign(&path) {
        return Ok(web::status_json(
            StatusCode::NOT_FOUND,
            json!({ "error": "not_found", "product": "synapsecity-sos" }),
        ));
    }

    if path.starts_with("/v1/emergency/stream") {
        rate_limit(&state, "stream", &headers, state.config.stream_rate_max)?;
    } else if path.starts_with("/v1/geo") {
        rate_limit(&state, "geo", &headers, state.config.geo_rate_max)?;
    } else if path.starts_with("/v1/ai") {
        rate_limit(&state, "ai", &headers, state.config.ai_rate_max)?;
    } else if path.starts_with("/v1/auth") {
        rate_limit(&state, "auth", &headers, state.config.auth_rate_max)?;
    } else if is_public(&path) {
        rate_limit(&state, "public", &headers, state.config.public_rate_max)?;
    }

    let body = if matches!(method, "POST" | "PUT" | "PATCH") {
        let (body, _, _) = web::json_body(req, MAX_BODY).await?;
        body
    } else {
        zero_body()
    };

    let mut session = auth::session_from_headers(&state.config, &headers);
    if session.is_none() && path == "/v1/hazards/ingest" {
        session = auth::service_principal_from_headers(&state.config, &headers);
    }
    if path.starts_with("/v1")
        && !path.starts_with("/v1/auth")
        && !is_public(&path)
        && session.is_none()
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid SOS session is required.",
        ));
    }
    if path.starts_with("/v1")
        && !path.starts_with("/v1/auth")
        && !is_public(&path)
        && method != "GET"
        && method != "HEAD"
    {
        if let Some(claims) = session.as_ref() {
            if let Some(permission) = required_permission(&path, method) {
                if !auth::has_permission(claims, permission) {
                    return Err(ApiError::forbidden(
                        "forbidden",
                        format!("The session does not grant {permission}."),
                    ));
                }
            }
        }
    }

    let ctx = Ctx {
        state: &state,
        headers: &headers,
        uri: &uri,
        query: &query,
        body: &body,
        session: session.as_ref(),
    };
    let segments: Vec<String> = path
        .trim_matches('/')
        .split('/')
        .filter(|value| !value.is_empty())
        .map(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8_lossy()
                .to_string()
        })
        .collect();
    let keys: Vec<String> = segments
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect();
    let key_refs: Vec<&str> = keys.iter().map(String::as_str).collect();

    match (method, key_refs.as_slice()) {
        ("GET", ["health"]) => health(ctx, false).await,
        ("GET", ["ready"]) => health(ctx, true).await,
        ("GET", ["metrics"]) => Ok(web::text_response(
            "text/plain; version=0.0.4",
            state.metrics.render(),
        )),
        ("GET", ["v1", "sos"]) => Ok(web::json_response(sos_metadata(&ctx))),
        // The only supported session endpoint: a verified Tier-2 bearer is
        // exchanged for a short-lived SOS session. Password login/registration
        // stay retired in the DX workspace.
        ("POST", ["v1", "auth", "exchange"]) => auth_exchange(ctx).await,
        // Every legacy auth path is retired, including read/session paths that
        // used to answer 401/404. Clients must use the DX workspace login.
        (_, ["v1", "auth", ..]) => Ok(workspace_moved()),
        ("POST", ["v1", "auth", "login"]) | ("POST", ["v1", "auth", "register"]) => {
            Ok(workspace_moved())
        }
        (_, ["v1", "auth", "refresh"]) => Ok(workspace_moved()),
        ("POST", ["v1", "auth", "logout"]) => auth_logout(ctx).await,
        ("POST", ["v1", "auth", "change-password"]) => auth_change_password(ctx).await,
        ("GET", ["v1", "auth", "me"]) => auth_me(ctx),
        ("GET", ["v1", "auth", "verify"]) => auth_verify(ctx),
        (_, ["v1", "auth", "login"]) | (_, ["v1", "auth", "register"]) => Ok(workspace_moved()),
        ("GET", ["v1", "emergency", "public", "status"]) => public_status(ctx).await,
        ("GET", ["v1", "emergency", "public"]) => public_events(ctx).await,
        ("GET", ["v1", "emergency", "health"]) => emergency_health(ctx).await,
        ("GET", ["v1", "emergency", "sosconn", "status"]) => sosconn_status(ctx).await,
        ("GET", ["v1", "emergency", "sos", "timeline"]) => sos_timeline(ctx).await,
        ("GET", ["v1", "emergency"]) => list_collection(ctx, tier2::EVENTS, Some(100)).await,
        ("POST", ["v1", "emergency"]) => create_event(ctx).await,
        ("GET", ["v1", "emergency", "eop"]) => list_collection(ctx, tier2::EOP, Some(100)).await,
        ("POST", ["v1", "emergency", "eop"]) => eop_create(ctx).await,
        ("POST", ["v1", "emergency", "eop", "generate-draft"]) => eop_generate(ctx).await,
        ("GET", ["v1", "emergency", "eop", id]) => get_record(ctx, tier2::EOP, id).await,
        ("PUT", ["v1", "emergency", "eop", id]) => put_record(ctx, tier2::EOP, id).await,
        ("POST", ["v1", "emergency", "eop", id, "approve"]) => eop_approve(ctx, id).await,
        ("POST", ["v1", "emergency", "eop", id, "publish"]) => eop_publish(ctx, id).await,
        ("POST", ["v1", "emergency", "eop", id, "submit"]) => eop_submit(ctx, id).await,
        ("PATCH", ["v1", "emergency", "eop", id, "markdown"]) => eop_markdown(ctx, id).await,
        ("POST", ["v1", "emergency", "eop", id, "approval"]) => eop_approval(ctx, id).await,
        ("GET", ["v1", "emergency", "dispatch"]) => {
            list_collection(ctx, tier2::DISPATCH, Some(100)).await
        }
        ("POST", ["v1", "emergency", "dispatch"]) => dispatch_create(ctx).await,
        ("POST", ["v1", "emergency", "dispatch", "optimize"]) => dispatch_optimize(ctx).await,
        ("GET", ["v1", "emergency", "dispatch", id]) => get_record(ctx, tier2::DISPATCH, id).await,
        ("PUT", ["v1", "emergency", "dispatch", id]) => put_record(ctx, tier2::DISPATCH, id).await,
        ("POST", ["v1", "emergency", "dispatch", id, "approval"]) => {
            dispatch_approval(ctx, id).await
        }
        ("POST", ["v1", "emergency", "dispatch", id, "approve"])
        | ("POST", ["v1", "emergency", "dispatch", id, "assign"]) => {
            dispatch_approve(ctx, id).await
        }
        ("POST", ["v1", "emergency", "dispatch", id, action]) => {
            dispatch_action(ctx, id, action).await
        }
        ("GET", ["v1", "emergency", "hitl", "approvals"]) => hitl_list(ctx).await,
        ("POST", ["v1", "emergency", "hitl", "approvals", id, "decide"]) => {
            hitl_decide(ctx, id).await
        }
        ("POST", ["v1", "emergency", "hitl", "handoff"]) => hitl_handoff(ctx).await,
        ("GET", ["v1", "emergency", "mutual-aid", "requests"]) => {
            list_collection(ctx, tier2::MUTUAL_AID, Some(100)).await
        }
        ("POST", ["v1", "emergency", "mutual-aid", "requests"]) => mutual_aid_create(ctx).await,
        ("GET", ["v1", "emergency", "mutual-aid", "requests", id]) => {
            get_record(ctx, tier2::MUTUAL_AID, id).await
        }
        ("POST", ["v1", "emergency", "mutual-aid", "requests", id, "accept"]) => {
            mutual_aid_accept(ctx, id).await
        }
        ("POST", ["v1", "emergency", "mutual-aid", "requests", id, "decline"]) => {
            mutual_aid_decline(ctx, id).await
        }
        ("POST", ["v1", "emergency", "mutual-aid", "requests", id, "handoff"]) => {
            mutual_aid_handoff(ctx, id).await
        }
        ("GET", ["v1", "emergency", "public", "mutual-aid", id]) => {
            mutual_aid_public(ctx, id).await
        }
        ("GET", ["v1", "emergency", "resources", "shelters", "near"]) => shelters_near(ctx).await,
        ("GET", ["v1", "emergency", "resources"]) => {
            list_collection(ctx, tier2::RESOURCES, Some(100)).await
        }
        ("POST", ["v1", "emergency", "resources"]) => resource_create(ctx).await,
        ("GET", ["v1", "emergency", "resources", id]) => {
            get_record(ctx, tier2::RESOURCES, id).await
        }
        ("PUT", ["v1", "emergency", "resources", id]) => {
            put_record(ctx, tier2::RESOURCES, id).await
        }
        ("POST", ["v1", "emergency", "resources", id, "status"]) => resource_status(ctx, id).await,
        ("GET", ["v1", "emergency", "sitrep"]) => {
            list_collection(ctx, tier2::SITREP, Some(100)).await
        }
        ("POST", ["v1", "emergency", "sitrep"]) => sitrep_create(ctx).await,
        ("GET", ["v1", "emergency", "sitrep", id]) => get_record(ctx, tier2::SITREP, id).await,
        ("PUT", ["v1", "emergency", "sitrep", id]) => sitrep_update(ctx, id).await,
        ("POST", ["v1", "emergency", "sitrep", id, "delta"]) => sitrep_delta(ctx, id).await,
        ("POST", ["v1", "emergency", "sitrep", id, "publish"]) => sitrep_publish(ctx, id).await,
        ("GET", ["v1", "emergency", "after-action"]) => {
            list_collection(ctx, tier2::AFTER_ACTION, Some(100)).await
        }
        ("POST", ["v1", "emergency", "after-action", "generate"]) => aar_generate(ctx).await,
        ("GET", ["v1", "emergency", "after-action", id]) => {
            get_record(ctx, tier2::AFTER_ACTION, id).await
        }
        ("PUT", ["v1", "emergency", "after-action", id]) => {
            put_record(ctx, tier2::AFTER_ACTION, id).await
        }
        ("POST", ["v1", "emergency", "after-action", id, "publish"]) => aar_publish(ctx, id).await,
        ("POST", ["v1", "emergency", id, "resolve"]) => event_resolve(ctx, id).await,
        ("GET", ["v1", "emergency", id]) => get_record(ctx, tier2::EVENTS, id).await,
        ("PUT", ["v1", "emergency", id]) => put_record(ctx, tier2::EVENTS, id).await,
        ("GET", ["v1", "hazards", "recent"]) => hazards_recent(ctx).await,
        ("GET", ["v1", "hazards", "vndms-live"]) => hazards_vndms_live(ctx).await,
        ("GET", ["v1", "hazards", "ingest", "status"]) => ingest_status(ctx).await,
        ("POST", ["v1", "hazards", "ingest"]) => hazards_ingest(ctx).await,
        ("POST", ["v1", "hazards", "expire-stale"]) => hazards_expire(ctx).await,
        ("GET", ["v1", "hazards", "geo", "near"]) => hazards_near(ctx).await,
        ("POST", ["v1", "hazards", "geo", "in-polygon"]) => hazards_polygon(ctx).await,
        ("GET", ["v1", "hazards"]) => hazards_list(ctx).await,
        ("POST", ["v1", "hazards"]) => hazard_create(ctx).await,
        ("GET", ["v1", "hazards", id]) => get_record(ctx, tier2::HAZARDS, id).await,
        ("PUT", ["v1", "hazards", id]) => put_record(ctx, tier2::HAZARDS, id).await,
        ("POST", ["v1", "hazards", id, "deploy"]) => hazard_deploy(ctx, id).await,
        ("POST", ["v1", "hazards", id, "status"]) => hazard_status(ctx, id).await,
        ("GET", ["v1", "emergency", "stream", "hazards"]) => hazard_stream(ctx).await,
        ("GET", ["v1", "geo", "search-address"]) => geo_search(ctx).await,
        ("POST", ["v1", "geo", "geocode"]) => geo_geocode(ctx).await,
        ("POST", ["v1", "geo", "reverse-geocode"]) => geo_reverse(ctx).await,
        ("GET", ["v1", "map", "config"]) => Ok(web::json_response(json!({
            "provider": "synapsedx", "tileUrl": "/v1/map/tiles/{z}/{x}/{y}.png",
            "attribution": "&copy; VIETMAP", "maxZoom": 20, "maxNativeZoom": 20, "style": "tm"
        }))),
        ("GET", ["v1", "map", "status"]) => Ok(web::json_response(json!({
            "provider": "synapsedx",
            "configured": ctx.config().tier2_api_key.is_some() || ctx.config().tier2_token.is_some(),
            "service": "synapsecity-sos"
        }))),
        ("GET", ["v1", "map", "tiles", z, x, y]) => map_tile(ctx, z, x, y).await,
        ("GET", ["v1", "ai", "status"]) => ai_status(ctx).await,
        ("POST", ["v1", "ai", "chat"]) => ai_chat(ctx).await,
        ("POST", ["v1", "ai", "brief"]) => ai_brief(ctx).await,
        ("POST", ["v1", "ai", "ask"]) => ai_ask(ctx).await,
        _ => Ok(web::status_json(
            StatusCode::NOT_FOUND,
            json!({ "error": "not_found", "product": "synapsecity-sos" }),
        )),
    }
}

// ---------------------------------------------------------------------------
// Metadata and health
// ---------------------------------------------------------------------------

fn sos_metadata(ctx: &Ctx<'_>) -> Value {
    json!({
        "product": "synapsecity-sos",
        "domain": "emergency-operations",
        "publicUrl": "https://sos.synapsecity.sbs",
        "features": [
            "hazards", "mutual aid", "emergency events", "public emergency projection",
            "EOP", "dispatch", "resource units", "SITREP", "AAR", "live hazard stream",
            "command centre", "phase boards", "rescue operations", "public hazard map",
            "map", "geocoding", "ai", "tier-2-spatial", "workspace-login"
        ],
        "notOwned": [
            "city assets", "city incidents", "city users", "IoT", "maintenance",
            "preventive maintenance", "technician portal", "infrastructure alerts",
            "notifications", "budgets", "operational reports", "geofences", "ingest",
            "public asset map", "public incident reporting", "public incident lookup"
        ],
        "datasets": tier2::DATASETS.iter().map(|spec| spec.id).collect::<Vec<_>>(),
        "dependency": {
            "product": "synapsedx",
            "tier": 2,
            "publicUrl": ctx.config().tier2_url,
            "sdk": "synapsedx (Rust)",
        },
        "auth": {
            "mode": "retired",
            "workspace": "https://synapsedx.sbs/workspace",
            "identityProvider": "synapsedx",
        },
    })
}

async fn health(ctx: Ctx<'_>, ready: bool) -> ApiResult<Response> {
    let opts = ctx.opts();
    let dependency = tier2::dependency_health(ctx.client(), &opts).await;
    let reachable = dependency.get("reachable").and_then(Value::as_bool) == Some(true);
    let status_ok = dependency.get("status").and_then(Value::as_str) == Some("ok");
    let ok = reachable && (!ready || status_ok);
    let body = json!({
        "status": if ok { if ready { "ready" } else { "ok" } } else if ready { "degraded" } else { "degraded" },
        "service": "synapsecity-sos",
        "tier": 3,
        "checked_at": dependency.get("checked_at"),
        "dependencies": [dependency],
        "tier2Url": ctx.config().tier2_url,
    });
    Ok(web::status_json(
        if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        body,
    ))
}

async fn emergency_health(ctx: Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let dependency = tier2::dependency_health(ctx.client(), &opts).await;
    Ok(web::json_response(json!({
        "service": "synapsecity-sos",
        "checked_at": dependency.get("checked_at"),
        "dependencies": [dependency],
    })))
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

fn user_from_identity(identity: &auth::VerifiedIdentity, role: &str) -> AuthUser {
    let username = if identity.email.is_empty() {
        identity.user_id.clone()
    } else {
        identity.email.clone()
    };
    let timestamp = crate::now_iso();
    AuthUser {
        id: identity.user_id.clone(),
        username: username.clone(),
        email: if identity.email.is_empty() {
            format!("{username}@sos.synapsecity.sbs")
        } else {
            identity.email.clone()
        },
        full_name: if identity.display_name.is_empty() {
            username
        } else {
            identity.display_name.clone()
        },
        phone: None,
        role: role.to_string(),
        permissions: auth::role_permissions(role),
        status: "active".into(),
        language: "vi".into(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    }
}

fn workspace_moved() -> Response {
    web::status_json(
        StatusCode::GONE,
        json!({
            "error": "workspace_moved",
            "workspace_url": "https://synapsedx.sbs/workspace",
            "detail": "Tier-3 work interfaces moved to the SynapseDX workspace.",
        }),
    )
}

/// Exchange a verified Tier-2 user bearer for an SOS session.
///
/// This is the only supported SOS session issuance path after the local login
/// and registration surfaces were retired. The Tier-2 token is verified with
/// the identity capability (`auth/me`), never trusted from the body, and the
/// SOS role is derived from local policy (bootstrap admin or default role).
async fn auth_exchange(ctx: Ctx<'_>) -> ApiResult<Response> {
    let token = auth::bearer_token(ctx.headers).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "tier2_token_required",
            "Send the verified Tier-2 access token as Authorization: Bearer.",
        )
    })?;
    if auth::verify_token(ctx.config(), &token, "access").is_some() {
        return Err(ApiError::bad_request(
            "tier2_token_required",
            "The exchange endpoint expects a Tier-2 access token, not an SOS session.",
        ));
    }
    let header_key = ctx
        .headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok());
    let opts = tier2::request_options_from(
        ctx.config().tier2_api_key.as_deref(),
        ctx.config().tier2_token.as_deref(),
        header_key,
        Some(&token),
    );
    let me = ctx
        .client()
        .auth()
        .me(&opts)
        .await
        .map_err(auth::identity_error)?;
    let identity = auth::identity_from_me(&me)?;
    let role = auth::role_for_identity(ctx.config(), &identity.email);
    let user = user_from_identity(&identity, &role);
    let issued = auth::issue_session(
        ctx.config(),
        &user,
        SessionExtras {
            auth_source: Some("tier2".into()),
            tier2_token: Some(token),
            tier2_refresh_token: None,
        },
    )?;
    Ok(web::json_response(issued.json()))
}

async fn auth_login(ctx: Ctx<'_>) -> ApiResult<Response> {
    return Ok(workspace_moved());
    #[allow(unreachable_code)]
    let identifier = web::string_value(ctx.body.get("email"))
        .or_else(|| web::string_value(ctx.body.get("username")))
        .unwrap_or_default();
    let password = web::string_value(ctx.body.get("password")).unwrap_or_default();
    if ctx.config().demo_auth_allowed() {
        if identifier.is_empty() || password.is_empty() {
            return Err(ApiError::bad_request(
                "username_required",
                "username and password are required",
            ));
        }
        let role = auth::demo_session_role("login");
        let user = auth::shell_user(
            &identifier,
            web::string_value(ctx.body.get("email")).as_deref(),
            web::string_value(ctx.body.get("full_name")).as_deref(),
            web::string_value(ctx.body.get("phone")).as_deref(),
            &role,
        );
        let session = auth::issue_session(
            ctx.config(),
            &user,
            SessionExtras {
                auth_source: Some("demo".into()),
                ..Default::default()
            },
        )?;
        return Ok(web::json_response(session.json()));
    }
    if identifier.is_empty() {
        return Err(ApiError::bad_request(
            "email_required",
            "email and password are required",
        ));
    }
    if !identifier.contains('@') {
        return Err(ApiError::bad_request(
            "email_required",
            "Tier-2 identity requires an email address.",
        ));
    }
    if password.is_empty() {
        return Err(ApiError::bad_request(
            "password_required",
            "email and password are required",
        ));
    }
    let org_slug = web::string_value(ctx.body.get("org_slug"));
    let opts = ctx.opts();
    let session = ctx
        .client()
        .auth()
        .login(
            &identifier.to_ascii_lowercase(),
            Some(&password),
            org_slug.as_deref(),
            &opts,
        )
        .await
        .map_err(auth::identity_error)?;
    let value = serde_json::to_value(session).unwrap_or(Value::Null);
    let mut identity = auth::identity_from_session(&value)?;
    if identity.email.is_empty() {
        identity.email = identifier.to_ascii_lowercase();
    }
    let role = auth::role_for_identity(ctx.config(), &identity.email);
    let user = user_from_identity(&identity, &role);
    let issued = auth::issue_session(
        ctx.config(),
        &user,
        SessionExtras {
            auth_source: Some("tier2".into()),
            tier2_token: identity.access_token.clone(),
            tier2_refresh_token: identity.refresh_token.clone(),
        },
    )?;
    Ok(web::json_response(issued.json()))
}

async fn auth_register(ctx: Ctx<'_>) -> ApiResult<Response> {
    return Ok(workspace_moved());
    #[allow(unreachable_code)]
    let email = web::string_value(ctx.body.get("email"))
        .or_else(|| web::string_value(ctx.body.get("username")))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let password = web::string_value(ctx.body.get("password")).unwrap_or_default();
    let full_name = web::string_value(ctx.body.get("full_name"))
        .or_else(|| web::string_value(ctx.body.get("display_name")))
        .unwrap_or_default();
    if email.is_empty() {
        return Err(ApiError::bad_request(
            "email_required",
            "email, password and full_name are required",
        ));
    }
    if !email.contains('@') {
        return Err(ApiError::bad_request("email_invalid", "email is not valid"));
    }
    if password.len() < 6 {
        return Err(ApiError::bad_request(
            "password_too_short",
            "password must be at least 6 characters",
        ));
    }
    if full_name.is_empty() {
        return Err(ApiError::bad_request(
            "full_name_required",
            "full_name is required",
        ));
    }
    if ctx.config().demo_auth_allowed() {
        let role = auth::demo_session_role("register");
        let user = auth::shell_user(
            &web::string_value(ctx.body.get("username")).unwrap_or_else(|| email.clone()),
            Some(&email),
            Some(&full_name),
            web::string_value(ctx.body.get("phone")).as_deref(),
            &role,
        );
        let session = auth::issue_session(
            ctx.config(),
            &user,
            SessionExtras {
                auth_source: Some("demo".into()),
                ..Default::default()
            },
        )?;
        return Ok(web::status_json(StatusCode::CREATED, session.json()));
    }
    let org_slug = web::string_value(ctx.body.get("org_slug"));
    let opts = ctx.opts();
    let session = ctx
        .client()
        .auth()
        .register(
            &email,
            &password,
            Some(&full_name),
            org_slug.as_deref(),
            &opts,
        )
        .await
        .map_err(auth::identity_error)?;
    let value = serde_json::to_value(session).unwrap_or(Value::Null);
    let identity = auth::identity_from_session(&value)?;
    let role = if ctx.config().bootstrap_admins.contains(&email) {
        auth::ROLE_ADMIN.to_string()
    } else {
        auth::role_for_identity(ctx.config(), &identity.email)
    };
    let user = user_from_identity(&identity, &role);
    let issued = auth::issue_session(
        ctx.config(),
        &user,
        SessionExtras {
            auth_source: Some("tier2".into()),
            tier2_token: identity.access_token.clone(),
            tier2_refresh_token: identity.refresh_token.clone(),
        },
    )?;
    Ok(web::status_json(StatusCode::CREATED, issued.json()))
}

async fn auth_refresh(ctx: Ctx<'_>) -> ApiResult<Response> {
    let token = web::string_value(ctx.body.get("refresh_token")).unwrap_or_default();
    let claims = auth::verify_token(ctx.config(), &token, "refresh").ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_refresh_token",
            "invalid_refresh_token",
        )
    })?;
    if claims.auth_source.as_deref() == Some("tier2") {
        let refresh = claims.tier2_refresh_token.clone().ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_refresh_token",
                "no Tier-2 refresh token in this session",
            )
        })?;
        let opts = ctx.opts();
        let rotated = ctx
            .client()
            .auth()
            .refresh(&refresh, &opts)
            .await
            .map_err(auth::identity_error)?;
        let value = serde_json::to_value(rotated).unwrap_or(Value::Null);
        let new_access = web::string_value(value.get("accessToken"))
            .or_else(|| web::string_value(value.get("access_token")));
        let new_refresh = web::string_value(value.get("refreshToken"))
            .or_else(|| web::string_value(value.get("refresh_token")));
        let role = auth::role_for_identity(ctx.config(), &claims.email);
        let mut user = auth::user_from_claims(&claims);
        user.role = role.clone();
        user.permissions = auth::role_permissions(&role);
        let issued = auth::issue_session(
            ctx.config(),
            &user,
            SessionExtras {
                auth_source: Some("tier2".into()),
                tier2_token: new_access.or(claims.tier2_token.clone()),
                tier2_refresh_token: new_refresh.or(Some(refresh)),
            },
        )?;
        return Ok(web::json_response(issued.json()));
    }
    if !ctx.config().demo_auth_allowed() {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_refresh_token",
            "invalid_refresh_token",
        ));
    }
    let user = auth::user_from_claims(&claims);
    let issued = auth::issue_session(
        ctx.config(),
        &user,
        SessionExtras {
            auth_source: Some("demo".into()),
            ..Default::default()
        },
    )?;
    Ok(web::json_response(issued.json()))
}

async fn auth_logout(ctx: Ctx<'_>) -> ApiResult<Response> {
    let refresh = web::string_value(ctx.body.get("refresh_token")).unwrap_or_default();
    let claims = auth::verify_token(ctx.config(), &refresh, "refresh");
    let refresh_token = claims
        .and_then(|claims| claims.tier2_refresh_token)
        .or_else(|| {
            ctx.session
                .and_then(|claims| claims.tier2_refresh_token.clone())
        });
    if let Some(token) = refresh_token {
        let opts = ctx.opts();
        let _ = ctx.client().auth().logout(&token, &opts).await;
    }
    Ok(web::no_content())
}

async fn auth_change_password(ctx: Ctx<'_>) -> ApiResult<Response> {
    let session = ctx.session.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid SOS session is required.",
        )
    })?;
    let current = web::string_value(ctx.body.get("current_password")).unwrap_or_default();
    let new_password = web::string_value(ctx.body.get("new_password")).unwrap_or_default();
    if current.is_empty() || new_password.is_empty() {
        return Err(ApiError::bad_request(
            "current_and_new_password_required",
            "current_password and new_password are required",
        ));
    }
    if new_password.len() < 6 {
        return Err(ApiError::bad_request(
            "password_too_short",
            "new_password must be at least 6 characters",
        ));
    }
    if session.auth_source.as_deref() != Some("tier2") || session.tier2_token.is_none() {
        if ctx.config().demo_auth_allowed() {
            return Ok(web::no_content());
        }
        return Err(ApiError::unavailable(
            "identity_not_configured",
            "Password changes require the Tier-2 identity capability.",
        ));
    }
    let opts = ctx.opts();
    ctx.client()
        .auth()
        .change_password(&current, &new_password, &opts)
        .await
        .map_err(auth::identity_error)?;
    Ok(web::no_content())
}

fn auth_me(ctx: Ctx<'_>) -> ApiResult<Response> {
    let session = ctx.session.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid SOS session is required.",
        )
    })?;
    Ok(web::json_response(auth::user_json(
        &auth::user_from_claims(session),
    )))
}

fn auth_verify(ctx: Ctx<'_>) -> ApiResult<Response> {
    let session = ctx.session.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid SOS session is required.",
        )
    })?;
    let expires = chrono::DateTime::<chrono::Utc>::from_timestamp(session.exp, 0)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    Ok(web::json_response(json!({
        "valid": true,
        "user": auth::user_json(&auth::user_from_claims(session)),
        "identity_source": session.auth_source.clone().unwrap_or_else(|| "demo".into()),
        "expires_at": expires,
    })))
}

// ---------------------------------------------------------------------------
// Generic collections and events
// ---------------------------------------------------------------------------

async fn list_collection(
    ctx: Ctx<'_>,
    spec: DatasetSpec,
    fallback: Option<i64>,
) -> ApiResult<Response> {
    let (rows, truncated) = list_and_filter(&ctx, spec, None).await?;
    let fallback = fallback.unwrap_or(100);
    let values = data_to_values(paginate(rows, ctx.query, fallback));
    let mut response = json_array(values);
    if truncated {
        response
            .headers_mut()
            .insert("x-sos-scan-truncated", HeaderValue::from_static("true"));
    }
    Ok(response)
}

async fn get_record(ctx: Ctx<'_>, spec: DatasetSpec, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let row = tier2::get(ctx.client(), &opts, spec, id).await?;
    Ok(web::send_record(row))
}

/// Lifecycle and provenance fields are never writable through a generic PUT.
/// They belong to the transition endpoints, which enforce permissions,
/// approvals, optimistic versions and audit metadata.
const CONTROLLED_FIELDS: &[&str] = &[
    "status",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "record_version",
    "approved_by",
    "approved_at",
    "approved_role",
    "approval_id",
    "approval_roles",
    "published_by",
    "published_at",
    "submitted_by",
    "submitted_at",
    "order_ids",
    "resolution_note",
    "resolution",
    "resolved_by",
    "resolved_at",
    "ended_at",
    "closed_at",
    "completed_at",
    "canceled_at",
    "cancelled_at",
    "rejected_at",
    "expired_at",
    "after_action_report_id",
    "approved",
    "published",
    "assigned_resource_unit_id",
    "assigned_user_id",
    "assigned_at",
    "assigned_by",
    "assignments",
    "linked_event_id",
    "linked_eop_plan_id",
    "emergency_event_id",
    "filled_quantity",
    "history",
];

fn controlled_field(body: &Map<String, Value>) -> Option<&'static str> {
    CONTROLLED_FIELDS
        .iter()
        .copied()
        .find(|field| body.get(*field).is_some())
}

fn immutable_status(spec: DatasetSpec, status: &str) -> bool {
    match spec.id {
        "sos-eop-plans" => matches!(status, "approved" | "published" | "archived" | "rejected"),
        "sos-sitreps" => matches!(status, "published" | "archived"),
        "sos-after-action-reports" => matches!(status, "published" | "archived"),
        "sos-emergency-events" => matches!(status, "resolved" | "canceled" | "archived"),
        "sos-dispatch-orders" => matches!(status, "completed" | "canceled" | "rejected"),
        "sos-hazard-layers" => matches!(status, "expired" | "resolved"),
        "sos-resource-units" => status == "retired",
        "sos-mutual-aid-requests" => matches!(status, "filled" | "declined" | "handed_off"),
        _ => false,
    }
}

async fn put_record(ctx: Ctx<'_>, spec: DatasetSpec, id: &str) -> ApiResult<Response> {
    if let Some(field) = controlled_field(ctx.body) {
        return Err(ApiError::forbidden(
            "controlled_field_forbidden",
            format!("{field} cannot be changed through a generic update."),
        )
        .with_details(json!({ "field": field })));
    }
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, spec, id).await?;
    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
    if immutable_status(spec, status) {
        return Err(ApiError::conflict(
            "record_immutable",
            format!("record {id} is {status} and is immutable"),
        ));
    }
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let row = tier2::update(ctx.client(), &opts, spec, id, ctx.body.clone(), version).await?;
    Ok(web::send_record(row))
}

async fn create_event(ctx: Ctx<'_>) -> ApiResult<Response> {
    let mut input = ctx.body.clone();
    let defaults = [
        ("source", Value::String("manual".into())),
        ("status", Value::String("monitoring".into())),
        ("started_at", Value::String(crate::now_iso())),
        ("affected_asset_ids", json!([])),
        ("estimated_impact", json!({})),
        ("instructions", json!([])),
        ("tags", json!([])),
        ("metadata", json!({})),
    ];
    for (key, value) in defaults {
        input.entry(key.to_string()).or_insert(value);
    }
    input.insert(
        "created_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let opts = ctx.opts();
    let row = tier2::write(ctx.client(), &opts, tier2::EVENTS, input, None).await?;
    Ok(web::created(Value::Object(row)))
}

async fn public_status(ctx: Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let dependency = tier2::dependency_health(ctx.client(), &opts).await;
    let dependency_ready = dependency.get("status").and_then(Value::as_str) == Some("ok")
        && dependency
            .get("reachable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let merged = public_hazards_with_feed(&ctx, 72).await;
    let (records_visible, merge_error) = match merged {
        Ok(items) => (items.len(), None),
        Err(error) => (0usize, Some(error.code.clone())),
    };
    let feed = ctx
        .state
        .hazard_feed_status
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let last_success_ms = feed
        .last_success_at
        .as_deref()
        .and_then(domain::filters::parse_timestamp);
    let feed_age_minutes = last_success_ms
        .map(|stamp| ((now_ms - stamp).max(0) as f64 / 60_000.0).round())
        .unwrap_or(0.0);
    let feed_stale = merge_error.is_some()
        || feed.last_error.is_some()
        || last_success_ms.is_none()
        || feed_age_minutes > ctx.config().hazard_feed_stale_minutes as f64;
    let ingest = compute_ingest_status(&ctx).await;
    let ingest_json = serde_json::to_value(&ingest).unwrap_or(Value::Null);
    let vndms_stale = ingest.stale
        || !ingest.configured
        || matches!(ingest.status.as_str(), "failed" | "error" | "unconfigured");
    let ready = dependency_ready && !feed_stale && !vndms_stale;
    let mut response = web::json_response(json!({
        "status": if ready { "ok" } else { "degraded" },
        "data_available": dependency.get("reachable").and_then(Value::as_bool).unwrap_or(false),
        "checked_at": dependency.get("checked_at"),
        "hazard_feed": {
            "status": if ready { "ready" } else { "degraded" },
            "stale": !ready,
            "records_visible": records_visible,
            "last_success_at": feed.last_success_at,
            "last_fetch_at": feed.last_attempt_at,
            "last_fetch_error": feed.last_error,
            "merge_error": merge_error,
            "age_minutes": feed_age_minutes,
            "stale_after_minutes": ctx.config().hazard_feed_stale_minutes,
            "ingest": ingest_json,
            "ingest_status": ingest.status,
            "ingest_stale": ingest.stale,
            "configured": ingest.configured,
        },
        "dependencies": [dependency],
    }));
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=30"),
    );
    Ok(response)
}

async fn public_events(ctx: Ctx<'_>) -> ApiResult<Response> {
    let cached = {
        let cache = ctx
            .state
            .public_events_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        cache
            .as_ref()
            .filter(|(at, _, _)| at.elapsed() < Duration::from_secs(15))
            .map(|(_, items, truncated)| (items.clone(), *truncated))
    };
    let (rows, truncated) = match cached {
        Some((items, truncated)) => (items, truncated),
        None => {
            let opts = ctx.opts();
            let rows = tier2::list_all_public(
                ctx.client(),
                &opts,
                tier2::EVENTS,
                ctx.config().max_scan_records,
            )
            .await?;
            let mut cache = ctx
                .state
                .public_events_cache
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *cache = Some((
                std::time::Instant::now(),
                rows.items.clone(),
                rows.truncated,
            ));
            (rows.items, rows.truncated)
        }
    };
    let status = ctx.query.get("status").cloned();
    let events: Vec<Value> = rows
        .into_iter()
        .filter(|event| {
            let event_status = event.get("status").and_then(Value::as_str).unwrap_or("");
            !["resolved", "canceled", "archived"].contains(&event_status)
                && status
                    .as_deref()
                    .map(|value| value == event_status)
                    .unwrap_or(true)
        })
        .map(|event| {
            json!({
                "id": event.get("id"),
                "title": event.get("title"),
                "event_type": event.get("event_type"),
                "severity": event.get("severity"),
                "status": event.get("status"),
                "location": event.get("location"),
                "geometry": event.get("geometry"),
                "started_at": event.get("started_at"),
                "created_at": event.get("created_at"),
                "updated_at": event.get("updated_at"),
            })
        })
        .collect();
    let events = paginate(events, ctx.query, 500);
    let mut response = json_array(events);
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=30"),
    );
    if truncated {
        response
            .headers_mut()
            .insert("x-sos-scan-truncated", HeaderValue::from_static("true"));
    }
    Ok(response)
}

async fn sosconn_status(ctx: Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let dependency = tier2::dependency_health(ctx.client(), &opts).await;
    let ai = ai::ai_status(ctx.state, &opts).await;
    let mut response = web::json_response(json!({
        "provider": ai.get("provider"),
        "configured": ai.get("configured"),
        "reachable": dependency.get("reachable"),
        "model": ai.get("model"),
        "status": if dependency.get("reachable").and_then(Value::as_bool) != Some(true) {
            "dependency_unreachable"
        } else if ai.get("status").and_then(Value::as_str) == Some("ok") {
            "ready"
        } else {
            "capability_unavailable"
        },
        "detail": ai.get("detail"),
        "checked_at": ai.get("checked_at"),
        "base_url": ctx.config().tier2_url,
        "dependency": {
            "tier2_reachable": dependency.get("reachable"),
            "status": dependency.get("status"),
        },
    }));
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn sos_timeline(ctx: Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let events = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::EVENTS,
        ctx.config().max_scan_records,
    )
    .await?;
    // A dispatch-dataset failure is an honest error, never a plausible
    // timeline: computing SLA from absent dispatch data would report numbers
    // the fields do not mean. The events scan above fails the same way.
    let dispatch = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::DISPATCH,
        ctx.config().max_scan_records,
    )
    .await?;
    let mut first_assignment: HashMap<String, i64> = HashMap::new();
    for order in &dispatch.items {
        let event_id = order
            .get("emergency_event_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if event_id.is_empty() {
            continue;
        }
        let mut times = Vec::new();
        if let Some(assignments) = order.get("assignments").and_then(Value::as_array) {
            for assignment in assignments {
                if let Some(stamp) = assignment
                    .get("assigned_at")
                    .and_then(Value::as_str)
                    .and_then(domain::filters::parse_timestamp)
                {
                    times.push(stamp);
                }
            }
        }
        for key in ["assigned_at", "started_at"] {
            if let Some(stamp) = order
                .get(key)
                .and_then(Value::as_str)
                .and_then(domain::filters::parse_timestamp)
            {
                times.push(stamp);
            }
        }
        if let Some(earliest) = times.into_iter().min() {
            first_assignment
                .entry(event_id.to_string())
                .and_modify(|current| *current = (*current).min(earliest))
                .or_insert(earliest);
        }
    }
    let limit = tier2::limit_of(ctx.query, 30).max(0) as usize;
    let values: Vec<Value> = events
        .items
        .iter()
        .take(limit)
        .map(|event| {
            let event_data = to_data(event);
            let event_id = event.get("id").and_then(Value::as_str).unwrap_or("");
            let first = first_assignment.get(event_id).copied();
            let severity = event
                .get("severity")
                .and_then(Value::as_str)
                .unwrap_or("medium");
            let sla_minutes = match severity {
                "critical" => 30,
                "high" => 60,
                "medium" => 120,
                _ => 240,
            };
            json!({
                "event_id": event.get("id"),
                "event_code": event.get("event_code"),
                "title": event.get("title"),
                "severity": event.get("severity"),
                "status": event.get("status"),
                "created_at": event.get("created_at"),
                "source_ref": event.get("source"),
                "sla_breach_count": domain::after_action::sla_breach_count(
                    &event_data,
                    first,
                    chrono::Utc::now().timestamp_millis(),
                ),
                "sla_threshold_minutes": sla_minutes,
                "last_update": event.get("updated_at").or_else(|| event.get("created_at")),
            })
        })
        .collect();
    Ok(json_array(values))
}

// ---------------------------------------------------------------------------
// Dispatch / resources
// ---------------------------------------------------------------------------

async fn dispatch_create(ctx: Ctx<'_>) -> ApiResult<Response> {
    let mut input = ctx.body.clone();
    if input
        .get("emergency_event_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
        return Err(ApiError::bad_request(
            "emergency_event_id_required",
            "emergency_event_id is required",
        ));
    }
    input
        .entry("status")
        .or_insert_with(|| Value::String("pending".into()));
    input
        .entry("priority")
        .or_insert_with(|| Value::String("medium".into()));
    input.entry("assignments").or_insert_with(|| json!([]));
    input.entry("metadata").or_insert_with(|| json!({}));
    input.insert(
        "created_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let opts = ctx.opts();
    let row = tier2::write(ctx.client(), &opts, tier2::DISPATCH, input, None).await?;
    Ok(web::created(Value::Object(row)))
}

async fn dispatch_optimize(ctx: Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    // Optimizer assignments are a HITL-gated write (docs/HITL.md): without an
    // approved `dispatch.assign` approval for the emergency event the plan is
    // returned as a read-only proposal and no order/unit state changes.
    let approval_id = web::string_value(ctx.body.get("approval_id"))
        .or_else(|| web::string_value(ctx.body.get("approvalId")))
        .unwrap_or_default();
    let approval = if approval_id.is_empty() {
        None
    } else {
        let event_id = web::string_value(ctx.body.get("emergency_event_id"))
            .or_else(|| web::string_value(ctx.body.get("emergencyEventId")))
            .ok_or_else(|| {
                ApiError::bad_request(
                    "emergency_event_id_required",
                    "applying optimizer assignments requires emergency_event_id",
                )
            })?;
        Some(
            assert_approval_ready(&ctx, &approval_id, &event_id, "dispatch.assign", &actor)
                .await?,
        )
    };
    let orders = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::DISPATCH,
        ctx.config().max_scan_records,
    )
    .await?;
    let resources = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::RESOURCES,
        ctx.config().max_scan_records,
    )
    .await?;
    let plan = domain::optimizer::plan_optimization(
        &maps_to_data(&orders.items),
        &maps_to_data(&resources.items),
        domain::optimizer::OptimizeOptions::default(),
    );
    if approval.is_none() {
        let suggested: Vec<Value> = plan
            .assignments
            .iter()
            .filter_map(|decision| serde_json::to_value(decision).ok())
            .collect();
        return Ok(web::json_response(json!({
            "optimized": plan.assignments.len(),
            "auto_assigned": 0,
            "stale_flagged": 0,
            "reservation_failed": 0,
            "eta_reestimated": 0,
            "unassignable": plan.unassignable.len(),
            "candidates": orders.items.iter().filter(|order| {
                let status = order.get("status").and_then(Value::as_str).unwrap_or("pending");
                !["completed", "canceled", "rejected"].contains(&status)
            }).count(),
            "algorithm": "sos-capability-match-v2",
            "triggered_by": actor,
            "optimized_at": crate::now_iso(),
            "applied": false,
            "suggested": suggested,
            "note": "supply an approved dispatch.assign approval (entity = the emergency event) to apply this plan",
        })));
    }
    let mut auto_assigned = 0usize;
    let mut stale_flagged = 0usize;
    let mut reservation_failed = 0usize;
    for decision in &plan.assignments {
        let Some(current) = orders.items.iter().find(|order| {
            order.get("id").and_then(Value::as_str) == Some(decision.order_id.as_str())
        }) else {
            continue;
        };
        let current_status = current
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        if !["pending", "approved"].contains(&current_status)
            || current
                .get("assigned_resource_unit_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .is_some()
        {
            continue;
        }
        let Some(resource) = resources.items.iter().find(|resource| {
            resource.get("id").and_then(Value::as_str) == Some(decision.resource_unit_id.as_str())
        }) else {
            reservation_failed += 1;
            continue;
        };
        if resource.get("status").and_then(Value::as_str) != Some("available") {
            reservation_failed += 1;
            continue;
        }
        let now = crate::now_iso();
        let mut resource_patch = Map::new();
        resource_patch.insert("status".into(), json!("assigned"));
        resource_patch.insert(
            "assigned_dispatch_order_id".into(),
            json!(decision.order_id),
        );
        resource_patch.insert("assigned_at".into(), json!(now));
        resource_patch.insert("assigned_by".into(), json!(actor));
        let resource_version = resource.get("record_version").and_then(Value::as_i64);
        let reserved = match tier2::update(
            ctx.client(),
            &opts,
            tier2::RESOURCES,
            &decision.resource_unit_id,
            resource_patch,
            resource_version,
        )
        .await
        {
            Ok(row) => row,
            Err(_) => {
                reservation_failed += 1;
                continue;
            }
        };
        let existing_assignments = current
            .get("assignments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut assignments: Vec<Value> = existing_assignments
            .into_iter()
            .filter(|assignment| {
                let id = assignment
                    .get("assigned_resource_unit_id")
                    .or_else(|| assignment.get("resource_unit_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                id != decision.resource_unit_id
            })
            .collect();
        assignments.push(json!({
            "dispatch_order_id": decision.order_id,
            "resource_unit_id": decision.resource_unit_id,
            "assigned_resource_unit_id": decision.resource_unit_id,
            "assigned_user_id": decision.resource_unit_id,
            "assigned_at": now,
            "eta_minutes": decision.eta_minutes,
            "assigned_by": "sos-optimizer-v2",
        }));
        let mut patch = Map::new();
        patch.insert("status".into(), json!("assigned"));
        patch.insert(
            "assigned_resource_unit_id".into(),
            json!(decision.resource_unit_id),
        );
        patch.insert("assigned_user_id".into(), json!(decision.resource_unit_id));
        patch.insert("assigned_at".into(), json!(now));
        patch.insert("eta_minutes".into(), json!(decision.eta_minutes));
        patch.insert("assignments".into(), Value::Array(assignments));
        patch.insert("assigned_by".into(), json!(actor));
        // Mirror dispatch_approve: the applied order records which approval
        // admitted the batch assignment and who carried it in.
        if let Some(approval) = approval.as_ref() {
            patch.insert("approval_id".into(), approval.get("id").cloned().unwrap_or(Value::Null));
            patch.insert("approved_by".into(), json!(actor));
            patch.insert(
                "approval_roles".into(),
                approval
                    .get("approverRoles")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            patch.insert("approved_at".into(), json!(crate::now_iso()));
        }
        let metadata = current
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut optimizer = Map::new();
        optimizer.insert("algorithm".into(), json!("sos-capability-match-v2"));
        optimizer.insert("distance_km".into(), json!(decision.distance_km));
        optimizer.insert("reason".into(), json!(decision.reason));
        optimizer.insert("optimized_at".into(), json!(crate::now_iso()));
        let mut metadata = metadata;
        metadata.insert("optimizer".into(), Value::Object(optimizer));
        patch.insert("metadata".into(), Value::Object(metadata));
        let version = current.get("record_version").and_then(Value::as_i64);
        match tier2::update(
            ctx.client(),
            &opts,
            tier2::DISPATCH,
            &decision.order_id,
            patch,
            version,
        )
        .await
        {
            Ok(_) => auto_assigned += 1,
            Err(_) => {
                let mut release = Map::new();
                release.insert("status".into(), json!("available"));
                release.insert("assigned_dispatch_order_id".into(), Value::Null);
                let reserved_version = reserved.get("record_version").and_then(Value::as_i64);
                let _ = tier2::update(
                    ctx.client(),
                    &opts,
                    tier2::RESOURCES,
                    &decision.resource_unit_id,
                    release,
                    reserved_version,
                )
                .await;
                reservation_failed += 1;
            }
        }
    }
    for order_id in &plan.stale {
        let Some(current) = orders
            .items
            .iter()
            .find(|order| order.get("id").and_then(Value::as_str) == Some(order_id.as_str()))
        else {
            continue;
        };
        let mut metadata = current
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        metadata.insert("stale".into(), json!(true));
        metadata.insert("stale_flagged_at".into(), json!(crate::now_iso()));
        let mut patch = Map::new();
        patch.insert("metadata".into(), Value::Object(metadata));
        let version = current.get("record_version").and_then(Value::as_i64);
        let _ = tier2::update(
            ctx.client(),
            &opts,
            tier2::DISPATCH,
            order_id,
            patch,
            version,
        )
        .await?;
        stale_flagged += 1;
    }
    Ok(web::json_response(json!({
        "optimized": plan.assignments.len(),
        "auto_assigned": auto_assigned,
        "stale_flagged": stale_flagged,
        "reservation_failed": reservation_failed,
        "eta_reestimated": auto_assigned,
        "unassignable": plan.unassignable.len(),
        "candidates": orders.items.iter().filter(|order| {
            let status = order.get("status").and_then(Value::as_str).unwrap_or("pending");
            !["completed", "canceled", "rejected"].contains(&status)
        }).count(),
        "algorithm": "sos-capability-match-v2",
        "triggered_by": actor,
        "optimized_at": crate::now_iso(),
        "applied": true,
        "approval_id": approval.as_ref().and_then(|approval| approval.get("id").cloned()),
    })))
}

async fn dispatch_action(ctx: Ctx<'_>, id: &str, action: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::DISPATCH, id).await?;
    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
    let assignment = current
        .get("assigned_resource_unit_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let (next, allowed_from, terminal_at) = match action {
        // Responder progression (plugins/workflows contract): an assigned unit
        // starts en route, then arrives on scene. `complete` stays valid from
        // all three active states.
        "start" => ("in_transit", &["assigned"][..], "started_at"),
        "arrive" => ("on_scene", &["in_transit"][..], "arrived_at"),
        "complete" => (
            "completed",
            &["assigned", "in_transit", "on_scene"][..],
            "completed_at",
        ),
        "reject" => ("rejected", &["pending", "assigned"][..], "rejected_at"),
        "cancel" => (
            "canceled",
            &["pending", "assigned", "in_transit", "on_scene"][..],
            "canceled_at",
        ),
        _ => {
            return Ok(web::status_json(
                StatusCode::NOT_FOUND,
                json!({ "error": "not_found", "product": "synapsecity-sos" }),
            ))
        }
    };
    if status == next {
        let mut response = current;
        response.insert("idempotent".into(), json!(true));
        return Ok(web::json_response(Value::Object(response)));
    }
    if matches!(status, "completed" | "canceled" | "rejected") {
        return Err(ApiError::conflict(
            "order_terminal",
            format!("dispatch order {id} is already {status}"),
        ));
    }
    if !allowed_from.contains(&status) {
        return Err(ApiError::conflict(
            "invalid_dispatch_transition",
            format!("cannot {action} a dispatch order in status {status}"),
        )
        .with_details(json!({ "allowedFrom": allowed_from, "current": status })));
    }
    if action == "complete" && assignment.is_none() {
        return Err(ApiError::conflict(
            "dispatch_assignment_required",
            "complete requires an assigned resource unit",
        ));
    }
    let now = crate::now_iso();
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let mut history = current
        .get("status_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    history.push(json!({
        "from": status,
        "to": next,
        "action": action,
        "at": now,
        "by": actor,
        "note": ctx.body.get("note").cloned().unwrap_or(Value::Null),
    }));
    let mut patch = Map::new();
    patch.insert("status".into(), json!(next));
    patch.insert(terminal_at.into(), json!(now));
    patch.insert("status_history".into(), Value::Array(history));
    if let Some(note) = ctx.body.get("resolution_note").cloned() {
        patch.insert("resolution_note".into(), note);
    }
    if let Some(assignment) = current.get("assignments").cloned() {
        patch.insert("assignments".into(), assignment);
    }
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?
        .or_else(|| current.get("record_version").and_then(Value::as_i64));
    let row = tier2::update(ctx.client(), &opts, tier2::DISPATCH, id, patch, version).await?;
    // Only a terminal order releases its unit. `start`/`arrive` move the same
    // unit along the responder progression, so the reservation must survive.
    if matches!(next, "completed" | "canceled" | "rejected") {
        if let Some(resource_id) = assignment {
            if let Ok(resource) =
                tier2::get(ctx.client(), &opts, tier2::RESOURCES, &resource_id).await
            {
                let reserved_for = resource
                    .get("assigned_dispatch_order_id")
                    .and_then(Value::as_str);
                if reserved_for == Some(id) {
                    let mut release = Map::new();
                    release.insert("status".into(), json!("available"));
                    release.insert("assigned_dispatch_order_id".into(), Value::Null);
                    release.insert("released_at".into(), json!(crate::now_iso()));
                    let resource_version = resource.get("record_version").and_then(Value::as_i64);
                    if let Err(error) = tier2::update(
                        ctx.client(),
                        &opts,
                        tier2::RESOURCES,
                        &resource_id,
                        release,
                        resource_version,
                    )
                    .await
                    {
                        tracing::warn!(
                            resource_unit = %resource_id,
                            dispatch_order = %id,
                            error = %error.message,
                            "dispatch order became terminal but the resource unit could not be released"
                        );
                    }
                }
            }
        }
    }
    Ok(web::send_record(row))
}

async fn dispatch_approval(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let order = tier2::get(ctx.client(), &opts, tier2::DISPATCH, id).await?;
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let approval = create_approval(
        &ctx,
        format!(
            "Dispatch approval: {}",
            order.get("title").and_then(Value::as_str).unwrap_or(id)
        ),
        "sos.dispatch",
        "dispatch.assign",
        "dispatch",
        id,
        json!({
            "incident_id": order.get("incident_id"),
            "priority": order.get("priority"),
            "resource_type": order.get("resource_type"),
        }),
        &actor,
    )
    .await?;
    Ok(web::accepted(
        json!({ "approval": approval, "hitl_required": true }),
    ))
}

async fn dispatch_approve(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let approval_id = web::string_value(ctx.body.get("approval_id"))
        .or_else(|| web::string_value(ctx.body.get("approvalId")))
        .unwrap_or_default();
    if approval_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "approval_required",
            "create a dispatch approval first and supply approval_id",
        ));
    }
    let approval =
        assert_approval_ready(&ctx, &approval_id, id, "dispatch.assign", &actor).await?;
    let resource_id = requested_resource_unit_id(ctx.body).ok_or_else(|| {
        ApiError::bad_request(
            "assigned_resource_unit_id_required",
            "approve/assign needs an existing SOS resource unit id",
        )
    })?;
    let current = tier2::get(ctx.client(), &opts, tier2::DISPATCH, id).await?;
    let order_status = current.get("status").and_then(Value::as_str).unwrap_or("");
    if ["completed", "canceled", "rejected"].contains(&order_status) {
        return Err(ApiError::conflict(
            "order_terminal",
            format!("dispatch order {id} is {order_status}"),
        ));
    }
    let existing_resource = current
        .get("assigned_resource_unit_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if let Some(existing) = existing_resource {
        if existing != resource_id {
            return Err(ApiError::conflict(
                "order_already_assigned",
                format!("dispatch order {id} is already assigned to {existing}"),
            ));
        }
        if order_status == "assigned" {
            let mut response = current;
            response.insert("idempotent".into(), json!(true));
            return Ok(web::json_response(Value::Object(response)));
        }
        return Err(ApiError::conflict(
            "invalid_dispatch_status",
            format!("dispatch order {id} is already {order_status}"),
        ));
    }
    if !["pending", "approved"].contains(&order_status) {
        return Err(ApiError::conflict(
            "invalid_dispatch_status",
            format!("cannot assign a dispatch order in status {order_status}"),
        ));
    }
    let resource = tier2::get(ctx.client(), &opts, tier2::RESOURCES, &resource_id)
        .await
        .map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::not_found(
                    "resource_unit_not_found",
                    format!("no resource unit {resource_id}"),
                )
            } else {
                error
            }
        })?;
    let resource_status = resource.get("status").and_then(Value::as_str).unwrap_or("");
    let already_reserved = resource_status == "assigned"
        && resource
            .get("assigned_dispatch_order_id")
            .and_then(Value::as_str)
            == Some(id);
    if !already_reserved && resource_status != "available" {
        return Err(ApiError::conflict(
            "resource_unit_unavailable",
            format!("resource unit {resource_id} is {resource_status}"),
        ));
    }
    let now = crate::now_iso();
    let reserved = if already_reserved {
        resource.clone()
    } else {
        let mut resource_patch = Map::new();
        resource_patch.insert("status".into(), json!("assigned"));
        resource_patch.insert("assigned_dispatch_order_id".into(), json!(id));
        resource_patch.insert("assigned_at".into(), json!(now));
        resource_patch.insert("assigned_by".into(), json!(actor));
        let resource_version = resource.get("record_version").and_then(Value::as_i64);
        tier2::update(
            ctx.client(),
            &opts,
            tier2::RESOURCES,
            &resource_id,
            resource_patch,
            resource_version,
        )
        .await
        .map_err(|error| {
            if error.status == StatusCode::CONFLICT {
                ApiError::conflict(
                    "resource_unit_conflict",
                    format!("resource unit {resource_id} was assigned concurrently"),
                )
            } else {
                error
            }
        })?
    };
    let mut assignments = current
        .get("assignments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let duplicate = assignments.iter().any(|assignment| {
        assignment.get("dispatch_order_id").and_then(Value::as_str) == Some(id)
            && assignment
                .get("assigned_resource_unit_id")
                .or_else(|| assignment.get("resource_unit_id"))
                .and_then(Value::as_str)
                == Some(resource_id.as_str())
    });
    if !duplicate {
        assignments.push(json!({
            "dispatch_order_id": id,
            "resource_unit_id": resource_id,
            "assigned_resource_unit_id": resource_id,
            "assigned_user_id": resource_id,
            "assigned_at": now,
            "assigned_by": actor,
        }));
    }
    let mut patch = Map::new();
    if let Some(eta) = ctx.body.get("eta_minutes").and_then(Value::as_f64) {
        patch.insert("eta_minutes".into(), json!(eta));
    }
    if let Some(notes) = ctx.body.get("notes").cloned() {
        patch.insert("notes".into(), notes);
    }
    patch.insert("status".into(), json!("assigned"));
    patch.insert("assigned_resource_unit_id".into(), json!(resource_id));
    patch.insert("assigned_user_id".into(), json!(resource_id));
    patch.insert("assigned_at".into(), json!(now));
    patch.insert("assigned_by".into(), json!(actor));
    patch.insert("assignments".into(), Value::Array(assignments));
    patch.insert("approval_id".into(), json!(approval.get("id")));
    patch.insert("approved_by".into(), json!(actor));
    patch.insert(
        "approval_roles".into(),
        approval
            .get("approverRoles")
            .cloned()
            .unwrap_or(Value::Null),
    );
    patch.insert("approved_at".into(), json!(crate::now_iso()));
    let version = current.get("record_version").and_then(Value::as_i64);
    let row = match tier2::update(ctx.client(), &opts, tier2::DISPATCH, id, patch, version).await {
        Ok(row) => row,
        Err(error) => {
            // Compensate the reservation so a failed order update cannot
            // permanently strand a resource unit.
            if !already_reserved {
                let mut release = Map::new();
                release.insert("status".into(), json!("available"));
                release.insert("assigned_dispatch_order_id".into(), Value::Null);
                let reserved_version = reserved.get("record_version").and_then(Value::as_i64);
                let _ = tier2::update(
                    ctx.client(),
                    &opts,
                    tier2::RESOURCES,
                    &resource_id,
                    release,
                    reserved_version,
                )
                .await;
            }
            return Err(error);
        }
    };
    Ok(web::send_record(row))
}

fn requested_resource_unit_id(body: &Map<String, Value>) -> Option<String> {
    [
        "assigned_resource_unit_id",
        "resource_unit_id",
        "assigned_user_id",
        "user_id",
    ]
    .iter()
    .find_map(|key| {
        body.get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

async fn resource_create(ctx: Ctx<'_>) -> ApiResult<Response> {
    let mut input = ctx.body.clone();
    if input
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
        || input
            .get("resource_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
    {
        return Err(ApiError::bad_request(
            "name_and_resource_type_required",
            "name and resource_type are required",
        ));
    }
    input
        .entry("resource_code")
        .or_insert_with(|| json!(format!("RU-{}", chrono::Utc::now().timestamp_millis())));
    input.entry("status").or_insert_with(|| json!("available"));
    input.entry("skills").or_insert_with(|| json!([]));
    input.entry("metadata").or_insert_with(|| json!({}));
    let opts = ctx.opts();
    let row = tier2::write(ctx.client(), &opts, tier2::RESOURCES, input, None).await?;
    Ok(web::created(Value::Object(row)))
}

/// Resource-unit lifecycle vocabulary, mirroring the DX workspace binding
/// (`plugins/workflows/sos-workspace-actions.workflow.json`): the dispatch
/// pool moves between available, assigned, deployed, unavailable and
/// maintenance, and `retired` is terminal.
const RESOURCE_STATUSES: &[&str] = &[
    "available",
    "assigned",
    "deployed",
    "unavailable",
    "maintenance",
    "retired",
];

/// Statuses an operator may move **from** for a given target status. The
/// dispatch reservation/release paths are internal business flows; this table
/// governs the explicit status endpoint.
fn resource_transition_allowed_from(status: &str) -> Option<&'static [&'static str]> {
    Some(match status {
        "available" => &["unavailable", "maintenance"][..],
        "assigned" => &["available"][..],
        "deployed" => &["available", "assigned"][..],
        "unavailable" => &["available"][..],
        "maintenance" => &["available"][..],
        "retired" => &["available", "unavailable", "maintenance"][..],
        _ => return None,
    })
}

async fn resource_status(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let requested = web::string_value(ctx.body.get("status"))
        .ok_or_else(|| ApiError::bad_request("status_required", "status is required"))?;
    let allowed_from = resource_transition_allowed_from(&requested).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_resource_status",
            format!("unknown resource status {requested}"),
        )
        .with_details(json!({ "allowed": RESOURCE_STATUSES }))
    })?;
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::RESOURCES, id).await?;
    let current_status = current
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("available")
        .to_string();
    if current_status == requested {
        let mut response = current;
        response.insert("idempotent".into(), json!(true));
        return Ok(web::json_response(Value::Object(response)));
    }
    if current_status == "retired" {
        return Err(ApiError::conflict(
            "record_immutable",
            format!("resource unit {id} is retired and is immutable"),
        ));
    }
    if !allowed_from.contains(&current_status.as_str()) {
        return Err(ApiError::conflict(
            "invalid_resource_transition",
            format!("cannot move resource unit {id} from {current_status} to {requested}"),
        )
        .with_details(json!({ "allowedFrom": allowed_from, "current": current_status })));
    }
    let now = crate::now_iso();
    let mut history = current
        .get("status_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    history.push(json!({
        "from": current_status,
        "to": requested,
        "at": now,
        "by": ctx.actor().unwrap_or_else(|| "sos-operator".into()),
        "note": ctx.body.get("note").cloned().unwrap_or(Value::Null),
    }));
    let mut patch = Map::new();
    patch.insert("status".into(), json!(requested));
    patch.insert("status_changed_at".into(), json!(now));
    patch.insert("status_history".into(), Value::Array(history));
    if requested == "retired" {
        patch.insert("retired_at".into(), json!(crate::now_iso()));
    }
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let row = tier2::update(ctx.client(), &opts, tier2::RESOURCES, id, patch, version).await?;
    Ok(web::json_response(Value::Object(row)))
}

async fn shelters_near(ctx: Ctx<'_>) -> ApiResult<Response> {
    let data = query_data(ctx.query);
    let near = domain::geo::parse_near_query(&data).map_err(domain_error)?;
    let opts = ctx.opts();
    let resources = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::RESOURCES,
        ctx.config().max_scan_records,
    )
    .await?;
    let mut shelters: Vec<(f64, Value)> = Vec::new();
    for resource in resources.items {
        if resource.get("resource_type").and_then(Value::as_str) != Some("shelter") {
            continue;
        }
        let status = resource.get("status").and_then(Value::as_str).unwrap_or("");
        if ["offline", "maintenance"].contains(&status) {
            continue;
        }
        let Some(location) = resource.get("current_location") else {
            continue;
        };
        let mut wrapper = Map::new();
        wrapper.insert("geometry".into(), location.clone());
        let distance = domain::geo::hazard_distance_meters(
            &to_data(&wrapper),
            domain::geo::LatLng {
                lat: near.lat,
                lng: near.lng,
            },
        );
        let Some(distance) = distance else {
            continue;
        };
        if distance > near.radius_m {
            continue;
        }
        shelters.push((
            distance,
            json!({
                "id": resource.get("id"),
                "name": resource.get("name"),
                "resource_code": resource.get("resource_code"),
                "district": resource.get("district"),
                "ward": resource.get("ward"),
                "capacity": resource.get("capacity"),
                "capacity_unit": resource.get("capacity_unit"),
                "status": resource.get("status"),
                "contact_phone": resource.get("contact_phone"),
                "current_location": resource.get("current_location"),
                "distance_m": distance.round() as i64,
            }),
        ));
    }
    shelters.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let items: Vec<Value> = shelters
        .into_iter()
        .skip(near.offset)
        .take(near.limit)
        .map(|(_, value)| value)
        .collect();
    Ok(web::json_response(json!({
        "shelters": items,
        "radius_m": near.radius_m,
        "total": items.len(),
    })))
}

fn domain_error(error: domain::DomainError) -> ApiError {
    ApiError {
        status: StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
        code: error.code,
        message: error.message,
        details: error.details,
    }
}

// ---------------------------------------------------------------------------
// SITREP / mutual aid / AAR
// ---------------------------------------------------------------------------

async fn sitrep_create(ctx: Ctx<'_>) -> ApiResult<Response> {
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let input = to_data(ctx.body);
    let actor = domain::sitrep::SitrepActor {
        username: Some(actor.clone()),
        id: ctx.session.map(|claims| claims.sub.clone()),
    };
    let validation = domain::sitrep::validate_sitrep_create(&input, &actor);
    if !validation.errors.is_empty() {
        return Err(
            ApiError::bad_request("sitrep_validation_failed", "SITREP payload is invalid")
                .with_details(serde_json::to_value(validation.errors).unwrap_or(Value::Null)),
        );
    }
    let event_id = validation
        .value
        .get("emergency_event_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let opts = ctx.opts();
    let _ = tier2::get(ctx.client(), &opts, tier2::EVENTS, &event_id)
        .await
        .map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::bad_request(
                    "emergency_event_not_found",
                    format!("no emergency event {event_id}"),
                )
            } else {
                error
            }
        })?;
    let mut value = validation.value;
    value.insert("version".into(), json!(1));
    value.insert("deltas".into(), json!([]));
    value
        .entry("snapshot".to_string())
        .or_insert_with(|| json!({}));
    value
        .entry("metadata".to_string())
        .or_insert_with(|| json!({}));
    value.insert(
        "created_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let row = tier2::write(
        ctx.client(),
        &opts,
        tier2::SITREP,
        value.into_iter().collect(),
        None,
    )
    .await?;
    Ok(web::created(Value::Object(row)))
}

async fn sitrep_update(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::SITREP, id).await?;
    let current_data = to_data(&current);
    let validation = domain::sitrep::validate_sitrep_update(&to_data(ctx.body), &current_data)
        .map_err(domain_error)?;
    if !validation.errors.is_empty() {
        return Err(
            ApiError::bad_request("sitrep_validation_failed", "SITREP payload is invalid")
                .with_details(serde_json::to_value(validation.errors).unwrap_or(Value::Null)),
        );
    }
    let mut patch: Map<String, Value> = validation.value.into_iter().collect();
    patch.insert(
        "updated_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let row = tier2::update(ctx.client(), &opts, tier2::SITREP, id, patch, version).await?;
    Ok(web::json_response(Value::Object(row)))
}

async fn sitrep_delta(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::SITREP, id).await?;
    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
    let actor = domain::sitrep::SitrepActor {
        username: ctx.actor(),
        id: ctx.session.map(|claims| claims.sub.clone()),
    };
    if status == "published" || status == "archived" {
        let revision = domain::sitrep::revision_from_delta(
            &to_data(&current),
            &to_data(ctx.body),
            &actor,
            Some(crate::now_iso()),
        );
        let revision_id = revision
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let row = tier2::write(
            ctx.client(),
            &opts,
            tier2::SITREP,
            revision,
            Some(&revision_id),
        )
        .await?;
        let mut response = row;
        response.insert("superseded_sitrep_id".into(), json!(id));
        return Ok(web::created(Value::Object(response)));
    }
    let mut deltas = current
        .get("deltas")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut delta = ctx.body.clone();
    delta.insert(
        "actor_id".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    delta.insert("created_at".into(), json!(crate::now_iso()));
    deltas.push(Value::Object(delta));
    let mut patch = Map::new();
    patch.insert("deltas".into(), Value::Array(deltas));
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let row = tier2::update(ctx.client(), &opts, tier2::SITREP, id, patch, version).await?;
    Ok(web::json_response(Value::Object(row)))
}

async fn sitrep_publish(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::SITREP, id).await?;
    domain::sitrep::assert_publishable(&to_data(&current)).map_err(domain_error)?;
    let mut patch = Map::new();
    patch.insert("status".into(), json!("published"));
    patch.insert("published_at".into(), json!(crate::now_iso()));
    patch.insert(
        "published_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    patch.insert(
        "reviewed_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let row = tier2::update(ctx.client(), &opts, tier2::SITREP, id, patch, version).await?;
    Ok(web::json_response(Value::Object(row)))
}

async fn mutual_aid_create(ctx: Ctx<'_>) -> ApiResult<Response> {
    let validated = domain::mutual_aid::validate_request(&to_data(ctx.body))
        .map_err(|error| ApiError::bad_request(error.clone(), error))?;
    let opts = ctx.opts();
    let existing = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::MUTUAL_AID,
        ctx.config().max_scan_records,
    )
    .await?;
    if let Some(duplicate) = existing.items.iter().find(|row| {
        row.get("request_number").and_then(Value::as_str) == Some(validated.request_number.as_str())
    }) {
        return Err(ApiError::conflict(
            "duplicate_request",
            "A mutual-aid request with this number already exists.",
        )
        .with_details(json!({ "existing_id": duplicate.get("id") })));
    }
    let id = ctx
        .body
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut value = serde_json::to_value(&validated)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    value.insert("id".into(), json!(id));
    value.insert("status".into(), json!("open"));
    value.insert(
        "history".into(),
        json!([{ "action": "created", "at": crate::now_iso(), "by": ctx.actor().unwrap_or_else(|| "sos-operator".into()) }]),
    );
    value.insert("created_at".into(), json!(crate::now_iso()));
    value.insert("updated_at".into(), json!(crate::now_iso()));
    value.insert(
        "created_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let row = tier2::write(ctx.client(), &opts, tier2::MUTUAL_AID, value, Some(&id)).await?;
    Ok(web::created(Value::Object(row)))
}

async fn mutual_aid_public(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let row = tier2::get(ctx.client(), &opts, tier2::MUTUAL_AID, id)
        .await
        .map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::not_found("mutual_aid_not_found", "Mutual-aid request was not found.")
            } else {
                error
            }
        })?;
    let request: domain::mutual_aid::MutualAidRequest = serde_json::from_value(Value::Object(row))
        .map_err(|_| {
            ApiError::bad_gateway(
                "invalid_mutual_aid_record",
                "Stored mutual-aid record is invalid.",
            )
        })?;
    Ok(web::json_response(Value::Object(
        domain::mutual_aid::public_mutual_aid_projection(&request),
    )))
}

async fn mutual_aid_accept(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::MUTUAL_AID, id).await?;
    let request: domain::mutual_aid::MutualAidRequest =
        serde_json::from_value(Value::Object(current.clone())).map_err(|_| {
            ApiError::bad_gateway(
                "invalid_mutual_aid_record",
                "Stored mutual-aid record is invalid.",
            )
        })?;
    let accept: domain::mutual_aid::MutualAidAccept =
        serde_json::from_value(Value::Object(ctx.body.clone()))
            .map_err(|_| ApiError::bad_request("invalid_accept_body", "Invalid accept payload."))?;
    let unit_id = accept.unit_id.trim().to_string();
    if unit_id.is_empty() {
        return Err(ApiError::bad_request(
            "unit_id_required",
            "unit_id is required",
        ));
    }
    let unit = tier2::get(ctx.client(), &opts, tier2::RESOURCES, &unit_id)
        .await
        .map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::not_found(
                    "resource_unit_not_found",
                    format!("no resource unit {unit_id}"),
                )
            } else {
                error
            }
        })?;
    let validation = domain::mutual_aid::validate_accept(&request, &accept, &to_data(&unit))
        .map_err(domain_error)?;
    let expected = match (
        tier2::requested_version(ctx.headers, Some(ctx.body))?,
        accept.expected_version,
    ) {
        (Some(header), Some(body)) if header as f64 != body => {
            return Err(ApiError::bad_request(
                "version_precondition_mismatch",
                "If-Match and expected_version disagree",
            ))
        }
        (Some(header), _) => Some(header as f64),
        (None, body) => body,
    };
    domain::mutual_aid::assert_request_version(&current, expected).map_err(domain_error)?;
    let accepted = accept.accepted_quantity;
    let next_filled = request.filled_quantity + accepted;
    let status = if next_filled >= request.quantity {
        "filled"
    } else {
        "partially_filled"
    };
    let available = validation.available;
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let now = crate::now_iso();
    let unit_version = unit.get("record_version").and_then(Value::as_i64);
    let mut unit_patch = Map::new();
    unit_patch.insert(
        "available_quantity".into(),
        json!((available - accepted).max(0.0)),
    );
    unit_patch.insert("updated_at".into(), json!(now));
    let updated_unit = tier2::update(
        ctx.client(),
        &opts,
        tier2::RESOURCES,
        &unit_id,
        unit_patch,
        unit_version,
    )
    .await
    .map_err(|error| {
        if error.status == StatusCode::CONFLICT {
            ApiError::conflict(
                "resource_unit_conflict",
                format!("resource unit {unit_id} changed while the accept was being processed"),
            )
        } else {
            error
        }
    })?;
    let mut history = current
        .get("history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    history.push(json!({
        "action": "accept",
        "unit_id": unit_id,
        "accepted_quantity": accepted,
        "eta_minutes": accept.eta_minutes,
        "at": now,
        "by": actor,
    }));
    let mut patch = Map::new();
    patch.insert("filled_quantity".into(), json!(next_filled));
    patch.insert("status".into(), json!(status));
    patch.insert("updated_at".into(), json!(crate::now_iso()));
    patch.insert("history".into(), Value::Array(history));
    let version = current.get("record_version").and_then(Value::as_i64);
    let updated =
        match tier2::update(ctx.client(), &opts, tier2::MUTUAL_AID, id, patch, version).await {
            Ok(updated) => updated,
            Err(error) => {
                // The unit was reserved first to avoid over-commit. If the request
                // cannot be updated (for example a concurrent accept won the
                // version race), restore the capacity before returning.
                let mut restore = Map::new();
                restore.insert("available_quantity".into(), json!(available));
                restore.insert("updated_at".into(), json!(crate::now_iso()));
                let restored_version = updated_unit.get("record_version").and_then(Value::as_i64);
                if let Err(compensation) = tier2::update(
                    ctx.client(),
                    &opts,
                    tier2::RESOURCES,
                    &unit_id,
                    restore,
                    restored_version,
                )
                .await
                {
                    return Err(ApiError::bad_gateway(
                        "mutual_aid_compensation_failed",
                        format!(
                            "request update failed ({}) and capacity compensation failed ({})",
                            error.code, compensation.code
                        ),
                    ));
                }
                return Err(error);
            }
        };
    Ok(web::json_response(json!({
        "request": updated,
        "resource_unit": updated_unit,
        "remaining": (request.quantity - next_filled).max(0.0),
    })))
}

async fn mutual_aid_decline(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::MUTUAL_AID, id).await?;
    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
    if !["open", "partially_filled"].contains(&status) {
        return Err(ApiError::conflict(
            "request_not_open",
            format!("request is {status}"),
        ));
    }
    let mut history = current
        .get("history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    history.push(json!({
        "action": "decline",
        "reason": ctx.body.get("reason"),
        "at": crate::now_iso(),
        "by": ctx.actor().unwrap_or_else(|| "sos-operator".into()),
    }));
    let mut patch = Map::new();
    patch.insert("status".into(), json!("declined"));
    patch.insert(
        "decline_reason".into(),
        ctx.body.get("reason").cloned().unwrap_or(Value::Null),
    );
    patch.insert("updated_at".into(), json!(crate::now_iso()));
    patch.insert("history".into(), Value::Array(history));
    let version = current.get("record_version").and_then(Value::as_i64);
    let row = tier2::update(ctx.client(), &opts, tier2::MUTUAL_AID, id, patch, version).await?;
    Ok(web::send_record(row))
}

async fn mutual_aid_handoff(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::MUTUAL_AID, id).await?;
    let mut history = current
        .get("history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    history.push(json!({
        "action": "handoff",
        "to_agency": ctx.body.get("to_agency"),
        "at": crate::now_iso(),
        "by": ctx.actor().unwrap_or_else(|| "sos-operator".into()),
    }));
    let mut patch = Map::new();
    patch.insert("status".into(), json!("handed_off"));
    patch.insert(
        "handed_off_to".into(),
        ctx.body.get("to_agency").cloned().unwrap_or(Value::Null),
    );
    patch.insert(
        "handoff_notes".into(),
        ctx.body.get("notes").cloned().unwrap_or(Value::Null),
    );
    patch.insert("updated_at".into(), json!(crate::now_iso()));
    patch.insert("history".into(), Value::Array(history));
    let version = current.get("record_version").and_then(Value::as_i64);
    let row = tier2::update(ctx.client(), &opts, tier2::MUTUAL_AID, id, patch, version).await?;
    Ok(web::send_record(row))
}

// ---------------------------------------------------------------------------
// HITL (Tier-2 approvals)
// ---------------------------------------------------------------------------

async fn create_approval(
    ctx: &Ctx<'_>,
    title: impl Into<String>,
    module: &str,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: Value,
    requester: &str,
) -> ApiResult<Value> {
    let mut body = json!({
        "title": title.into(),
        "module": module,
        "action": action,
        "entityType": entity_type,
        "entityId": entity_id,
        "payload": payload,
        "requester": requester,
        "approverRoles": if action == "eop.approve" {
            ctx.config().eop_approver_roles.clone()
        } else if action == "resource.escalate" {
            ctx.config().resource_approver_roles.clone()
        } else {
            ctx.config().dispatch_approver_roles.clone()
        },
        "requiredApprovals": ctx.config().required_approvals,
        "dueAt": chrono::Utc::now()
            .checked_add_signed(chrono::Duration::minutes(ctx.config().approval_sla_minutes as i64))
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    });
    let opts = ctx.opts();
    let response = ctx
        .client()
        .post("/v1/capabilities/approvals", body, &opts)
        .await
        .map_err(ApiError::from)?;
    Ok(response.get("approval").cloned().unwrap_or(response))
}

async fn get_approval(ctx: &Ctx<'_>, id: &str) -> ApiResult<Value> {
    let opts = ctx.opts();
    let response = ctx
        .client()
        .get(format!("/v1/capabilities/approvals/{id}"), &opts)
        .await
        .map_err(ApiError::from)?;
    Ok(response.get("approval").cloned().unwrap_or(response))
}

async fn assert_approval_ready(
    ctx: &Ctx<'_>,
    approval_id: &str,
    entity_id: &str,
    action: &str,
    actor: &str,
) -> ApiResult<Value> {
    let approval = get_approval(ctx, approval_id).await?;
    if approval.get("status").and_then(Value::as_str) != Some("approved") {
        return Err(ApiError::conflict(
            "approval_not_approved",
            format!(
                "approval is {}",
                approval
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            ),
        ));
    }
    if approval.get("entityId").and_then(Value::as_str) != Some(entity_id) {
        return Err(ApiError::conflict(
            "approval_entity_mismatch",
            "approval belongs to another record",
        ));
    }
    if approval.get("action").and_then(Value::as_str) != Some(action) {
        return Err(ApiError::conflict(
            "approval_action_mismatch",
            "approval belongs to another action",
        ));
    }
    // Four-eyes (docs/HITL.md): the operator who requested the approval can
    // never be the one who makes it ready or uses it.
    if approval.get("requester").and_then(Value::as_str) == Some(actor) {
        return Err(ApiError::forbidden(
            "self_approval_forbidden",
            "the requester cannot approve their own request",
        ));
    }
    Ok(approval)
}

async fn list_pending_approvals(ctx: &Ctx<'_>, module: Option<&str>) -> ApiResult<Vec<Value>> {
    let mut path = "/v1/capabilities/approvals?status=pending".to_string();
    if let Some(module) = module {
        path.push_str("&module=");
        path.push_str(&url::form_urlencoded::byte_serialize(module.as_bytes()).collect::<String>());
    }
    let opts = ctx.opts();
    let response = ctx
        .client()
        .get(path, &opts)
        .await
        .map_err(ApiError::from)?;
    Ok(response
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn hitl_list(ctx: Ctx<'_>) -> ApiResult<Response> {
    let items = list_pending_approvals(&ctx, ctx.query.get("module").map(String::as_str)).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let values: Vec<Value> = items
        .into_iter()
        .map(|mut item| {
            let escalated = item
                .get("dueAt")
                .and_then(Value::as_str)
                .and_then(domain::filters::parse_timestamp)
                .map(|due| due < now)
                .unwrap_or(false);
            item["escalated"] = json!(escalated);
            item
        })
        .collect();
    let total = values.len();
    Ok(web::json_response(
        json!({ "items": values, "total": total }),
    ))
}

async fn hitl_decide(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let decision = web::string_value(ctx.body.get("decision"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !["approve", "reject"].contains(&decision.as_str()) {
        return Err(ApiError::bad_request(
            "invalid_decision",
            "decision must be approve or reject",
        ));
    }
    // Four-eyes (docs/HITL.md): the operator who requested the approval can
    // never decide it. The decision never reaches Tier-2 in that case, so the
    // approval stays pending for a different approver.
    if let Some(actor) = ctx.actor().as_deref() {
        let approval = get_approval(&ctx, id).await?;
        if approval.get("requester").and_then(Value::as_str) == Some(actor) {
            return Err(ApiError::forbidden(
                "self_approval_forbidden",
                "the requester cannot approve their own request",
            ));
        }
    }
    let mut body = json!({ "decision": decision });
    if let Some(note) = web::string_value(ctx.body.get("note")) {
        body["note"] = json!(note);
    }
    let opts = ctx.opts();
    let response = ctx
        .client()
        .post(
            format!("/v1/capabilities/approvals/{id}/decide"),
            body,
            &opts,
        )
        .await
        .map_err(ApiError::from)?;
    Ok(web::json_response(json!({
        "approval": response.get("approval").cloned().unwrap_or(response)
    })))
}

async fn hitl_handoff(ctx: Ctx<'_>) -> ApiResult<Response> {
    let outgoing =
        web::string_value(ctx.body.get("outgoing_role")).unwrap_or_else(|| "duty-manager".into());
    let incoming =
        web::string_value(ctx.body.get("incoming_role")).unwrap_or_else(|| "duty-manager".into());
    let items = list_pending_approvals(&ctx, None).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let approvals: Vec<Value> = items
        .into_iter()
        .map(|mut item| {
            let escalated = item
                .get("dueAt")
                .and_then(Value::as_str)
                .and_then(domain::filters::parse_timestamp)
                .map(|due| due < now)
                .unwrap_or(false);
            item["escalated"] = json!(escalated);
            item
        })
        .collect();
    let mut body = json!({
        "outgoingRole": outgoing,
        "incomingRole": incoming,
        "generatedAt": crate::now_iso(),
        "approvals": approvals,
    });
    if let Some(notes) = web::string_value(ctx.body.get("notes")) {
        body["notes"] = json!(notes);
    }
    Ok(web::json_response(body))
}

// ---------------------------------------------------------------------------
// After-action reports and event resolution
// ---------------------------------------------------------------------------

fn event_id_of(row: &Map<String, Value>) -> String {
    row.get("emergency_event_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

async fn aar_generate(ctx: Ctx<'_>) -> ApiResult<Response> {
    let event_id = web::string_value(ctx.body.get("emergency_event_id")).ok_or_else(|| {
        ApiError::bad_request(
            "emergency_event_id_required",
            "emergency_event_id is required",
        )
    })?;
    let opts = ctx.opts();
    let event = tier2::get(ctx.client(), &opts, tier2::EVENTS, &event_id)
        .await
        .map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::not_found(
                    "emergency_event_not_found",
                    format!("no emergency event {event_id}"),
                )
            } else {
                error
            }
        })?;
    let force = web::bool_value(ctx.body.get("force_regenerate")).unwrap_or(false);
    let summary_override = web::string_value(ctx.body.get("summary_override"));
    let actor = ctx.actor();
    let report = generate_aar(&ctx, &event, force, summary_override, actor).await?;
    let idempotent = report
        .get("idempotent")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(web::status_json(
        if idempotent {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Value::Object(report),
    ))
}

async fn generate_aar(
    ctx: &Ctx<'_>,
    event: &Map<String, Value>,
    force: bool,
    summary_override: Option<String>,
    actor: Option<String>,
) -> ApiResult<Map<String, Value>> {
    let opts = ctx.opts();
    let aars = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::AFTER_ACTION,
        ctx.config().max_scan_records,
    )
    .await?;
    let event_id = event.get("id").and_then(Value::as_str).unwrap_or("");
    let mut existing: Vec<Map<String, Value>> = aars
        .items
        .into_iter()
        .filter(|report| event_id_of(report) == event_id)
        .collect();
    existing.sort_by_key(|report| report.get("version").and_then(Value::as_i64).unwrap_or(1));
    if !force {
        if let Some(last) = existing.last() {
            let mut report = last.clone();
            report.insert("idempotent".into(), json!(true));
            return Ok(report);
        }
    }
    let version = existing
        .iter()
        .map(|report| report.get("version").and_then(Value::as_i64).unwrap_or(0))
        .max()
        .unwrap_or(0)
        + 1;
    let id = format!("aar-{event_id}-v{version}")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                ch
            } else {
                '-'
            }
        })
        .take(180)
        .collect::<String>();
    if let Ok(same) = tier2::get(ctx.client(), &opts, tier2::AFTER_ACTION, &id).await {
        return Ok(same);
    }
    let orders = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::DISPATCH,
        ctx.config().max_scan_records,
    )
    .await?;
    let sitreps = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::SITREP,
        ctx.config().max_scan_records,
    )
    .await?;
    let resources = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::RESOURCES,
        ctx.config().max_scan_records,
    )
    .await?;
    let orders: Vec<Map<String, Value>> = orders
        .items
        .iter()
        .filter(|order| event_id_of(order) == event_id)
        .map(to_data)
        .collect();
    let sitreps: Vec<Map<String, Value>> = sitreps
        .items
        .iter()
        .filter(|sitrep| event_id_of(sitrep) == event_id)
        .map(to_data)
        .collect();
    let resources: Vec<Map<String, Value>> = resources.items.iter().map(to_data).collect();
    let event_data = to_data(event);
    let computed = domain::after_action::compute_after_action(
        &domain::after_action::AfterActionInput::new(&event_data)
            .with_orders(&orders)
            .with_sitreps(&sitreps)
            .with_resources(&resources),
    );
    let code = format!(
        "AAR-{}-v{version}",
        event
            .get("event_code")
            .and_then(Value::as_str)
            .or_else(|| event.get("id").and_then(Value::as_str))
            .unwrap_or("event")
    );
    let title = format!(
        "After-action report — {}",
        event
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(event_id)
    );
    let mut metadata = computed.metadata;
    metadata.insert(
        "generated_by_user".into(),
        actor.map(Value::String).unwrap_or(Value::Null),
    );
    let record = json!({
        "id": id,
        "emergency_event_id": event_id,
        "report_code": code,
        "title": title,
        "summary": summary_override.unwrap_or(computed.summary),
        "status": "draft",
        "version": version,
        "timeline": computed.timeline,
        "kpi": computed.kpi,
        "lessons_learned": [],
        "recommendations": [],
        "generated_by": "sos-kpi-engine-v1",
        "generated_at": crate::now_iso(),
        "metadata": Value::Object(metadata),
    });
    let input = record.as_object().cloned().unwrap_or_default();
    let row = match tier2::write(ctx.client(), &opts, tier2::AFTER_ACTION, input, Some(&id)).await {
        Ok(row) => row,
        Err(error) if error.code == "record_exists" => {
            tier2::get(ctx.client(), &opts, tier2::AFTER_ACTION, &id).await?
        }
        Err(error) => return Err(error),
    };
    Ok(row)
}

async fn aar_publish(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::AFTER_ACTION, id).await?;
    if current.get("status").and_then(Value::as_str) == Some("published") {
        return Err(ApiError::conflict(
            "aar_already_published",
            "AAR is already published",
        ));
    }
    if !current.get("kpi").map(Value::is_object).unwrap_or(false) {
        return Err(ApiError::bad_request(
            "aar_kpi_required",
            "generate the AAR KPI before publishing",
        ));
    }
    let mut patch = Map::new();
    patch.insert("status".into(), json!("published"));
    patch.insert("published_at".into(), json!(crate::now_iso()));
    patch.insert(
        "published_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let row = tier2::update(ctx.client(), &opts, tier2::AFTER_ACTION, id, patch, version).await?;
    Ok(web::json_response(Value::Object(row)))
}

async fn event_resolve(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let event = tier2::get(ctx.client(), &opts, tier2::EVENTS, id).await?;
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(id)
        .to_string();
    if event.get("status").and_then(Value::as_str) == Some("resolved") {
        let mut response = event.clone();
        let aars = tier2::list_all(
            ctx.client(),
            &opts,
            tier2::AFTER_ACTION,
            ctx.config().max_scan_records,
        )
        .await?;
        let latest = aars
            .items
            .iter()
            .filter(|report| event_id_of(report) == event_id)
            .max_by_key(|report| report.get("version").and_then(Value::as_i64).unwrap_or(1));
        response.insert(
            "after_action_report_id".into(),
            latest
                .and_then(|report| report.get("id"))
                .cloned()
                .unwrap_or(Value::Null),
        );
        response.insert("idempotent".into(), json!(true));
        return Ok(web::json_response(Value::Object(response)));
    }
    let ended_at = web::string_value(ctx.body.get("ended_at")).unwrap_or_else(crate::now_iso);
    let mut preview = event.clone();
    preview.insert("status".into(), json!("resolved"));
    preview.insert("ended_at".into(), json!(ended_at));
    preview.insert(
        "resolution_note".into(),
        ctx.body
            .get("resolution_note")
            .cloned()
            .or_else(|| event.get("resolution_note").cloned())
            .unwrap_or(Value::Null),
    );
    preview.insert(
        "resolved_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let report = generate_aar(&ctx, &preview, false, None, ctx.actor()).await?;
    let report_id = report.get("id").cloned().unwrap_or(Value::Null);
    let mut patch = Map::new();
    patch.insert("status".into(), json!("resolved"));
    patch.insert("ended_at".into(), json!(ended_at));
    patch.insert(
        "resolution_note".into(),
        preview
            .get("resolution_note")
            .cloned()
            .unwrap_or(Value::Null),
    );
    patch.insert("after_action_report_id".into(), report_id.clone());
    patch.insert(
        "resolved_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let version = event.get("record_version").and_then(Value::as_i64);
    let mut resolved =
        tier2::update(ctx.client(), &opts, tier2::EVENTS, id, patch, version).await?;
    resolved.insert("after_action_report_id".into(), report_id);
    Ok(web::json_response(Value::Object(resolved)))
}

// ---------------------------------------------------------------------------
// Hazard feed helpers
// ---------------------------------------------------------------------------

fn to_sos_hazard(record: &Value) -> Option<Value> {
    let row = record.as_object()?;
    let hazard_id = row
        .get("hazard_id")
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if hazard_id.is_empty() {
        return None;
    }
    let published_at = row
        .get("published_at")
        .and_then(Value::as_str)
        .filter(|value| domain::filters::parse_timestamp(value).is_some())
        .or_else(|| row.get("fetched_at").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(crate::now_iso);
    let fetched_at = row
        .get("fetched_at")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| published_at.clone());
    let source = if row
        .get("source")
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case("vndms"))
        .unwrap_or(false)
    {
        "vndms"
    } else {
        "nchmf"
    };
    let provinces: Vec<String> = row
        .get("provinces")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .take(24)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let event_type = row
        .get("event_type")
        .and_then(Value::as_str)
        .unwrap_or("other");
    let event_type = if [
        "flood",
        "storm",
        "rain",
        "landslide",
        "fire",
        "earthquake",
        "outage",
        "pollution",
        "drought",
        "traffic",
        "epidemic",
        "heat",
        "cold",
        "other",
    ]
    .contains(&event_type)
    {
        event_type
    } else {
        "other"
    };
    let severity = row
        .get("severity")
        .and_then(Value::as_str)
        .unwrap_or("medium");
    let severity = if ["low", "medium", "high", "critical"].contains(&severity) {
        severity
    } else {
        "medium"
    };
    // Never fabricate coordinates. A feed warning without a usable Point
    // (polygon/circle warnings, province-wide alerts) stays in the list APIs
    // with `location_unknown: true` and no geometry, so maps and geo/near
    // exclude it instead of drawing it at an invented authoritative spot.
    let geometry = row
        .get("geometry")
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("Point"))
        .cloned();
    let location_unknown = geometry.is_none();
    let id = format!(
        "synapsedx-{}",
        row.get("id")
            .and_then(Value::as_str)
            .unwrap_or(&hazard_id)
            .chars()
            .map(
                |ch| if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                    ch
                } else {
                    '-'
                }
            )
            .take(160)
            .collect::<String>()
    );
    let mut record = json!({
        "id": id,
        "hazard_id": hazard_id,
        "title": row.get("title").and_then(Value::as_str).unwrap_or("Cảnh báo khí tượng thủy văn"),
        "description": row.get("description").and_then(Value::as_str).unwrap_or(""),
        "event_type": event_type,
        "severity": severity,
        "source": source,
        "status": "active",
        "is_active": row.get("is_active").and_then(Value::as_bool).unwrap_or(true),
        "location_unknown": location_unknown,
        "provinces": provinces,
        "district": provinces.first(),
        "url": row.get("url"),
        "published_at": published_at,
        "observed_at": published_at,
        "detected_at": fetched_at,
        "last_seen_at": fetched_at,
        "created_at": published_at,
        "updated_at": fetched_at,
        "metadata": {
            "tier2": true,
            "feed": "kttv",
            "source": source,
            "provinces": provinces,
            "url": row.get("url"),
            "published_at": published_at,
            "fetched_at": fetched_at,
        },
        "linked_event_id": null,
        "linked_eop_plan_id": null,
    });
    if let Some(geometry) = geometry {
        record["geometry"] = geometry;
    }
    Some(record)
}

async fn fetch_tier2_hazards_with_state(
    state: &AppState,
    opts: &RequestOptions,
    hours: i64,
    limit: i64,
) -> Vec<Value> {
    let hours = hours.clamp(1, 168);
    {
        let cache = state
            .hazard_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((at, value)) = cache.get(&hours) {
            if at.elapsed() < Duration::from_secs(30) {
                return value.clone();
            }
        }
    }
    let result = state
        .tier2
        .hazards()
        .today(Some(hours), Some(limit.clamp(1, 500)), opts)
        .await;
    let attempted_at = crate::now_iso();
    let values: Vec<Value> = match result {
        Ok(feed) => {
            let values: Vec<Value> = feed
                .get("hazards")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(to_sos_hazard).collect())
                .unwrap_or_default();
            let mut status = state
                .hazard_feed_status
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            status.last_attempt_at = Some(attempted_at.clone());
            status.last_success_at = Some(attempted_at);
            status.last_error = None;
            values
        }
        Err(error) => {
            let mut status = state
                .hazard_feed_status
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            status.last_attempt_at = Some(attempted_at);
            status.last_error = Some(error.to_string());
            let cache = state
                .hazard_cache
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            return cache
                .get(&hours)
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
        }
    };
    let mut cache = state
        .hazard_cache
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    cache.insert(hours, (std::time::Instant::now(), values.clone()));
    values
}

async fn fetch_tier2_hazards(ctx: &Ctx<'_>, hours: i64, limit: i64) -> Vec<Value> {
    let opts = ctx.opts();
    fetch_tier2_hazards_with_state(ctx.state, &opts, hours, limit).await
}

fn merge_hazard_feed(stored: Vec<Value>, feed: Vec<Value>) -> Vec<Value> {
    let mut merged: Map<String, Value> = Map::new();
    for row in stored {
        let key = row
            .get("hazard_id")
            .or_else(|| row.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        merged.insert(key, row);
    }
    for row in feed {
        let key = row
            .get("hazard_id")
            .or_else(|| row.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        merged.insert(key, row);
    }
    merged.into_values().collect()
}

async fn all_hazards_with_feed(ctx: &Ctx<'_>, hours: i64) -> ApiResult<AllRows> {
    let opts = ctx.opts();
    let stored = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::HAZARDS,
        ctx.config().max_scan_records,
    )
    .await?;
    let feed = fetch_tier2_hazards(ctx, hours, 200).await;
    let items = merge_hazard_feed(stored.items.into_iter().map(Value::Object).collect(), feed);
    let scanned = items.len();
    Ok(AllRows {
        items: items
            .into_iter()
            .filter_map(|value| value.as_object().cloned())
            .collect(),
        scanned,
        truncated: stored.truncated,
    })
}

async fn public_hazards_with_feed_state(
    state: &AppState,
    opts: &RequestOptions,
    hours: i64,
) -> ApiResult<Vec<Value>> {
    {
        let cache = state
            .public_hazards_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((at, items)) = cache.get(&hours) {
            if at.elapsed() < Duration::from_secs(15) {
                return Ok(items.clone());
            }
        }
    }
    let stored = tier2::list_all_public(
        &state.tier2,
        opts,
        tier2::HAZARDS,
        state.config.max_scan_records,
    )
    .await?;
    let feed = fetch_tier2_hazards_with_state(state, opts, hours, 200).await;
    let merged = merge_hazard_feed(stored.items.into_iter().map(Value::Object).collect(), feed);
    let mut cache = state
        .public_hazards_cache
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    cache.insert(hours, (std::time::Instant::now(), merged.clone()));
    Ok(merged)
}

async fn public_hazards_with_feed(ctx: &Ctx<'_>, hours: i64) -> ApiResult<Vec<Value>> {
    let opts = ctx.opts();
    public_hazards_with_feed_state(ctx.state, &opts, hours).await
}

async fn hazards_recent(ctx: Ctx<'_>) -> ApiResult<Response> {
    let hours = ctx
        .query
        .get("hours")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(24)
        .clamp(1, 24 * 365);
    let cutoff = chrono::Utc::now().timestamp_millis() - hours * 3_600_000;
    let items = public_hazards_with_feed(&ctx, hours).await?;
    let values: Vec<Value> = items
        .into_iter()
        .filter(|hazard| {
            hazard.get("is_active").and_then(Value::as_bool) != Some(false)
                && hazard.get("status").and_then(Value::as_str) != Some("expired")
        })
        .filter(|hazard| {
            hazard
                .get("observed_at")
                .or_else(|| hazard.get("created_at"))
                .and_then(Value::as_str)
                .and_then(domain::filters::parse_timestamp)
                .map(|stamp| stamp >= cutoff)
                .unwrap_or(false)
        })
        .map(|mut hazard| {
            if let Some(object) = hazard.as_object_mut() {
                object.entry("linked_event_id").or_insert(Value::Null);
                object.entry("linked_eop_plan_id").or_insert(Value::Null);
            }
            hazard
        })
        .collect();
    Ok(json_array(paginate(values, ctx.query, 200)))
}

async fn hazards_vndms_live(ctx: Ctx<'_>) -> ApiResult<Response> {
    let items = public_hazards_with_feed(&ctx, 72).await?;
    let values: Vec<Value> = items
        .into_iter()
        .filter(|hazard| {
            let row = hazard.as_object().cloned().unwrap_or_default();
            domain::vndms::is_vndms_record(&row)
                && hazard.get("is_active").and_then(Value::as_bool) != Some(false)
                && hazard.get("status").and_then(Value::as_str) != Some("expired")
        })
        .filter_map(|hazard| {
            let row = hazard.as_object().cloned().unwrap_or_default();
            domain::vndms::to_vndms_hazard(&row).and_then(|value| serde_json::to_value(value).ok())
        })
        .collect();
    Ok(json_array(paginate(values, ctx.query, 200)))
}

/// Ask Tier-2 for spatially filtered SOS hazard records before falling back to
/// the bounded in-process scan. The dataset/geometry binding stays server-side.
async fn spatial_hazard_rows(ctx: &Ctx<'_>, mut body: Value) -> Option<Vec<Map<String, Value>>> {
    body["limit"] = json!(500);
    let opts = ctx.opts();
    let response = ctx
        .client()
        .post(
            "/v1/capabilities/datasets/sos-hazard-layers/records/spatial",
            body,
            &opts,
        )
        .await
        .ok()?;
    let items = response.get("items")?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| item.get("data")?.as_object().cloned())
            .collect(),
    )
}

async fn hazards_near(ctx: Ctx<'_>) -> ApiResult<Response> {
    let data = query_data(ctx.query);
    let near = domain::geo::parse_near_query(&data).map_err(domain_error)?;
    let candidates = match spatial_hazard_rows(
        &ctx,
        json!({
            "mode": "near",
            "lat": near.lat,
            "lng": near.lng,
            "radiusMeters": near.radius_m,
        }),
    )
    .await
    {
        Some(rows) => rows,
        None => all_hazards_with_feed(&ctx, 72).await?.items,
    };
    let result = domain::geo::near_hazards(&maps_to_data(&candidates), &near);
    let items = data_to_values(result.items);
    Ok(web::json_response(json!({
        "items": items,
        "total": result.total,
        "limit": result.limit,
        "offset": result.offset,
        "radius_m": result.radius_m,
    })))
}

async fn hazards_polygon(ctx: Ctx<'_>) -> ApiResult<Response> {
    let polygon = ctx
        .body
        .get("polygon")
        .or_else(|| ctx.body.get("geometry"))
        .cloned()
        .unwrap_or_else(|| Value::Object(ctx.body.clone()));
    let area = domain::geo::validate_polygon(&polygon).map_err(domain_error)?;
    let limit = ctx
        .body
        .get("limit")
        .and_then(Value::as_f64)
        .unwrap_or(200.0)
        .clamp(1.0, 500.0) as usize;
    let offset = ctx
        .body
        .get("skip")
        .or_else(|| ctx.body.get("offset"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0) as usize;
    let candidates = match spatial_hazard_rows(
        &ctx,
        json!({
            "mode": "within",
            "geometry": polygon,
        }),
    )
    .await
    {
        Some(rows) => rows,
        None => all_hazards_with_feed(&ctx, 72).await?.items,
    };
    let result = domain::geo::in_polygon_hazards(&maps_to_data(&candidates), &area, limit, offset);
    Ok(web::json_response(json!({
        "items": data_to_values(result.items),
        "total": result.total,
        "limit": result.limit,
        "offset": result.offset,
    })))
}

async fn hazards_list(ctx: Ctx<'_>) -> ApiResult<Response> {
    let rows = all_hazards_with_feed(&ctx, 72).await?;
    let filtered = domain::filters::filter_rows(
        &maps_to_data(&rows.items),
        &query_data(ctx.query),
        chrono::Utc::now().timestamp_millis(),
    );
    let values = data_to_values(paginate(filtered, ctx.query, 100));
    let mut response = json_array(values);
    if rows.truncated {
        response
            .headers_mut()
            .insert("x-sos-scan-truncated", HeaderValue::from_static("true"));
    }
    response.headers_mut().insert(
        "x-sos-records-scanned",
        HeaderValue::from_str(&rows.scanned.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=30"),
    );
    Ok(response)
}

async fn hazard_create(ctx: Ctx<'_>) -> ApiResult<Response> {
    if ctx
        .body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
        || ctx
            .body
            .get("event_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
    {
        return Err(ApiError::bad_request(
            "title_and_event_type_required",
            "title and event_type are required",
        ));
    }
    let mut input = ctx.body.clone();
    input.entry("is_active").or_insert_with(|| json!(true));
    input.entry("status").or_insert_with(|| json!("active"));
    input.entry("severity").or_insert_with(|| json!("medium"));
    input.entry("source").or_insert_with(|| json!("manual"));
    input.entry("metadata").or_insert_with(|| json!({}));
    input.entry("linked_event_id").or_insert(Value::Null);
    input.entry("linked_eop_plan_id").or_insert(Value::Null);
    let opts = ctx.opts();
    let row = tier2::write(ctx.client(), &opts, tier2::HAZARDS, input, None).await?;
    Ok(web::created(Value::Object(row)))
}

async fn latest_ingest_run(ctx: &Ctx<'_>) -> Option<Map<String, Value>> {
    {
        let cache = ctx
            .state
            .ingest_run_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(15) {
                return value.clone();
            }
        }
    }
    let opts = ctx.opts();
    let rows = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::HAZARD_RUNS,
        ctx.config().max_scan_records,
    )
    .await
    .ok()?;
    let mut items = rows.items;
    items.sort_by_key(|run| {
        run.get("finished_at")
            .or_else(|| run.get("created_at"))
            .and_then(Value::as_str)
            .and_then(domain::filters::parse_timestamp)
            .unwrap_or(0)
    });
    let latest = items.pop();
    let mut cache = ctx
        .state
        .ingest_run_cache
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *cache = Some((std::time::Instant::now(), latest.clone()));
    latest
}

/// Project the VNDMS connector state from the Tier-2 scheduled-jobs API.
///
/// SOS does not own a scheduler: it reads the job definition and its run
/// history (`jobs`, `jobs/:id/runs`) through the same Tier-2 client as every
/// other capability. An unavailable jobs API is reported precisely
/// (tier2_jobs_* error codes), never as an "enabled" connector.
async fn vndms_connector_status(ctx: &Ctx<'_>) -> domain::vndms::IngestConnectorStatus {
    {
        let cache = ctx
            .state
            .connector_status_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(15) {
                return value.clone();
            }
        }
    }
    let checked_at = crate::now_iso();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let opts = ctx.opts();
    let status = match ctx.client().jobs().list(Some(100), Some(0), &opts).await {
        Ok(page) => {
            let items = page
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            match items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .find(|job| domain::vndms::is_vndms_connector_job(job))
            {
                None => domain::vndms::connector_not_configured(Some(&checked_at)),
                Some(job) => {
                    let job_id = job
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    match ctx.client().jobs().runs(&job_id, Some(20), Some(0), &opts).await {
                        Ok(runs_page) => {
                            let runs: Vec<Map<String, Value>> = runs_page
                                .get("items")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default()
                                .iter()
                                .filter_map(|run| run.as_object().cloned())
                                .collect();
                            domain::vndms::connector_status_from_runs(&job, &runs, now_ms)
                        }
                        Err(_) => {
                            // The job exists but its run history is
                            // unreadable: surface the gap, do not guess.
                            let mut partial =
                                domain::vndms::connector_status_from_runs(&job, &[], now_ms);
                            partial.error = Some("tier2_job_runs_unavailable".into());
                            partial
                        }
                    }
                }
            }
        }
        Err(error) => {
            let domain_error = domain::DomainError::new(
                error.status().unwrap_or(503),
                error.code().unwrap_or("tier2_unreachable"),
                String::new(),
                None,
            );
            domain::vndms::connector_unavailable(Some(&domain_error), Some(&checked_at))
        }
    };
    let mut cache = ctx
        .state
        .connector_status_cache
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *cache = Some((std::time::Instant::now(), status.clone()));
    status
}

async fn compute_ingest_status(ctx: &Ctx<'_>) -> domain::vndms::IngestStatus {
    let latest = latest_ingest_run(ctx).await;
    let connector = vndms_connector_status(ctx).await;
    let latest_data = latest.as_ref().map(|row| to_data(row));
    domain::vndms::ingest_status_from_run_with_stale(
        latest_data.as_ref(),
        chrono::Utc::now().timestamp_millis(),
        Some(&connector),
        Some(ctx.config().vndms_stale_minutes as f64),
    )
}

async fn ingest_status(ctx: Ctx<'_>) -> ApiResult<Response> {
    let status = compute_ingest_status(&ctx).await;
    Ok(web::json_response(
        serde_json::to_value(status).unwrap_or(Value::Null),
    ))
}

async fn hazards_ingest(ctx: Ctx<'_>) -> ApiResult<Response> {
    let batch = domain::vndms::normalize_ingest_batch(&Value::Object(ctx.body.clone()), None)
        .map_err(domain_error)?;
    if batch.accepted.is_empty() && batch.rejected.is_empty() {
        return Err(ApiError::bad_request(
            "empty_ingest_batch",
            "The ingest batch is empty.",
        ));
    }
    let opts = ctx.opts();
    let existing = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::HAZARDS,
        ctx.config().max_scan_records,
    )
    .await?;
    let mut by_hazard_id: HashMap<String, Map<String, Value>> = existing
        .items
        .into_iter()
        .map(|row| {
            let key = row
                .get("hazard_id")
                .or_else(|| row.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            (key, row)
        })
        .collect();
    let mut ingested = 0usize;
    for entry in &batch.accepted {
        let hazard_id = entry
            .hazard
            .get("hazard_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let stable_id = format!("vndms-{hazard_id}")
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                    ch
                } else {
                    '-'
                }
            })
            .take(180)
            .collect::<String>();
        let current = by_hazard_id.get(&hazard_id).cloned();
        let record_id = current
            .as_ref()
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(stable_id);
        let mut merged = current.clone().unwrap_or_default();
        for (key, value) in &entry.hazard {
            merged.insert(key.clone(), value.clone());
        }
        merged.insert("id".into(), json!(record_id));
        merged.entry("linked_event_id").or_insert(Value::Null);
        merged.entry("linked_eop_plan_id").or_insert(Value::Null);
        let saved = if let Some(current) = current {
            let version = current.get("record_version").and_then(Value::as_i64);
            tier2::update(
                ctx.client(),
                &opts,
                tier2::HAZARDS,
                &record_id,
                merged,
                version,
            )
            .await?
        } else {
            tier2::write(
                ctx.client(),
                &opts,
                tier2::HAZARDS,
                merged,
                Some(&record_id),
            )
            .await?
        };
        by_hazard_id.insert(hazard_id, saved);
        ingested += 1;
    }
    let run = json!({
        "source": "vndms",
        "started_at": web::string_value(ctx.body.get("started_at")).unwrap_or_else(crate::now_iso),
        "finished_at": crate::now_iso(),
        "status": if batch.rejected.is_empty() { "succeeded" } else { "partial" },
        "records_received": batch.accepted.len() + batch.rejected.len(),
        "records_ingested": ingested,
        "records_rejected": batch.rejected.len(),
        "error": if batch.rejected.is_empty() { Value::Null } else { json!(format!("{} record(s) rejected", batch.rejected.len())) },
        "feed_version": ctx.body.get("feed_version").cloned().unwrap_or(Value::Null),
        "rejected": serde_json::to_value(&batch.rejected).unwrap_or(Value::Null),
    });
    let stored = tier2::write(
        ctx.client(),
        &opts,
        tier2::HAZARD_RUNS,
        run.as_object().cloned().unwrap_or_default(),
        None,
    )
    .await?;
    Ok(web::created(json!({
        "run": stored,
        "ingested": ingested,
        "rejected": batch.rejected,
    })))
}

async fn hazards_expire(ctx: Ctx<'_>) -> ApiResult<Response> {
    let ttl = domain::hazards::hazard_ttl_hours(ctx.body.get("ttl_hours"));
    let now = chrono::Utc::now().timestamp_millis();
    let opts = ctx.opts();
    let rows = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::HAZARDS,
        ctx.config().max_scan_records,
    )
    .await?;
    let mut updated = 0usize;
    for hazard in rows.items {
        let data = to_data(&hazard);
        if !domain::hazards::is_hazard_stale(&data, now, Some(ttl)) {
            continue;
        }
        let id = hazard
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let version = hazard.get("record_version").and_then(Value::as_i64);
        let mut patch = Map::new();
        patch.insert("is_active".into(), json!(false));
        patch.insert("status".into(), json!("expired"));
        patch.insert("expired_at".into(), json!(crate::now_iso()));
        let _ = tier2::update(ctx.client(), &opts, tier2::HAZARDS, &id, patch, version).await?;
        updated += 1;
    }
    Ok(web::json_response(json!({
        "scanned": rows.scanned,
        "updated": updated,
        "truncated": rows.truncated,
    })))
}

/// Explicit hazard lifecycle transition. The generic PUT cannot change
/// `status`/`is_active`; this route enforces the state machine and records the
/// audit trail.
async fn hazard_status(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let next = web::string_value(ctx.body.get("status"))
        .ok_or_else(|| ApiError::bad_request("status_required", "status is required"))?
        .to_ascii_lowercase();
    let allowed_from: &[&str] = match next.as_str() {
        "active" => &["monitoring"],
        "monitoring" => &["active"],
        "expired" => &["active", "monitoring"],
        "resolved" => &["active", "monitoring"],
        _ => {
            return Err(ApiError::bad_request(
                "invalid_hazard_status",
                "status must be active, monitoring, expired or resolved",
            ))
        }
    };
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::HAZARDS, id).await?;
    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
    if status == next {
        let mut response = current;
        response.insert("idempotent".into(), json!(true));
        return Ok(web::json_response(Value::Object(response)));
    }
    if !allowed_from.contains(&status) {
        return Err(ApiError::conflict(
            "invalid_hazard_transition",
            format!("cannot move hazard {id} from {status} to {next}"),
        )
        .with_details(json!({ "allowedFrom": allowed_from, "current": status })));
    }
    let now = crate::now_iso();
    let mut history = current
        .get("status_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    history.push(json!({
        "from": status,
        "to": next.clone(),
        "at": now.clone(),
        "by": ctx.actor().unwrap_or_else(|| "sos-operator".into()),
        "note": ctx.body.get("note").cloned().unwrap_or(Value::Null),
    }));
    let mut patch = Map::new();
    patch.insert("is_active".into(), json!(next == "active"));
    patch.insert("status".into(), json!(next));
    patch.insert("status_changed_at".into(), json!(now));
    patch.insert("status_history".into(), Value::Array(history));
    if next == "expired" {
        patch.insert("expired_at".into(), json!(crate::now_iso()));
    }
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?
        .or_else(|| current.get("record_version").and_then(Value::as_i64));
    let row = tier2::update(ctx.client(), &opts, tier2::HAZARDS, id, patch, version).await?;
    Ok(web::send_record(row))
}

async fn hazard_deploy(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let hazard = tier2::get(ctx.client(), &opts, tier2::HAZARDS, id).await?;
    let event_id = format!("event-{id}")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                ch
            } else {
                '-'
            }
        })
        .take(180)
        .collect::<String>();
    let linked_event_id = hazard
        .get("linked_event_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| event_id.clone());
    let mut event_existed = true;
    let event = match tier2::get(ctx.client(), &opts, tier2::EVENTS, &linked_event_id).await {
        Ok(event) => event,
        Err(error) if error.status == StatusCode::NOT_FOUND => {
            event_existed = false;
            let event_input = json!({
                "id": linked_event_id,
                "title": hazard.get("title"),
                "description": hazard.get("description"),
                "event_type": hazard.get("event_type"),
                "severity": hazard.get("severity"),
                "source": "forecast",
                "status": "active",
                "started_at": crate::now_iso(),
                "location": { "district": hazard.get("district"), "ward": hazard.get("ward") },
                "geometry": hazard.get("geometry"),
                "affected_asset_ids": [],
                "estimated_impact": {},
                "instructions": [],
                "tags": [],
                "metadata": { "hazard_id": hazard.get("hazard_id").or_else(|| hazard.get("id")) },
                "created_by": ctx.actor(),
            });
            match tier2::write(
                ctx.client(),
                &opts,
                tier2::EVENTS,
                event_input.as_object().cloned().unwrap_or_default(),
                Some(&linked_event_id),
            )
            .await
            {
                Ok(event) => event,
                Err(error) if error.code == "record_exists" => {
                    tier2::get(ctx.client(), &opts, tier2::EVENTS, &linked_event_id).await?
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    let linked_plan_id = hazard
        .get("linked_eop_plan_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut plan = match linked_plan_id.as_deref() {
        Some(plan_id) => match tier2::get(ctx.client(), &opts, tier2::EOP, plan_id).await {
            Ok(plan) => Some(plan),
            Err(error) if error.status == StatusCode::NOT_FOUND => None,
            Err(error) => return Err(error),
        },
        None => find_plans_for_event(&ctx, &linked_event_id).await.pop(),
    };
    let mut generated = false;
    if plan.is_none() {
        let correlation = ctx
            .headers
            .get("x-correlation-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let (created, _) = create_eop_version(
            &ctx,
            &event,
            1,
            hazard
                .get("title")
                .and_then(Value::as_str)
                .map(|title| format!("EOP — {title}")),
            Some("Generated automatically when the hazard was deployed.".into()),
            true,
            correlation,
        )
        .await?;
        plan = Some(created);
        generated = true;
    }
    let plan = plan
        .ok_or_else(|| ApiError::internal("hazard deploy could not create or find an EOP draft"))?;
    let plan_id = plan.get("id").cloned().unwrap_or(Value::Null);
    let mut patch = Map::new();
    patch.insert(
        "linked_event_id".into(),
        event.get("id").cloned().unwrap_or(Value::Null),
    );
    patch.insert("linked_eop_plan_id".into(), plan_id.clone());
    let version = hazard.get("record_version").and_then(Value::as_i64);
    let updated = tier2::update(ctx.client(), &opts, tier2::HAZARDS, id, patch, version).await?;
    let markdown = plan.get("markdown_body").cloned().unwrap_or(Value::Null);
    Ok(web::json_response(json!({
        "hazard_id": updated.get("id"),
        "event_id": event.get("id"),
        "eop_plan_id": plan_id,
        "markdown_body": markdown,
        "hazard": updated,
        "event": event,
        "eop_plan": plan,
        "idempotent": event_existed && !generated,
        "generated": generated,
    })))
}

/// Snapshot frame shared by the initial read, the Tier-2 event trigger and the
/// bounded fallback. It always uses the merged public hazard view and retains
/// the last good payload across dependency errors.
async fn hazard_snapshot_frame(state: &AppState, opts: &RequestOptions, source: &str) -> String {
    match public_hazards_with_feed_state(state, opts, 72).await {
        Ok(snapshot) => {
            let at = crate::now_iso();
            {
                let mut last_good = state
                    .hazard_last_good
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                *last_good = Some((at.clone(), snapshot.clone()));
            }
            domain::hazards::sse_hazards_frame(
                &json!({
                    "snapshot": snapshot,
                    "records_visible": snapshot.len(),
                    "degraded": false,
                    "last_good_at": at,
                    "transport": match source {
                        "sse" => "sse-trigger",
                        "fallback" => "snapshot-fallback",
                        _ => "snapshot-initial",
                    },
                    "source": source,
                }),
                None,
            )
        }
        Err(error) => {
            let last_good = state
                .hazard_last_good
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone();
            domain::hazards::sse_error_frame(
                &json!({
                    "error": "hazard_stream_degraded",
                    "message": "Hazard data is temporarily unavailable.",
                    "retry_ms": 5000,
                    "last_good_at": last_good.as_ref().map(|(at, _)| at),
                    "has_snapshot": last_good.is_some(),
                    "snapshot": last_good.as_ref().map(|(_, items)| items),
                    "transport": "snapshot-error",
                    "detail": error.to_string(),
                }),
                None,
            )
        }
    }
}

async fn broadcast_hazard_snapshot(
    state: &AppState,
    opts: &RequestOptions,
    tx: &tokio::sync::broadcast::Sender<String>,
    source: &str,
) {
    let frame = hazard_snapshot_frame(state, opts, source).await;
    let _ = tx.send(frame);
}

/// One Tier-2 subscription per process, shared by every SSE client. The
/// watcher exits after a short grace period when no subscribers remain, so a
/// disconnected client cannot leave an upstream stream alive forever.
async fn watch_tier2_hazard_events(state: AppState, tx: tokio::sync::broadcast::Sender<String>) {
    let Some(api_key) = state
        .config
        .tier2_api_key
        .clone()
        .or_else(|| state.config.tier2_token.clone())
    else {
        state
            .hazard_watcher_active
            .store(false, std::sync::atomic::Ordering::SeqCst);
        return;
    };
    let opts = tier2::request_options_from(
        state.config.tier2_api_key.as_deref(),
        state.config.tier2_token.as_deref(),
        None,
        None,
    );
    let url = format!(
        "{}/v1/capabilities/events/stream",
        state.config.tier2_url.trim_end_matches('/')
    );
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            state
                .hazard_watcher_active
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        }
    };
    loop {
        if tx.receiver_count() == 0 {
            // A short grace window avoids a start/stop race for a client that
            // reconnects immediately after a network blip.
            tokio::time::sleep(Duration::from_secs(5)).await;
            if tx.receiver_count() == 0 {
                state
                    .hazard_watcher_active
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        }
        let mut request = client
            .get(&url)
            .header("accept", "text/event-stream")
            .header("cache-control", "no-cache");
        request = if state.config.tier2_api_key.is_some() {
            request.header("x-api-key", &api_key)
        } else {
            request.header("authorization", format!("Bearer {api_key}"))
        };
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                let mut body = response.bytes_stream();
                let mut buffer: Vec<u8> = Vec::new();
                let fallback_period = Duration::from_millis(state.config.stream_poll_ms);
                let mut fallback = tokio::time::interval_at(
                    tokio::time::Instant::now() + fallback_period,
                    fallback_period,
                );
                fallback.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = fallback.tick() => {
                            broadcast_hazard_snapshot(&state, &opts, &tx, "fallback").await;
                        }
                        chunk = body.next() => {
                            let Some(Ok(chunk)) = chunk else { break };
                            buffer.extend_from_slice(&chunk);
                            let mut changed = false;
                            while let Some(position) = buffer.windows(2).position(|pair| pair == b"\n\n") {
                                let frame = String::from_utf8_lossy(&buffer[..position]).to_string();
                                buffer.drain(..position + 2);
                                if frame.lines().any(|line| line.trim() == "event: capability") {
                                    changed = true;
                                }
                            }
                            if changed {
                                // The event is only a wake-up; the payload is
                                // always the authoritative merged snapshot.
                                broadcast_hazard_snapshot(&state, &opts, &tx, "sse").await;
                            }
                        }
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {
                            if tx.receiver_count() == 0 {
                                break;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        if tx.receiver_count() == 0 {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if tx.receiver_count() == 0 {
                state
                    .hazard_watcher_active
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn ensure_hazard_watcher(state: &AppState) {
    if state
        .hazard_watcher_active
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_ok()
    {
        let state = state.clone();
        let tx = state.hazard_stream_tx.clone();
        tokio::spawn(watch_tier2_hazard_events(state, tx));
    }
}

async fn hazard_stream(ctx: Ctx<'_>) -> ApiResult<Response> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    let state = ctx.state.clone();
    let headers = ctx.headers.clone();
    let session = ctx.session.cloned();
    let opts = tier2::request_options(&state.config, &headers, session.as_ref());
    let mut broadcast = state.hazard_stream_tx.subscribe();
    tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        let _ = tx
            .send(Ok(Bytes::from(": connected\n\nretry: 5000\n\n")))
            .await;
        // Initial snapshot is immediate; the shared watcher then broadcasts
        // only event-driven reads plus a 30 s fallback.
        let initial = hazard_snapshot_frame(&state, &opts, "initial").await;
        if tx.send(Ok(Bytes::from(initial))).await.is_err() {
            return;
        }
        ensure_hazard_watcher(&state).await;
        loop {
            tokio::select! {
                frame = broadcast.recv() => {
                    match frame {
                        Ok(frame) => {
                            if tx.send(Ok(Bytes::from(frame))).await.is_err() {
                                return;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
                _ = heartbeat.tick() => {
                    let frame = domain::hazards::sse_heartbeat_frame(None);
                    if tx.send(Ok(Bytes::from(frame))).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let body = axum::body::Body::from_stream(stream);
    let mut response = Response::new(body);
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/event-stream"),
    );
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("no-cache, no-transform"),
    );
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

// ---------------------------------------------------------------------------
// Geo / map / AI
// ---------------------------------------------------------------------------

async fn geo_search(ctx: Ctx<'_>) -> ApiResult<Response> {
    let query = ctx.query.get("q").cloned().unwrap_or_default();
    if query.trim().len() < 2 {
        return Ok(json_array(Vec::new()));
    }
    let opts = ctx.opts();
    let items = ctx
        .client()
        .geo()
        .autocomplete(&query, Some(5), None, &opts)
        .await
        .map_err(ApiError::from)?;
    let values: Vec<Value> = items
        .into_iter()
        .filter_map(|item| {
            let lat = item.get("lat").and_then(Value::as_f64);
            let lon = item.get("lon").and_then(Value::as_f64);
            Some(json!({
                "address": item.get("address").or_else(|| item.get("label")).or_else(|| item.get("display")).and_then(Value::as_str).unwrap_or(&query),
                "coordinates": { "latitude": lat?, "longitude": lon? },
                "city": item.get("raw").and_then(|value| value.get("city")).and_then(Value::as_str).unwrap_or(""),
                "country": item.get("raw").and_then(|value| value.get("country")).and_then(Value::as_str).unwrap_or("Vietnam"),
                "ref_id": item.get("id").or_else(|| item.get("ref_id")),
                "provider": "synapsedx",
            }))
        })
        .collect();
    Ok(json_array(values))
}

async fn geo_geocode(ctx: Ctx<'_>) -> ApiResult<Response> {
    let text = web::string_value(ctx.body.get("address")).unwrap_or_default();
    if text.is_empty() {
        return Err(ApiError::bad_request(
            "address_required",
            "address is required",
        ));
    }
    let opts = ctx.opts();
    let items = ctx
        .client()
        .geo()
        .geocode(&text, &opts)
        .await
        .map_err(ApiError::from)?;
    let hit = items.into_iter().find(|item| {
        item.get("lat").and_then(Value::as_f64).is_some()
            && item.get("lon").and_then(Value::as_f64).is_some()
    });
    let Some(hit) = hit else {
        return Err(ApiError::not_found(
            "address_not_found",
            "Address was not found.",
        ));
    };
    let lat = hit.get("lat").and_then(Value::as_f64).unwrap_or(0.0);
    let lon = hit.get("lon").and_then(Value::as_f64).unwrap_or(0.0);
    Ok(web::json_response(json!({
        "coordinates": { "latitude": lat, "longitude": lon },
        "geojson": { "type": "Point", "coordinates": [lon, lat] },
        "display_name": hit.get("address").or_else(|| hit.get("label")).and_then(Value::as_str).unwrap_or(&text),
        "provider": "synapsedx",
    })))
}

async fn geo_reverse(ctx: Ctx<'_>) -> ApiResult<Response> {
    let latitude = web::string_value(ctx.body.get("latitude"))
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| ctx.body.get("latitude").and_then(Value::as_f64));
    let longitude = web::string_value(ctx.body.get("longitude"))
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| ctx.body.get("longitude").and_then(Value::as_f64));
    let (Some(latitude), Some(longitude)) = (latitude, longitude) else {
        return Err(ApiError::bad_request(
            "coordinates_required",
            "latitude and longitude are required",
        ));
    };
    let opts = ctx.opts();
    let items = ctx
        .client()
        .geo()
        .reverse(latitude, longitude, &opts)
        .await
        .map_err(ApiError::from)?;
    let hit = items.into_iter().find(|item| {
        item.get("address")
            .or_else(|| item.get("label"))
            .or_else(|| item.get("display"))
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    });
    let Some(hit) = hit else {
        return Err(ApiError::not_found(
            "address_not_found",
            "Address was not found.",
        ));
    };
    Ok(web::json_response(json!({
        "address": hit.get("address").or_else(|| hit.get("label")).or_else(|| hit.get("display")).and_then(Value::as_str).unwrap_or(""),
        "city": hit.get("raw").and_then(|value| value.get("city")).and_then(Value::as_str).unwrap_or(""),
        "country": hit.get("raw").and_then(|value| value.get("country")).and_then(Value::as_str).unwrap_or("Vietnam"),
        "provider": "synapsedx",
    })))
}

async fn map_tile(ctx: Ctx<'_>, z: &str, x: &str, y: &str) -> ApiResult<Response> {
    let Some(api_key) = ctx
        .config()
        .tier2_api_key
        .clone()
        .or_else(|| ctx.config().tier2_token.clone())
    else {
        return Ok(web::status_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "map_tiles_unavailable", "dependency": "synapsedx" }),
        ));
    };
    let y = y.strip_suffix(".png").unwrap_or(y);
    let url = format!(
        "{}/v1/capabilities/geo/tiles/{}/{}/{}.png",
        ctx.config().tier2_url,
        z,
        x,
        y
    );
    let client = reqwest::Client::new();
    let mut request = client.get(url).header("accept", "*/*");
    request = if ctx.config().tier2_api_key.is_some() {
        request.header("x-api-key", api_key)
    } else {
        request.header("authorization", format!("Bearer {api_key}"))
    };
    match request.send().await {
        Ok(response) if response.status().is_success() => {
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            let bytes = response
                .bytes()
                .await
                .map_err(|error| ApiError::internal(error))?;
            let mut response = Response::new(axum::body::Body::from(bytes));
            response.headers_mut().insert(
                "content-type",
                HeaderValue::from_str(&content_type)
                    .unwrap_or(HeaderValue::from_static("image/png")),
            );
            response.headers_mut().insert(
                "cache-control",
                HeaderValue::from_static("public, max-age=86400, immutable"),
            );
            Ok(response)
        }
        Ok(response) => Ok(web::status_json(
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            json!({
                "error": "map_tiles_unavailable",
                "dependency": "synapsedx",
                "upstreamStatus": response.status().as_u16(),
            }),
        )),
        Err(_) => Ok(web::status_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "map_tiles_unavailable", "dependency": "synapsedx" }),
        )),
    }
}

async fn ai_status(ctx: Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let status = ai::ai_status(ctx.state, &opts).await;
    let mut response = web::json_response(json!({
        "status": if status.get("status").and_then(Value::as_str) == Some("ok") { "ok" } else { "unavailable" },
        "configured": status.get("configured"),
        "provider": status.get("provider"),
        "model": status.get("model"),
        "capability": "ai",
        "dependency": status.get("dependency"),
        "detail": status.get("detail"),
        "checked_at": status.get("checked_at"),
        "base_url": ctx.config().tier2_url,
    }));
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn ai_chat(ctx: Ctx<'_>) -> ApiResult<Response> {
    let raw_messages = if let Some(messages) = ctx.body.get("messages").and_then(Value::as_array) {
        messages.clone()
    } else if let Some(message) = ctx.body.get("message").and_then(Value::as_str) {
        vec![json!({ "role": "user", "content": message })]
    } else if let Some(prompt) = ctx.body.get("prompt").and_then(Value::as_str) {
        vec![json!({ "role": "user", "content": prompt })]
    } else {
        Vec::new()
    };
    if raw_messages.is_empty() {
        return Err(ApiError::bad_request(
            "messages_required",
            "pass messages[], message or prompt",
        ));
    }
    if raw_messages.len() > 50 {
        return Err(ApiError::bad_request(
            "too_many_messages",
            "at most 50 chat messages are accepted",
        ));
    }
    let mut messages = Vec::new();
    for (index, entry) in raw_messages.into_iter().enumerate() {
        let Some(message) = entry.as_object() else {
            return Err(ApiError::bad_request(
                "invalid_message",
                format!("messages[{index}] must be an object"),
            ));
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        if !["system", "user", "assistant"].contains(&role) {
            return Err(ApiError::bad_request(
                "invalid_message_role",
                format!("messages[{index}].role must be system|user|assistant"),
            ));
        }
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if content.is_empty() {
            return Err(ApiError::bad_request(
                "invalid_message_content",
                format!("messages[{index}].content is required"),
            ));
        }
        messages.push(json!({ "role": role, "content": content }));
    }
    let opts = ctx.opts();
    let model = web::string_value(ctx.body.get("model"));
    let temperature = ctx.body.get("temperature").and_then(Value::as_f64);
    let max_tokens = ctx
        .body
        .get("max_tokens")
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let completion = ai::ai_chat(
        ctx.state,
        &opts,
        Value::Array(messages),
        model.as_deref(),
        temperature,
        max_tokens,
    )
    .await?;
    Ok(web::json_response(json!({
        "provider": completion.provider,
        "model": completion.model,
        "content": completion.content,
        "usage": completion.usage,
    })))
}

async fn ai_brief(ctx: Ctx<'_>) -> ApiResult<Response> {
    let hours = ctx.body.get("hours").and_then(Value::as_i64).unwrap_or(24);
    let limit = ctx.body.get("limit").and_then(Value::as_i64).unwrap_or(8);
    let focus = web::string_value(ctx.body.get("focus"));
    let opts = ctx.opts();
    let result = ai::hazard_brief(ctx.state, &opts, hours, limit, focus).await?;
    let mut response = web::json_response(result);
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=60"),
    );
    Ok(response)
}

async fn ai_ask(ctx: Ctx<'_>) -> ApiResult<Response> {
    let question = web::string_value(ctx.body.get("question"))
        .or_else(|| web::string_value(ctx.body.get("q")))
        .ok_or_else(|| ApiError::bad_request("question_required", "question is required"))?;
    let opts = ctx.opts();
    let mut live_context = String::new();
    if let Ok(feed) = ctx.client().hazards().today(Some(24), Some(6), &opts).await {
        if let Some(hazards) = feed.get("hazards").and_then(Value::as_array) {
            let lines: Vec<String> = hazards
                .iter()
                .map(|hazard| {
                    let provinces = hazard
                        .get("provinces")
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    format!(
                        "- [{}] {} ({}) lúc {}",
                        hazard
                            .get("severity")
                            .and_then(Value::as_str)
                            .unwrap_or("medium"),
                        hazard.get("title").and_then(Value::as_str).unwrap_or(""),
                        if provinces.is_empty() {
                            "không xác định"
                        } else {
                            &provinces
                        },
                        hazard
                            .get("published_at")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    )
                })
                .collect();
            live_context = lines.join("\n");
        }
    }
    let top_k = ctx
        .body
        .get("topK")
        .or_else(|| ctx.body.get("top_k"))
        .and_then(Value::as_i64)
        .unwrap_or(5);
    let result = ai::knowledge_ask(
        ctx.state,
        &opts,
        &question,
        top_k,
        (!live_context.is_empty()).then_some(live_context),
    )
    .await?;
    let mut response = web::json_response(result);
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}

// ---------------------------------------------------------------------------
// EOP
// ---------------------------------------------------------------------------

async fn load_eop_inputs(
    ctx: &Ctx<'_>,
    event: &Map<String, Value>,
) -> (Vec<Map<String, Value>>, Vec<Map<String, Value>>) {
    let opts = ctx.opts();
    let hazards = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::HAZARDS,
        ctx.config().max_scan_records,
    )
    .await
    .map(|rows| rows.items)
    .unwrap_or_default();
    let resources = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::RESOURCES,
        ctx.config().max_scan_records,
    )
    .await
    .map(|rows| rows.items)
    .unwrap_or_default();
    let event_id = event.get("id").and_then(Value::as_str).unwrap_or("");
    let hazard_id = event
        .get("metadata")
        .and_then(|value| value.get("hazard_id"))
        .and_then(Value::as_str)
        .unwrap_or("\u{0}");
    let linked: Vec<Map<String, Value>> = hazards
        .into_iter()
        .filter(|hazard| {
            hazard.get("linked_event_id").and_then(Value::as_str) == Some(event_id)
                || hazard.get("hazard_id").and_then(Value::as_str) == Some(hazard_id)
        })
        .map(|hazard| to_data(&hazard))
        .collect();
    let resources = resources
        .into_iter()
        .map(|resource| to_data(&resource))
        .collect();
    (linked, resources)
}

async fn find_plans_for_event(ctx: &Ctx<'_>, event_id: &str) -> Vec<Map<String, Value>> {
    let opts = ctx.opts();
    let rows = tier2::list_all(
        ctx.client(),
        &opts,
        tier2::EOP,
        ctx.config().max_scan_records,
    )
    .await
    .map(|rows| rows.items)
    .unwrap_or_default();
    let mut plans: Vec<Map<String, Value>> = rows
        .into_iter()
        .filter(|plan| plan.get("emergency_event_id").and_then(Value::as_str) == Some(event_id))
        .collect();
    plans.sort_by_key(|plan| plan.get("version").and_then(Value::as_i64).unwrap_or(0));
    plans
}

async fn generate_eop_draft(
    ctx: &Ctx<'_>,
    context: &domain::eop::DraftContext<'_>,
    version: u32,
    allow_fallback: bool,
    correlation_id: Option<String>,
) -> ApiResult<(domain::eop::EopDraft, &'static str)> {
    let opts = ctx.opts();
    let status = ai::ai_status(ctx.state, &opts).await;
    if status.get("configured").and_then(Value::as_bool) != Some(true) {
        if !allow_fallback {
            return Err(ai::ai_unavailable(
                "The Tier-2 AI capability is not configured.",
                None,
            ));
        }
        let draft = domain::eop::build_eop_draft(context, Some(version));
        return Ok((draft, "deterministic-fallback"));
    }
    let prompt = domain::eop::build_eop_prompt(context);
    let messages: Vec<Value> = prompt
        .into_iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect();
    let completion =
        match ai::ai_chat(ctx.state, &opts, Value::Array(messages), None, None, None).await {
            Ok(completion) => completion,
            Err(error) => {
                if allow_fallback {
                    let mut draft = domain::eop::build_eop_draft(context, Some(version));
                    draft
                        .metadata
                        .insert("ai_error".into(), json!(error.message));
                    draft
                        .metadata
                        .insert("ai_error_code".into(), json!(error.code));
                    draft.markdown_body = domain::eop::render_eop_markdown(&draft, context);
                    return Ok((draft, "deterministic-fallback"));
                }
                return Err(error);
            }
        };
    let payload = ai::json_object_from(&completion.content).ok_or_else(|| {
        ApiError::bad_gateway(
            "ai_draft_invalid",
            "the AI completion was not a JSON object",
        )
    })?;
    let payload = domain::eop::AiEopPayload::from_data(&payload);
    let meta = domain::eop::AiDraftMeta {
        model: completion.model.clone(),
        prompt_version: domain::eop::EOP_PROMPT_VERSION.into(),
        generated_at: crate::now_iso(),
        usage: completion.usage.clone(),
        provider: Some("synapsedx".into()),
    };
    let draft = domain::eop::draft_from_ai_payload(context, version, &payload, &meta)
        .map_err(domain_error)?;
    let _ = correlation_id;
    Ok((draft, "tier2-ai"))
}

async fn create_eop_version(
    ctx: &Ctx<'_>,
    event: &Map<String, Value>,
    version: u32,
    title: Option<String>,
    additional_context: Option<String>,
    allow_fallback: bool,
    correlation_id: Option<String>,
) -> ApiResult<(Map<String, Value>, String)> {
    let (hazards, resources) = load_eop_inputs(ctx, event).await;
    let event_data = to_data(event);
    let context = domain::eop::DraftContext {
        event: &event_data,
        hazards: &hazards,
        resources: &resources,
        title,
        additional_context,
        generated_at: Some(crate::now_iso()),
    };
    let id = format!(
        "eop-{}-v{version}",
        event.get("id").and_then(Value::as_str).unwrap_or("event")
    )
    .chars()
    .map(|ch| {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
            ch
        } else {
            '-'
        }
    })
    .take(180)
    .collect::<String>();
    let opts = ctx.opts();
    if let Ok(existing) = tier2::get(ctx.client(), &opts, tier2::EOP, &id).await {
        let source = existing
            .get("metadata")
            .and_then(|value| value.get("generated_by"))
            .and_then(Value::as_str)
            .unwrap_or("stored")
            .to_string();
        return Ok((existing, source));
    }
    let (draft, source) =
        generate_eop_draft(&ctx, &context, version, allow_fallback, correlation_id).await?;
    let draft_value = serde_json::to_value(&draft)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut input = draft_value;
    input.insert("id".into(), json!(id));
    input.insert(
        "emergency_event_id".into(),
        event.get("id").cloned().unwrap_or(Value::Null),
    );
    input.insert(
        "priority".into(),
        event
            .get("severity")
            .cloned()
            .unwrap_or_else(|| json!("medium")),
    );
    input.insert(
        "created_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let row = match tier2::write(ctx.client(), &opts, tier2::EOP, input, Some(&id)).await {
        Ok(row) => row,
        Err(error) if error.code == "record_exists" => {
            tier2::get(ctx.client(), &opts, tier2::EOP, &id).await?
        }
        Err(error) => return Err(error),
    };
    Ok((row, source.into()))
}

async fn eop_create(ctx: Ctx<'_>) -> ApiResult<Response> {
    let event_id = web::string_value(ctx.body.get("emergency_event_id")).ok_or_else(|| {
        ApiError::bad_request(
            "emergency_event_id_required",
            "emergency_event_id is required",
        )
    })?;
    let opts = ctx.opts();
    let event = tier2::get(ctx.client(), &opts, tier2::EVENTS, &event_id).await?;
    let plans = find_plans_for_event(&ctx, &event_id).await;
    let version = ctx
        .body
        .get("version")
        .and_then(Value::as_u64)
        .map(|value| value.max(1) as u32)
        .unwrap_or_else(|| {
            plans
                .iter()
                .map(|plan| plan.get("version").and_then(Value::as_i64).unwrap_or(0))
                .max()
                .unwrap_or(0) as u32
                + 1
        });
    let id = format!("eop-{event_id}-v{version}")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                ch
            } else {
                '-'
            }
        })
        .take(180)
        .collect::<String>();
    let mut input = ctx.body.clone();
    input.insert("id".into(), json!(id));
    input.insert(
        "emergency_event_id".into(),
        event.get("id").cloned().unwrap_or(Value::Null),
    );
    input.insert("version".into(), json!(version));
    input.insert("status".into(), json!("draft"));
    input.insert(
        "created_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let row = tier2::write(ctx.client(), &opts, tier2::EOP, input, Some(&id)).await?;
    Ok(web::created(Value::Object(row)))
}

async fn eop_generate(ctx: Ctx<'_>) -> ApiResult<Response> {
    let event_id = web::string_value(ctx.body.get("emergency_event_id")).ok_or_else(|| {
        ApiError::bad_request(
            "emergency_event_id_required",
            "emergency_event_id is required",
        )
    })?;
    let opts = ctx.opts();
    let event = tier2::get(ctx.client(), &opts, tier2::EVENTS, &event_id)
        .await
        .map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::not_found(
                    "emergency_event_not_found",
                    format!("no emergency event {event_id}"),
                )
            } else {
                error
            }
        })?;
    let force = web::bool_value(ctx.body.get("force_new_version")).unwrap_or(false);
    let allow_fallback = web::string_value(ctx.body.get("fallback")).as_deref()
        == Some("deterministic")
        || web::bool_value(ctx.body.get("allow_deterministic_fallback")).unwrap_or(false);
    let title = web::string_value(ctx.body.get("title"));
    let additional = web::string_value(ctx.body.get("additional_context"));
    let correlation = ctx
        .headers
        .get("x-correlation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let plans = find_plans_for_event(&ctx, &event_id).await;
    if !force {
        if let Some(latest) = plans.last() {
            let source = latest
                .get("metadata")
                .and_then(|value| value.get("generated_by"))
                .and_then(Value::as_str)
                .unwrap_or("stored");
            let mut payload = latest.clone();
            payload.insert("generated_by".into(), json!(source));
            payload.insert("generated".into(), json!(false));
            payload.insert("source".into(), json!(source));
            payload.insert("idempotent".into(), json!(true));
            return Ok(web::json_response(Value::Object(payload)));
        }
    }
    let version = plans
        .iter()
        .map(|plan| plan.get("version").and_then(Value::as_i64).unwrap_or(0))
        .max()
        .unwrap_or(0) as u32
        + 1;
    let (plan, source) = create_eop_version(
        &ctx,
        &event,
        version,
        title,
        additional,
        allow_fallback,
        correlation,
    )
    .await?;
    let generated_by = plan
        .get("metadata")
        .and_then(|value| value.get("generated_by"))
        .and_then(Value::as_str)
        .unwrap_or(&source)
        .to_string();
    let mut payload = plan;
    payload.insert("generated_by".into(), json!(generated_by));
    payload.insert("generated".into(), json!(true));
    payload.insert("source".into(), json!(source));
    if generated_by == "deterministic-fallback" {
        payload.insert(
            "warning".into(),
            json!("ai_unavailable_deterministic_fallback"),
        );
    }
    Ok(web::created(Value::Object(payload)))
}

async fn eop_approve(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::EOP, id).await?;
    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
    if status == "approved" {
        let mut response = current;
        response.insert("idempotent".into(), json!(true));
        return Ok(web::json_response(Value::Object(response)));
    }
    if !["draft", "review_pending"].contains(&status) {
        return Err(ApiError::conflict(
            "invalid_eop_status",
            format!("cannot approve a plan in status {status}"),
        ));
    }
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let approval_id = web::string_value(ctx.body.get("approval_id"))
        .or_else(|| web::string_value(ctx.body.get("approvalId")))
        .unwrap_or_default();
    if approval_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "approval_required",
            "create an EOP approval first and supply approval_id",
        ));
    }
    let approval = assert_approval_ready(&ctx, &approval_id, id, "eop.approve", &actor).await?;
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let mut patch = Map::new();
    patch.insert("status".into(), json!("approved"));
    patch.insert(
        "review_notes".into(),
        ctx.body
            .get("review_notes")
            .cloned()
            .or_else(|| current.get("review_notes").cloned())
            .unwrap_or(Value::Null),
    );
    patch.insert("approved_by".into(), json!(actor));
    patch.insert("approved_at".into(), json!(crate::now_iso()));
    patch.insert(
        "approval_id".into(),
        approval.get("id").cloned().unwrap_or(Value::Null),
    );
    patch.insert(
        "approved_role".into(),
        approval
            .get("approverRoles")
            .and_then(Value::as_array)
            .and_then(|roles| roles.first())
            .cloned()
            .unwrap_or(Value::Null),
    );
    patch.insert(
        "approval_roles".into(),
        approval
            .get("approverRoles")
            .cloned()
            .unwrap_or(Value::Null),
    );
    let row = tier2::update(ctx.client(), &opts, tier2::EOP, id, patch, version).await?;
    Ok(web::send_record(row))
}

async fn eop_publish(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::EOP, id).await?;
    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
    if !["approved", "published"].contains(&status) {
        return Err(ApiError::conflict(
            "eop_not_approved",
            "approve the EOP before publishing it",
        ));
    }
    if status == "published" {
        let mut response = current;
        response.insert("idempotent".into(), json!(true));
        return Ok(web::json_response(Value::Object(response)));
    }
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let approval_id = web::string_value(ctx.body.get("approval_id"))
        .or_else(|| web::string_value(ctx.body.get("approvalId")))
        .or_else(|| {
            current
                .get("approval_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    if approval_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "approval_required",
            "publish requires the approved EOP approval",
        ));
    }
    let approval = assert_approval_ready(&ctx, &approval_id, id, "eop.approve", &actor).await?;
    if current.get("approval_id").and_then(Value::as_str)
        != approval.get("id").and_then(Value::as_str)
    {
        return Err(ApiError::conflict(
            "approval_entity_mismatch",
            "the publication approval does not match the approval that admitted this plan",
        ));
    }
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let mut patch = Map::new();
    patch.insert("status".into(), json!("published"));
    patch.insert(
        "published_at".into(),
        current
            .get("published_at")
            .cloned()
            .unwrap_or_else(|| json!(crate::now_iso())),
    );
    patch.insert(
        "published_by".into(),
        ctx.actor()
            .map(Value::String)
            .or_else(|| current.get("published_by").cloned())
            .unwrap_or(Value::Null),
    );
    let row = tier2::update(ctx.client(), &opts, tier2::EOP, id, patch, version).await?;
    Ok(web::send_record(row))
}

async fn eop_markdown(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    if let Some(value) = ctx.body.get("markdown_body") {
        if !value.is_string() && !value.is_null() {
            return Err(ApiError::bad_request(
                "markdown_body_must_be_a_string",
                "markdown_body must be a string",
            ));
        }
    }
    let mut patch = Map::new();
    patch.insert(
        "markdown_body".into(),
        ctx.body
            .get("markdown_body")
            .cloned()
            .unwrap_or(Value::Null),
    );
    patch.insert(
        "review_notes".into(),
        ctx.body.get("review_notes").cloned().unwrap_or(Value::Null),
    );
    patch.insert(
        "updated_by".into(),
        ctx.actor().map(Value::String).unwrap_or(Value::Null),
    );
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let opts = ctx.opts();
    let row = tier2::update(ctx.client(), &opts, tier2::EOP, id, patch, version).await?;
    Ok(web::send_record(row))
}

async fn eop_submit(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let plan = tier2::get(ctx.client(), &opts, tier2::EOP, id).await?;
    let plan_status = plan.get("status").and_then(Value::as_str).unwrap_or("");
    if plan_status == "published" {
        return Err(ApiError::conflict(
            "eop_already_published",
            "cannot submit a published plan; publication is a terminal lifecycle step",
        ));
    }
    if plan_status != "approved" {
        return Err(ApiError::conflict(
            "eop_not_approved",
            format!("submit requires an approved plan, found {plan_status}"),
        ));
    }
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let approval_id = web::string_value(ctx.body.get("approval_id"))
        .or_else(|| web::string_value(ctx.body.get("approvalId")))
        .or_else(|| {
            plan.get("approval_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    if approval_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "approval_required",
            "submit requires the approved EOP approval",
        ));
    }
    let approval = assert_approval_ready(&ctx, &approval_id, id, "eop.approve", &actor).await?;
    if plan.get("approval_id").and_then(Value::as_str) != approval.get("id").and_then(Value::as_str)
    {
        return Err(ApiError::conflict(
            "approval_entity_mismatch",
            "the submit approval does not match the approval that admitted this plan",
        ));
    }
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let seeds = domain::eop::plan_order_seeds(&to_data(&plan));
    let mut created = Vec::new();
    let mut existing_ids = Vec::new();
    for seed in seeds {
        let order_id = domain::eop::order_id_for(
            plan.get("id").and_then(Value::as_str).unwrap_or(id),
            &seed.action_id,
        );
        if let Ok(existing) = tier2::get(ctx.client(), &opts, tier2::DISPATCH, &order_id).await {
            let _ = existing;
            existing_ids.push(order_id);
            continue;
        }
        let input = json!({
            "id": order_id,
            "emergency_event_id": plan.get("emergency_event_id"),
            "eop_plan_id": plan.get("id"),
            "eop_plan_version": plan.get("version"),
            "task_title": seed.task_title,
            "task_description": seed.task_description,
            "priority": seed.priority,
            "status": "pending",
            "required_capability": seed.required_capability,
            "target_location": seed.target_location,
            "target_district": plan.get("metadata").and_then(|value| value.get("target_district")),
            "assignments": [],
            "metadata": {
                "action_id": seed.action_id,
                "phase": seed.phase,
                "estimated_minutes": seed.estimated_minutes,
                "plan_version": plan.get("version"),
                "source": "eop-submit",
            },
            "created_by": actor.clone(),
        });
        match tier2::write(
            ctx.client(),
            &opts,
            tier2::DISPATCH,
            input.as_object().cloned().unwrap_or_default(),
            Some(&order_id),
        )
        .await
        {
            Ok(order) => created.push(order),
            Err(error) if error.code == "record_exists" => existing_ids.push(order_id),
            Err(error) => return Err(error),
        }
    }
    let previous_order_ids: Vec<String> = plan
        .get("order_ids")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let order_ids: Vec<String> = previous_order_ids
        .into_iter()
        .chain(existing_ids.iter().cloned())
        .chain(
            created
                .iter()
                .filter_map(|order| order.get("id").and_then(Value::as_str).map(str::to_string)),
        )
        .collect::<std::collections::BTreeSet<String>>()
        .into_iter()
        .collect();
    let mut patch = Map::new();
    patch.insert("status".into(), json!("approved"));
    patch.insert(
        "submitted_at".into(),
        plan.get("submitted_at")
            .cloned()
            .unwrap_or_else(|| json!(crate::now_iso())),
    );
    patch.insert("submitted_by".into(), json!(actor));
    patch.insert("order_ids".into(), json!(order_ids));
    let submitted = tier2::update(ctx.client(), &opts, tier2::EOP, id, patch, version).await?;
    let mut orders = Vec::new();
    for order_id in order_ids {
        if let Ok(order) = tier2::get(ctx.client(), &opts, tier2::DISPATCH, &order_id).await {
            orders.push(Value::Object(order));
        }
    }
    Ok(web::json_response(json!({
        "plan_id": submitted.get("id"),
        "task_source": "synapsecity-sos",
        "plan_status": submitted.get("status"),
        "created": created.len(),
        "existing": existing_ids.len(),
        "idempotent": created.is_empty(),
        "orders": orders,
    })))
}

async fn eop_approval(ctx: Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let plan = tier2::get(ctx.client(), &opts, tier2::EOP, id).await?;
    let actor = ctx.actor().unwrap_or_else(|| "sos-operator".into());
    let approval = create_approval(
        &ctx,
        format!(
            "EOP publication approval: {}",
            plan.get("title").and_then(Value::as_str).unwrap_or(id)
        ),
        "sos.eop",
        "eop.approve",
        "eop",
        id,
        json!({
            "event_id": plan.get("emergency_event_id"),
            "version": plan.get("version"),
            "status": plan.get("status"),
        }),
        &actor,
    )
    .await?;
    Ok(web::accepted(
        json!({ "approval": approval, "hitl_required": true }),
    ))
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use synapsedx::{Client, Credentials};
    use tower::ServiceExt;
    use wiremock::matchers::{body_partial_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn state(uri: &str) -> AppState {
        let config = Config::for_test(uri);
        let client = Client::new(uri, Credentials::none()).unwrap();
        AppState::new(config, client)
    }

    fn app(state: AppState) -> Router {
        Router::new().fallback(dispatch).with_state(state)
    }

    fn admin_token(config: &Config) -> String {
        let user = auth::shell_user(
            "qa",
            Some("qa@example.com"),
            Some("QA"),
            None,
            auth::ROLE_ADMIN,
        );
        auth::issue_session(
            config,
            &user,
            auth::SessionExtras {
                auth_source: Some("demo".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .access_token
    }

    fn responder_token(config: &Config) -> String {
        let user = auth::shell_user(
            "responder",
            Some("responder@example.com"),
            Some("Responder"),
            None,
            auth::ROLE_RESPONDER,
        );
        auth::issue_session(
            config,
            &user,
            auth::SessionExtras {
                auth_source: Some("demo".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .access_token
    }

    /// A second dispatch-capable operator so four-eyes flows have two actors.
    fn officer_token(config: &Config, username: &str) -> String {
        let user = auth::shell_user(username, None, None, None, auth::ROLE_OPERATOR);
        auth::issue_session(
            config,
            &user,
            auth::SessionExtras {
                auth_source: Some("demo".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .access_token
    }

    async fn call(
        app: Router,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(serde_json::to_vec(&value).unwrap())
            }
            None => Body::empty(),
        };
        let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, headers, value)
    }

    async fn mount_dataset(
        server: &MockServer,
        id: &str,
        name: &str,
        entity_type: &str,
        description: &str,
        public: bool,
    ) {
        Mock::given(method("GET"))
            .and(path(format!("/v1/capabilities/datasets/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": id,
                "slug": id,
                "name": name,
                "entityType": entity_type,
                "license": "CC-BY-4.0",
                "public": public,
                "status": "published",
                "description": description,
                "schemaVersion": "1.0.0",
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z"
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn auth_entry_points_are_permanently_410_for_all_methods() {
        let app = app(state("http://127.0.0.1:1"));
        for method in [Method::POST, Method::GET] {
            for route in ["login", "register", "refresh"] {
                let (status, _, body) = call(
                    app.clone(),
                    method.clone(),
                    &format!("/v1/auth/{route}"),
                    None,
                    Some(json!({})),
                )
                .await;
                assert_eq!(status, StatusCode::GONE, "{method} {route}");
                assert_eq!(body["error"], "workspace_moved");
                assert_eq!(body["workspace_url"], "https://synapsedx.sbs/workspace");
            }
        }
    }

    #[tokio::test]
    async fn operator_routes_require_a_valid_session() {
        let app = app(state("http://127.0.0.1:1"));
        let (status, _, _) = call(app.clone(), Method::GET, "/v1/emergency", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) =
            call(app, Method::GET, "/v1/emergency", Some("not-a-token"), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn foreign_city_namespace_is_rejected_locally() {
        let app = app(state("http://127.0.0.1:1"));
        let (status, _, body) = call(app, Method::GET, "/v1/assets", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["product"], "synapsecity-sos");
    }

    #[tokio::test]
    async fn dispatch_and_hazard_validation_happens_before_tier2() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let app = app(AppState::new(
            config,
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        ));
        let (status, _, body) = call(
            app.clone(),
            Method::POST,
            "/v1/emergency/dispatch",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "emergency_event_id_required");
        let (status, _, body) = call(
            app,
            Method::POST,
            "/v1/hazards",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "title_and_event_type_required");
    }

    #[tokio::test]
    async fn public_events_projection_reads_published_entities() {
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-emergency-events",
            "SynapseCitySOS emergency events",
            "EmergencyEvent",
            "Emergency event command records",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-emergency-events/entities",
            ))
            .and(query_param("limit", "500"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
                "id": "e1",
                "type": "EmergencyEvent",
                "title": { "type": "Property", "value": "Flood response" },
                "event_type": { "type": "Property", "value": "flood" },
                "severity": { "type": "Property", "value": "high" },
                "status": { "type": "Property", "value": "active" }
            }])))
            .expect(1)
            .mount(&server)
            .await;

        let (status, _, body) = call(
            app(state(&server.uri())),
            Method::GET,
            "/v1/emergency/public",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["id"], "e1");
        assert_eq!(body[0]["title"], "Flood response");
    }

    #[tokio::test]
    async fn public_hazards_recent_merges_the_tier2_feed() {
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-hazard-layers",
            "SynapseCitySOS hazard layers",
            "HazardLayer",
            "Flood, storm and other hazard observations",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/sos-hazard-layers/entities"))
            .and(query_param("limit", "500"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/hazards/today"))
            .and(query_param("hours", "24"))
            .and(query_param("limit", "200"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "hazards": [{
                    "id": "h1",
                    "hazard_id": "h1",
                    "title": "Flood warning",
                    "published_at": crate::now_iso(),
                    "severity": "high",
                    "event_type": "flood",
                    "geometry": {"type": "Point", "coordinates": [105.8, 21.0]}
                }]
            })))
            .mount(&server)
            .await;

        let (status, _, body) = call(
            app(state(&server.uri())),
            Method::GET,
            "/v1/hazards/recent",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["hazard_id"], "h1");
    }

    #[test]
    fn feed_hazards_without_a_point_never_get_fabricated_coordinates() {
        let missing = to_sos_hazard(&json!({
            "hazard_id": "h-no-geo",
            "title": "Province-wide rain warning",
            "published_at": "2026-11-01T00:00:00.000Z"
        }))
        .expect("record");
        assert_eq!(missing.get("geometry"), None);
        assert_eq!(missing["location_unknown"], true);

        let polygon = to_sos_hazard(&json!({
            "hazard_id": "h-polygon",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[107, 16], [108, 16], [108, 17], [107, 16]]]
            }
        }))
        .expect("record");
        // Polygon warnings stay in the list APIs but are never drawn at an
        // invented point; the severity default logic still applies.
        assert_eq!(polygon.get("geometry"), None);
        assert_eq!(polygon["location_unknown"], true);
        assert_eq!(polygon["severity"], "medium");
    }

    #[test]
    fn feed_hazards_with_a_point_keep_their_real_coordinates() {
        let point = to_sos_hazard(&json!({
            "hazard_id": "h-point",
            "geometry": { "type": "Point", "coordinates": [108.2, 16.05] }
        }))
        .expect("record");
        assert_eq!(point["geometry"]["type"], "Point");
        assert_eq!(point["geometry"]["coordinates"], json!([108.2, 16.05]));
        assert_eq!(point["location_unknown"], false);
    }

    #[tokio::test]
    async fn record_get_sets_etag_and_stale_put_is_rejected() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-emergency-events",
            "SynapseCitySOS emergency events",
            "EmergencyEvent",
            "Emergency event command records",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-emergency-events/records/e1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "e1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "title": "Flood", "status": "active" }
            })))
            .expect(3)
            .mount(&server)
            .await;

        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let app = app(state);
        let (status, headers, value) = call(
            app.clone(),
            Method::GET,
            "/v1/emergency/e1",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get("etag").unwrap(), "\"3\"");
        assert_eq!(value["record_version"], 3);

        let (status, _, body) = call(
            app,
            Method::PUT,
            "/v1/emergency/e1",
            Some(&token),
            Some(json!({ "if_version": 4, "title": "changed" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "record_version_conflict");
    }

    #[tokio::test]
    async fn matching_if_version_writes_and_returns_new_etag() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-emergency-events",
            "SynapseCitySOS emergency events",
            "EmergencyEvent",
            "Emergency event command records",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-emergency-events/records/e1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "e1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "title": "Flood", "status": "active" }
            })))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-emergency-events/records/e1",
            ))
            .and(header("if-match", "\"3\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "e1",
                "version": 4,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": { "title": "changed", "status": "active" }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, headers, value) = call(
            app(state),
            Method::PUT,
            "/v1/emergency/e1",
            Some(&token),
            Some(json!({ "if_version": 3, "title": "changed" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get("etag").unwrap(), "\"4\"");
        assert_eq!(value["record_version"], 4);
    }

    #[tokio::test]
    async fn create_with_an_existing_id_returns_409_instead_of_overwriting() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-emergency-events",
            "SynapseCitySOS emergency events",
            "EmergencyEvent",
            "Emergency event command records",
            true,
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/v1/capabilities/datasets/sos-emergency-events/records"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "error": "record_exists"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(config, Client::new(&server.uri(), Credentials::none()).unwrap());
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency",
            Some(&token),
            Some(json!({ "id": "existing-event", "title": "Overwrite attempt" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "record_exists");
    }

    #[tokio::test]
    async fn generic_put_cannot_change_lifecycle_fields() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = responder_token(&config);
        let app = app(AppState::new(
            config,
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        ));
        let (status, _, body) = call(
            app,
            Method::PUT,
            "/v1/emergency/eop/eop-1",
            Some(&token),
            Some(json!({ "status": "published", "title": "Bypass" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "controlled_field_forbidden");
        assert_eq!(body["details"]["field"], "status");
    }

    #[tokio::test]
    async fn published_eop_is_immutable_through_generic_put() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-eop-plans",
            "SynapseCitySOS EOP plans",
            "EmergencyOperationsPlan",
            "Emergency operations plans",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-eop-plans/records/eop-1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "eop-1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "title": "Published plan", "status": "published" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::PUT,
            "/v1/emergency/eop/eop-1",
            Some(&token),
            Some(json!({ "title": "Rewrite published plan" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "record_immutable");
    }

    #[tokio::test]
    async fn eop_approve_and_submit_require_a_real_approval() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-eop-plans",
            "SynapseCitySOS EOP plans",
            "EmergencyOperationsPlan",
            "Emergency operations plans",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-eop-plans/records/eop-1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "eop-1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "title": "Draft plan", "status": "draft" }
            })))
            .expect(2)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state.clone()),
            Method::POST,
            "/v1/emergency/eop/eop-1/approve",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(body["error"], "approval_required");

        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/eop/eop-1/submit",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "eop_not_approved");
    }

    #[tokio::test]
    async fn eop_submit_never_demotes_a_published_plan() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-eop-plans",
            "SynapseCitySOS EOP plans",
            "EmergencyOperationsPlan",
            "Emergency operations plans",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-eop-plans/records/eop-1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "eop-1",
                "version": 5,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "title": "Published plan", "status": "published" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/eop/eop-1/submit",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "eop_already_published");
    }

    #[tokio::test]
    async fn dispatch_terminal_order_cannot_be_reopened() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 4,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "status": "canceled", "task_title": "Closed order" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/complete",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "order_terminal");
    }

    #[tokio::test]
    async fn dispatch_assignment_always_requires_an_approval() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let app = app(AppState::new(
            config,
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        ));
        let (status, _, body) = call(
            app,
            Method::POST,
            "/v1/emergency/dispatch/d1/approve",
            Some(&token),
            Some(json!({ "assigned_resource_unit_id": "u1" })),
        )
        .await;
        assert_eq!(status, StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(body["error"], "approval_required");
    }

    #[tokio::test]
    async fn dispatch_assignment_rejects_an_already_reserved_unit() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        mount_dataset(
            &server,
            "sos-resource-units",
            "SynapseCitySOS resource units",
            "ResourceUnit",
            "Emergency response resources",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/approvals/ap1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "approved",
                    "entityId": "d1",
                    "action": "dispatch.assign",
                    "requester": "other-operator",
                    "approverRoles": ["duty-manager"]
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "status": "pending", "task_title": "Rescue" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {
                    "status": "assigned",
                    "assigned_dispatch_order_id": "other-order",
                    "resource_type": "personnel"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/approve",
            Some(&token),
            Some(json!({ "approval_id": "ap1", "assigned_resource_unit_id": "u1" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "resource_unit_unavailable");
    }

    #[tokio::test]
    async fn hitl_decide_rejects_the_requester_and_keeps_the_approval_pending() {
        let config = Config::for_test("http://127.0.0.1:1");
        let requester = admin_token(&config);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/approvals/ap1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "pending",
                    "entityId": "d1",
                    "action": "dispatch.assign",
                    "requester": "qa",
                    "approverRoles": ["duty-manager"]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        // The decision must never reach Tier-2 when the requester decides
        // alone; the approval stays pending for a different approver.
        Mock::given(method("POST"))
            .and(path("/v1/capabilities/approvals/ap1/decide"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": { "id": "ap1", "status": "approved" }
            })))
            .expect(0)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/hitl/approvals/ap1/decide",
            Some(&requester),
            Some(json!({ "decision": "approve" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "self_approval_forbidden");
    }

    #[tokio::test]
    async fn hitl_decide_allows_a_second_operator() {
        let config = Config::for_test("http://127.0.0.1:1");
        let approver = responder_token(&config);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/approvals/ap1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "pending",
                    "entityId": "d1",
                    "action": "dispatch.assign",
                    "requester": "qa",
                    "approverRoles": ["duty-manager"]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/capabilities/approvals/ap1/decide"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "approved",
                    "requester": "qa",
                    "decisions": [{ "actor": "responder", "decision": "approve" }]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/hitl/approvals/ap1/decide",
            Some(&approver),
            Some(json!({ "decision": "approve" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["approval"]["status"], "approved");
    }

    #[tokio::test]
    async fn an_approval_cannot_be_used_by_its_requester() {
        let config = Config::for_test("http://127.0.0.1:1");
        let requester = admin_token(&config);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/approvals/ap1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "approved",
                    "entityId": "d1",
                    "action": "dispatch.assign",
                    "requester": "qa",
                    "approverRoles": ["duty-manager"]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/approve",
            Some(&requester),
            Some(json!({ "approval_id": "ap1", "assigned_resource_unit_id": "u1" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "self_approval_forbidden");
    }

    #[tokio::test]
    async fn dispatch_assignment_accepts_a_four_eyes_approval_from_another_operator() {
        let config = Config::for_test("http://127.0.0.1:1");
        let officer = officer_token(&config, "officer");
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        mount_dataset(
            &server,
            "sos-resource-units",
            "SynapseCitySOS resource units",
            "ResourceUnit",
            "Emergency response resources",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/approvals/ap1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "approved",
                    "entityId": "d1",
                    "action": "dispatch.assign",
                    "requester": "qa",
                    "approverRoles": ["duty-manager"]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "status": "pending", "task_title": "Rescue", "assignments": [] }
            })))
            // The handler reads the order and tier2::update re-reads it.
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1",
                "version": 1,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "status": "available", "resource_type": "personnel" }
            })))
            // The handler reads the unit and tier2::update re-reads it.
            .expect(2)
            .mount(&server)
            .await;
        // The unit is reserved for the order before the order is patched.
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .and(body_partial_json(json!({
                "data": { "status": "assigned", "assigned_dispatch_order_id": "d1" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": {
                    "status": "assigned",
                    "assigned_dispatch_order_id": "d1",
                    "resource_type": "personnel"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .and(body_partial_json(json!({
                "data": { "status": "assigned", "approval_id": "ap1" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": {
                    "status": "assigned",
                    "task_title": "Rescue",
                    "assigned_resource_unit_id": "u1",
                    "approval_id": "ap1",
                    "approved_by": "officer"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/approve",
            Some(&officer),
            Some(json!({ "approval_id": "ap1", "assigned_resource_unit_id": "u1" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "assigned");
        assert_eq!(body["approval_id"], "ap1");
    }

    #[tokio::test]
    async fn repeating_a_dispatch_assignment_is_idempotent() {
        let config = Config::for_test("http://127.0.0.1:1");
        let officer = officer_token(&config, "officer");
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/approvals/ap1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "approved",
                    "entityId": "d1",
                    "action": "dispatch.assign",
                    "requester": "qa",
                    "approverRoles": ["duty-manager"]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {
                    "status": "assigned",
                    "task_title": "Rescue",
                    "assigned_resource_unit_id": "u1",
                    "approval_id": "ap1",
                    "assignments": [
                        { "dispatch_order_id": "d1", "assigned_resource_unit_id": "u1" }
                    ]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        // Repeating the assignment must not write a second time (issue #20).
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/approve",
            Some(&officer),
            Some(json!({ "approval_id": "ap1", "assigned_resource_unit_id": "u1" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["idempotent"], true);
        assert_eq!(body["status"], "assigned");
    }

    #[tokio::test]
    async fn dispatch_start_moves_an_assigned_order_to_in_transit() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {
                    "status": "assigned",
                    "task_title": "Rescue",
                    "assigned_resource_unit_id": "u1",
                    "status_history": []
                }
            })))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .and(body_partial_json(json!({
                "data": {
                    "status": "in_transit",
                    "status_history": [
                        { "from": "assigned", "to": "in_transit", "action": "start", "by": "qa" }
                    ]
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": {
                    "status": "in_transit",
                    "task_title": "Rescue",
                    "assigned_resource_unit_id": "u1",
                    "started_at": "2026-11-20T00:00:00.000Z"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        // `start` is a progression step, not a terminal one: the assigned unit
        // must stay reserved for the order.
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/start",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "in_transit");
    }

    #[tokio::test]
    async fn dispatch_arrive_moves_an_in_transit_order_to_on_scene() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {
                    "status": "in_transit",
                    "task_title": "Rescue",
                    "assigned_resource_unit_id": "u1",
                    "status_history": []
                }
            })))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .and(body_partial_json(json!({
                "data": {
                    "status": "on_scene",
                    "status_history": [
                        { "from": "in_transit", "to": "on_scene", "action": "arrive", "by": "qa" }
                    ]
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 4,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": {
                    "status": "on_scene",
                    "task_title": "Rescue",
                    "assigned_resource_unit_id": "u1",
                    "arrived_at": "2026-11-20T00:00:00.000Z"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/arrive",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "on_scene");
    }

    #[tokio::test]
    async fn invalid_dispatch_progression_is_rejected() {
        // arrive from "assigned" skips the required in_transit step.
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "status": "assigned", "task_title": "Rescue" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(&server)
            .await;
        let state = AppState::new(
            config.clone(),
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/arrive",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "invalid_dispatch_transition");

        // start from "on_scene" would move backwards.
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1",
                "version": 4,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "status": "on_scene", "task_title": "Rescue" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/d1/start",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "invalid_dispatch_transition");
    }

    #[tokio::test]
    async fn sos_timeline_fails_when_the_dispatch_scan_fails() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-emergency-events",
            "SynapseCitySOS emergency events",
            "EmergencyEvent",
            "Emergency event command records",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/sos-emergency-events/records"))
            .and(query_param("limit", "500"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [], "total": 0, "limit": 500, "offset": 0
            })))
            .expect(1)
            .mount(&server)
            .await;
        // The dispatch dataset is unreachable: the timeline must return the
        // dependency error, never a 200 with SLA numbers computed from
        // silently absent dispatch data. (The Tier-2 SDK retries a 5xx once,
        // hence the two expected hits.)
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/sos-dispatch-orders"))
            .respond_with(ResponseTemplate::new(500))
            .expect(2)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::GET,
            "/v1/emergency/sos/timeline",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body["error"], "tier2_unavailable");
    }

    async fn mount_resource_unit(server: &MockServer, status: &str, version: i64) {
        mount_dataset(
            server,
            "sos-resource-units",
            "SynapseCitySOS resource units",
            "ResourceUnit",
            "Emergency response resources",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1",
                "version": version,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {
                    "id": "u1", "name": "Team", "resource_type": "personnel",
                    "status": status, "status_history": []
                }
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn resource_status_enforces_the_lifecycle_vocabulary() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        // Unknown strings are rejected before Tier-2 is touched.
        let unconfigured = app(AppState::new(
            config.clone(),
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        ));
        let (status, _, body) = call(
            unconfigured,
            Method::POST,
            "/v1/emergency/resources/u1/status",
            Some(&token),
            Some(json!({ "status": "banana" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "invalid_resource_status");
        assert_eq!(body["details"]["allowed"][0], "available");

        // A valid transition writes the status, the changed-at stamp and an
        // audit history entry.
        let server = MockServer::start().await;
        mount_resource_unit(&server, "available", 1).await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .and(body_partial_json(json!({
                "data": {
                    "status": "maintenance",
                    "status_history": [
                        { "from": "available", "to": "maintenance", "by": "qa" }
                    ]
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": { "id": "u1", "name": "Team", "status": "maintenance" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/resources/u1/status",
            Some(&token),
            Some(json!({ "status": "maintenance" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "maintenance");
    }

    #[tokio::test]
    async fn retiring_a_resource_unit_is_a_one_way_transition() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        // available -> retired is a valid final step.
        let server = MockServer::start().await;
        mount_resource_unit(&server, "available", 1).await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .and(body_partial_json(json!({
                "data": {
                    "status": "retired",
                    "status_history": [
                        { "from": "available", "to": "retired", "by": "qa" }
                    ]
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": { "id": "u1", "name": "Team", "status": "retired" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config.clone(),
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/resources/u1/status",
            Some(&token),
            Some(json!({ "status": "retired" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "retired");

        // A retired unit is immutable: no status change can revive it.
        let server = MockServer::start().await;
        mount_resource_unit(&server, "retired", 2).await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/resources/u1/status",
            Some(&token),
            Some(json!({ "status": "available" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "record_immutable");
    }

    #[tokio::test]
    async fn resource_status_rejects_transition_table_violations() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        // deployed -> available skips the declared table (only unavailable
        // and maintenance may return to available).
        let server = MockServer::start().await;
        mount_resource_unit(&server, "deployed", 3).await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/resources/u1/status",
            Some(&token),
            Some(json!({ "status": "available" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "invalid_resource_transition");
        assert_eq!(body["details"]["current"], "deployed");
    }

    async fn mount_optimize_fixtures(server: &MockServer) {
        mount_dataset(
            server,
            "sos-dispatch-orders",
            "SynapseCitySOS dispatch orders",
            "DispatchOrder",
            "Emergency dispatch orders",
            false,
        )
        .await;
        mount_dataset(
            server,
            "sos-resource-units",
            "SynapseCitySOS resource units",
            "ResourceUnit",
            "Emergency response resources",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/sos-dispatch-orders/records"))
            .and(query_param("limit", "500"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [
                    {
                        "id": "d1", "version": 1,
                        "createdAt": "2026-11-01T00:00:00.000Z",
                        "updatedAt": "2026-11-01T00:00:00.000Z",
                        "data": {
                            "id": "d1", "status": "pending", "priority": "high",
                            "required_capability": "personnel", "district": "A"
                        }
                    },
                    {
                        "id": "d2", "version": 1,
                        "createdAt": "2026-11-01T00:00:00.000Z",
                        "updatedAt": "2026-11-01T00:00:00.000Z",
                        "data": {
                            "id": "d2", "status": "pending", "priority": "low",
                            "required_capability": "shelter", "district": "A"
                        }
                    }
                ],
                "total": 2, "limit": 500, "offset": 0
            })))
            .expect(1)
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/sos-resource-units/records"))
            .and(query_param("limit", "500"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [
                    {
                        "id": "u1", "version": 1,
                        "createdAt": "2026-11-01T00:00:00.000Z",
                        "updatedAt": "2026-11-01T00:00:00.000Z",
                        "data": {
                            "id": "u1", "status": "available",
                            "resource_type": "personnel", "district": "A"
                        }
                    }
                ],
                "total": 1, "limit": 500, "offset": 0
            })))
            .expect(1)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn optimize_without_an_approval_returns_a_read_only_proposal() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_optimize_fixtures(&server).await;
        // No approval_id: nothing may be written, not even stale flags.
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/optimize",
            Some(&token),
            Some(json!({ "max_orders": 250 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["applied"], false);
        assert_eq!(body["auto_assigned"], 0);
        assert_eq!(body["stale_flagged"], 0);
        assert_eq!(body["optimized"], 1);
        assert_eq!(body["suggested"][0]["order_id"], "d1");
        assert_eq!(body["suggested"][0]["resource_unit_id"], "u1");
        assert!(body["note"].as_str().unwrap_or("").contains("approval"));
    }

    #[tokio::test]
    async fn optimize_with_a_four_eyes_event_approval_applies_assignments() {
        let config = Config::for_test("http://127.0.0.1:1");
        let officer = officer_token(&config, "officer");
        let server = MockServer::start().await;
        mount_optimize_fixtures(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/approvals/ap1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "approved",
                    "entityId": "e1",
                    "action": "dispatch.assign",
                    "requester": "qa",
                    "approverRoles": ["duty-manager"]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1", "version": 1,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "id": "u1", "status": "available", "resource_type": "personnel", "district": "A" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .and(body_partial_json(json!({
                "data": { "status": "assigned", "assigned_dispatch_order_id": "d1" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1", "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": { "id": "u1", "status": "assigned", "assigned_dispatch_order_id": "d1" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1", "version": 1,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {
                    "id": "d1", "status": "pending", "priority": "high",
                    "required_capability": "personnel", "district": "A"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d1",
            ))
            .and(body_partial_json(json!({
                "data": { "status": "assigned", "approval_id": "ap1" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1", "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": {
                    "id": "d1", "status": "assigned",
                    "assigned_resource_unit_id": "u1", "approval_id": "ap1"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d2",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d2", "version": 1,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {
                    "id": "d2", "status": "pending", "priority": "low",
                    "required_capability": "shelter", "district": "A"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-dispatch-orders/records/d2",
            ))
            .and(body_partial_json(json!({
                "data": { "metadata": { "stale": true } }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d2", "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": { "id": "d2", "status": "pending", "metadata": { "stale": true } }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/optimize",
            Some(&officer),
            Some(json!({ "approval_id": "ap1", "emergency_event_id": "e1" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["applied"], true);
        assert_eq!(body["auto_assigned"], 1);
        assert_eq!(body["stale_flagged"], 1);
        assert_eq!(body["approval_id"], "ap1");
    }

    #[tokio::test]
    async fn optimize_rejects_a_self_approved_event_approval() {
        let config = Config::for_test("http://127.0.0.1:1");
        let requester = admin_token(&config);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/approvals/ap1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "approval": {
                    "id": "ap1",
                    "status": "approved",
                    "entityId": "e1",
                    "action": "dispatch.assign",
                    "requester": "qa",
                    "approverRoles": ["duty-manager"]
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/dispatch/optimize",
            Some(&requester),
            Some(json!({ "approval_id": "ap1", "emergency_event_id": "e1" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "self_approval_forbidden");
    }

    #[tokio::test]
    async fn optimize_cannot_apply_an_approval_without_the_event_scope() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let app = app(AppState::new(
            config,
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        ));
        let (status, _, body) = call(
            app,
            Method::POST,
            "/v1/emergency/dispatch/optimize",
            Some(&token),
            Some(json!({ "approval_id": "ap1" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "emergency_event_id_required");
    }

    #[tokio::test]
    async fn mutual_aid_accept_rejects_a_stale_expected_version() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-mutual-aid-requests",
            "SynapseCitySOS mutual aid requests",
            "MutualAidRequest",
            "Cross-agency resource requests, accepts and handoffs",
            false,
        )
        .await;
        mount_dataset(
            &server,
            "sos-resource-units",
            "SynapseCitySOS resource units",
            "ResourceUnit",
            "Emergency response resources",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-mutual-aid-requests/records/ma-1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "ma-1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {
                    "id": "ma-1",
                    "request_number": "MA-1",
                    "resource_type": "ambulance",
                    "quantity": 5,
                    "filled_quantity": 0,
                    "location": {"city": "Hanoi"},
                    "urgency": "high",
                    "contact": {"name": "Duty"},
                    "requesting_agency": "Partner",
                    "status": "open",
                    "history": [],
                    "created_at": "2026-11-01T00:00:00.000Z",
                    "updated_at": "2026-11-01T00:00:00.000Z"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-resource-units/records/u1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1",
                "version": 1,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {"status": "available", "available_quantity": 10}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/emergency/mutual-aid/requests/ma-1/accept",
            Some(&token),
            Some(json!({ "unit_id": "u1", "accepted_quantity": 1, "expected_version": 2 })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "request_version_conflict");
    }

    #[tokio::test]
    async fn tier2_exchange_issues_an_sos_session_for_a_verified_bearer() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/auth/me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "user": { "id": "u1", "email": "duty@example.com", "displayName": "Duty" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (status, _, body) = call(
            app(state(&server.uri())),
            Method::POST,
            "/v1/auth/exchange",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "tier2_token_required");

        let builder = axum::http::Request::builder()
            .method(Method::POST)
            .uri("/v1/auth/exchange")
            .header("authorization", "Bearer tier2-user-token");
        let response = app(state(&server.uri()))
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["access_token"].as_str().unwrap_or("").len() > 20);
        assert_eq!(body["user"]["email"], "duty@example.com");
    }

    #[tokio::test]
    async fn hazard_status_transition_is_explicit_and_versioned() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-hazard-layers",
            "SynapseCitySOS hazard layers",
            "HazardLayer",
            "Flood, storm and other hazard observations",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path(
                "/v1/capabilities/datasets/sos-hazard-layers/records/h1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "h1",
                "version": 1,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "status": "active", "is_active": true, "title": "Flood" }
            })))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path(
                "/v1/capabilities/datasets/sos-hazard-layers/records/h1",
            ))
            .and(header("if-match", "\"1\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "h1",
                "version": 2,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": { "status": "resolved", "is_active": false, "title": "Flood" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let state = AppState::new(
            config,
            Client::new(&server.uri(), Credentials::none()).unwrap(),
        );
        let (status, _, body) = call(
            app(state),
            Method::POST,
            "/v1/hazards/h1/status",
            Some(&token),
            Some(json!({ "status": "resolved", "if_version": 1 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["record_version"], 2);
        assert_eq!(body["status"], "resolved");
    }

    #[tokio::test]
    async fn public_status_counts_the_merged_feed_and_reports_stale_ingest() {
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-hazard-layers",
            "SynapseCitySOS hazard layers",
            "HazardLayer",
            "Flood, storm and other hazard observations",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/sos-hazard-layers/entities"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/hazards/today"))
            .and(query_param("hours", "72"))
            .and(query_param("limit", "200"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "hazards": [{
                    "id": "h1",
                    "hazard_id": "h1",
                    "title": "Flood warning",
                    "published_at": crate::now_iso(),
                    "severity": "high",
                    "event_type": "flood"
                }]
            })))
            .mount(&server)
            .await;
        // The ingest projection comes from the real Tier-2 scheduled job and
        // its run history, never from a hardcoded connector literal.
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/jobs"))
            .and(query_param("limit", "100"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{
                    "id": "vndms-connector",
                    "name": "VNDMS feed ingest",
                    "kind": "ingest",
                    "enabled": true,
                    "schedule": { "everySeconds": 1800 },
                    "datasetId": "sos-hazard-layers"
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/jobs/vndms-connector/runs"))
            .and(query_param("limit", "20"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{
                    "id": "r1",
                    "status": "success",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "finishedAt": "2026-01-01T00:05:00.000Z",
                    "lastError": null
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (status, _, body) = call(
            app(state(&server.uri())),
            Method::GET,
            "/v1/emergency/public/status",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["hazard_feed"]["records_visible"], 1);
        assert_eq!(body["hazard_feed"]["stale"], true);
        assert_eq!(
            body["hazard_feed"]["ingest"]["connector"]["job_id"],
            "vndms-connector"
        );
        assert_eq!(
            body["hazard_feed"]["ingest"]["connector"]["last_run_status"],
            "success"
        );
        assert_eq!(body["hazard_feed"]["ingest"]["configured"], true);
        assert_eq!(body["hazard_feed"]["ingest"]["stale"], true);
        assert_eq!(body["status"], "degraded");
    }

    async fn mount_connector_job(
        server: &MockServer,
        job: Value,
        runs: Value,
    ) {
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/jobs"))
            .and(query_param("limit", "100"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [job]
            })))
            .expect(1)
            .mount(server)
            .await;
        let job_id = job.get("id").and_then(Value::as_str).unwrap_or_default();
        Mock::given(method("GET"))
            .and(path(format!("/v1/capabilities/jobs/{job_id}/runs")))
            .and(query_param("limit", "20"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [runs]
            })))
            .expect(1)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn ingest_status_reflects_the_real_tier2_connector_job() {
        let server = MockServer::start().await;
        let now = crate::now_iso();
        mount_connector_job(
            &server,
            json!({
                "id": "vndms-connector", "name": "VNDMS feed ingest", "kind": "ingest",
                "enabled": true, "schedule": { "everySeconds": 900 },
                "datasetId": "sos-hazard-layers"
            }),
            json!({
                "id": "r1", "status": "success", "startedAt": now, "finishedAt": now,
                "lastError": null
            }),
        )
        .await;
        let (status_code, _, body) = call(
            app(state(&server.uri())),
            Method::GET,
            "/v1/hazards/ingest/status",
            None,
            None,
        )
        .await;
        assert_eq!(status_code, StatusCode::OK);
        assert_eq!(body["configured"], true);
        assert_eq!(body["status"], "ready");
        let connector = &body["connector"];
        assert_eq!(connector["job_id"], "vndms-connector");
        assert_eq!(connector["job_name"], "VNDMS feed ingest");
        assert_eq!(connector["enabled"], true);
        assert_eq!(connector["schedule"]["every_seconds"], 900.0);
        assert_eq!(connector["last_run_status"], "success");
        assert_eq!(connector["runs_considered"], 1);
        assert_eq!(connector["error"], Value::Null);
    }

    #[tokio::test]
    async fn ingest_status_flags_a_disabled_connector_job() {
        let server = MockServer::start().await;
        mount_connector_job(
            &server,
            json!({
                "id": "vndms-connector", "name": "VNDMS feed ingest", "kind": "ingest",
                "enabled": false, "schedule": { "everySeconds": 1800 },
                "datasetId": "sos-hazard-layers"
            }),
            json!({ "id": "r-none" }),
        )
        .await;
        let (status_code, _, body) = call(
            app(state(&server.uri())),
            Method::GET,
            "/v1/hazards/ingest/status",
            None,
            None,
        )
        .await;
        assert_eq!(status_code, StatusCode::OK);
        let connector = &body["connector"];
        assert_eq!(connector["enabled"], false);
        assert_eq!(connector["error"], "connector_disabled");
        assert_eq!(body["status"], "error");
        assert_eq!(body["error"], "connector_disabled");
    }

    #[tokio::test]
    async fn ingest_status_reports_an_absent_connector_as_unconfigured() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/jobs"))
            .and(query_param("limit", "100"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [
                    { "id": "email-digest", "name": "Email digest", "kind": "interval" }
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (status_code, _, body) = call(
            app(state(&server.uri())),
            Method::GET,
            "/v1/hazards/ingest/status",
            None,
            None,
        )
        .await;
        assert_eq!(status_code, StatusCode::OK);
        assert_eq!(body["configured"], false);
        assert_eq!(body["status"], "unconfigured");
        assert_eq!(body["connector"]["configured"], false);
        assert_eq!(body["connector"]["available"], true);
    }

    #[tokio::test]
    async fn anonymous_public_reads_are_rate_limited() {
        let mut config = Config::for_test("http://127.0.0.1:1");
        config.rate_limit_disabled = false;
        config.public_rate_max = 1;
        let app = app(AppState::new(
            config,
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        ));
        let (status, _, _) = call(app.clone(), Method::GET, "/v1/sos", None, None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, body) = call(app, Method::GET, "/v1/sos", None, None).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["error"], "rate_limited");
    }

    #[tokio::test]
    async fn hazard_snapshot_uses_the_feed_and_preserves_last_good_on_error() {
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "sos-hazard-layers",
            "SynapseCitySOS hazard layers",
            "HazardLayer",
            "Flood, storm and other hazard observations",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/sos-hazard-layers/entities"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/hazards/today"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "hazards": [{
                    "id": "h1",
                    "hazard_id": "h1",
                    "title": "Feed-only flood",
                    "published_at": crate::now_iso(),
                    "severity": "high",
                    "event_type": "flood"
                }]
            })))
            .mount(&server)
            .await;
        let app_state = state(&server.uri());
        let opts = RequestOptions::new().api_key("test-key");
        let frame = hazard_snapshot_frame(&app_state, &opts, "initial").await;
        assert!(frame.starts_with("event: hazards\n"), "{frame}");
        assert!(frame.contains("\"records_visible\":1"), "{frame}");
        assert!(frame.contains("Feed-only flood"), "{frame}");
        assert!(app_state.hazard_last_good.lock().unwrap().is_some());

        let failed_state = state("http://127.0.0.1:1");
        let last_good = app_state.hazard_last_good.lock().unwrap().clone();
        *failed_state.hazard_last_good.lock().unwrap() = last_good;
        let error_frame = hazard_snapshot_frame(&failed_state, &opts, "fallback").await;
        assert!(error_frame.starts_with("event: error\n"), "{error_frame}");
        assert!(
            error_frame.contains("\"has_snapshot\":true"),
            "{error_frame}"
        );
        assert!(error_frame.contains("Feed-only flood"), "{error_frame}");
    }

    #[tokio::test]
    async fn hazard_ingest_accepts_only_the_service_principal_or_dispatch_roles() {
        let mut config = Config::for_test("http://127.0.0.1:1");
        config.ingest_service_token = Some("svc-token".into());
        let responder = responder_token(&config);
        let app = app(AppState::new(
            config,
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        ));
        let (status, _, _) = call(
            app.clone(),
            Method::POST,
            "/v1/hazards/ingest",
            None,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, body) = call(
            app.clone(),
            Method::POST,
            "/v1/hazards/ingest",
            Some(&responder),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "forbidden");
        let (status, _, _) = call(
            app,
            Method::POST,
            "/v1/hazards/ingest",
            Some("svc-token"),
            Some(json!({})),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "service principal must pass authentication"
        );
    }
}

#[cfg(test)]
mod route_family_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use synapsedx::{Client, Credentials};
    use tower::ServiceExt;

    fn app() -> Router {
        let config = Config::for_test("http://127.0.0.1:1");
        let client = Client::new("http://127.0.0.1:1", Credentials::none()).unwrap();
        Router::new()
            .fallback(dispatch)
            .with_state(AppState::new(config, client))
    }

    fn token() -> String {
        let config = Config::for_test("http://127.0.0.1:1");
        let user = auth::shell_user(
            "qa",
            Some("qa@example.com"),
            Some("QA"),
            None,
            auth::ROLE_ADMIN,
        );
        auth::issue_session(
            &config,
            &user,
            auth::SessionExtras {
                auth_source: Some("demo".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .access_token
    }

    async fn call(
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(serde_json::to_vec(&value).unwrap())
            }
            None => Body::empty(),
        };
        let response = app().oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    #[tokio::test]
    async fn remaining_family_validation_covers_eop_sitrep_mutual_aid_geo_ai() {
        let token = token();

        let (status, body) = call(
            Method::POST,
            "/v1/emergency/eop/generate-draft",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "emergency_event_id_required");

        let (status, body) = call(
            Method::POST,
            "/v1/emergency/sitrep",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "sitrep_validation_failed");

        let (status, body) = call(
            Method::POST,
            "/v1/emergency/mutual-aid/requests",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "resource_type_required");

        let (status, body) = call(
            Method::GET,
            "/v1/emergency/resources/shelters/near",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "coordinates_required");

        let (status, body) = call(
            Method::POST,
            "/v1/hazards/geo/in-polygon",
            None,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "invalid_geometry");

        let (status, body) = call(Method::POST, "/v1/ai/chat", None, Some(json!({}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "messages_required");

        let (status, body) = call(Method::POST, "/v1/geo/geocode", None, Some(json!({}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "address_required");
    }
}
