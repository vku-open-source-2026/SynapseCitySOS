// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Stateless SOS auth shell: HS256 JWT access/refresh sessions plus the
//! Tier-2 identity boundary.

use std::collections::HashSet;

use axum::http::{HeaderMap, StatusCode};
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::config::Config;
use crate::error::ApiError;

pub const ACCESS_TOKEN_TTL_SECONDS: i64 = 60 * 60;
pub const REFRESH_TOKEN_TTL_SECONDS: i64 = 60 * 60 * 24 * 30;

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_MANAGER: &str = "manager";
pub const ROLE_OPERATOR: &str = "operator";
pub const ROLE_RESPONDER: &str = "responder";
pub const ROLE_VOLUNTEER: &str = "volunteer";
pub const ROLE_CITIZEN: &str = "citizen";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub username: String,
    pub email: String,
    pub full_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    pub role: String,
    pub status: String,
    pub permissions: Vec<String>,
    pub typ: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier2_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier2_refresh_token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub email: String,
    pub full_name: String,
    pub phone: Option<String>,
    pub role: String,
    pub permissions: Vec<String>,
    pub status: String,
    pub language: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct SessionExtras {
    pub auth_source: Option<String>,
    pub tier2_token: Option<String>,
    pub tier2_refresh_token: Option<String>,
}

impl Default for SessionExtras {
    fn default() -> Self {
        Self {
            auth_source: None,
            tier2_token: None,
            tier2_refresh_token: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user: AuthUser,
}

impl AuthResponse {
    pub fn json(&self) -> Value {
        json!({
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_TTL_SECONDS,
            "user": user_json(&self.user),
        })
    }
}

pub fn user_json(user: &AuthUser) -> Value {
    json!({
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "full_name": user.full_name,
        "phone": user.phone,
        "role": user.role,
        "status": user.status,
        "permissions": user.permissions,
        "language": user.language,
        "created_at": user.created_at,
        "updated_at": user.updated_at,
    })
}

pub fn is_auth_role(value: &str) -> bool {
    matches!(
        value,
        ROLE_ADMIN | ROLE_MANAGER | ROLE_OPERATOR | ROLE_RESPONDER | ROLE_VOLUNTEER | ROLE_CITIZEN
    )
}

pub fn role_permissions(role: &str) -> Vec<String> {
    let values: &[&str] = match role {
        ROLE_ADMIN => &[
            "emergency:read",
            "emergency:write",
            "emergency:dispatch",
            "emergency:eop",
            "emergency:admin",
        ],
        ROLE_MANAGER => &[
            "emergency:read",
            "emergency:write",
            "emergency:dispatch",
            "emergency:eop",
        ],
        ROLE_OPERATOR => &[
            "emergency:read",
            "emergency:write",
            "emergency:dispatch",
        ],
        ROLE_RESPONDER => &["emergency:read", "emergency:write"],
        ROLE_VOLUNTEER | ROLE_CITIZEN => &["emergency:read"],
        _ => &["emergency:read"],
    };
    values.iter().map(|value| value.to_string()).collect()
}

pub fn has_permission(claims: &Claims, permission: &str) -> bool {
    let permissions = if claims.permissions.is_empty() {
        role_permissions(&claims.role)
    } else {
        claims.permissions.clone()
    };
    permissions.iter().any(|value| value == permission || value == "emergency:admin")
}

pub fn demo_session_role(kind: &str) -> String {
    let requested = std::env::var("SOS_DEMO_AUTH_ROLE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let safe = if kind == "register" {
        ROLE_VOLUNTEER
    } else {
        ROLE_RESPONDER
    };
    if requested.is_empty() || !is_auth_role(&requested) {
        return safe.into();
    }
    if matches!(requested.as_str(), ROLE_ADMIN | ROLE_MANAGER | ROLE_OPERATOR) {
        return safe.into();
    }
    requested
}

pub fn role_for_identity(config: &Config, email: &str) -> String {
    let email = email.trim().to_ascii_lowercase();
    if !email.is_empty() && config.bootstrap_admins.contains(&email) {
        return ROLE_ADMIN.into();
    }
    let allowed = [ROLE_RESPONDER, ROLE_VOLUNTEER, ROLE_CITIZEN, ROLE_OPERATOR, ROLE_MANAGER];
    if allowed.contains(&config.default_role.as_str()) {
        config.default_role.clone()
    } else {
        ROLE_RESPONDER.into()
    }
}

pub fn shell_user(username: &str, email: Option<&str>, full_name: Option<&str>, phone: Option<&str>, role: &str) -> AuthUser {
    let role = if is_auth_role(role) { role } else { ROLE_RESPONDER };
    let timestamp = crate::now_iso();
    let email = email
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if username.contains('@') {
                username.to_string()
            } else {
                format!("{username}@sos.synapsecity.sbs")
            }
        });
    AuthUser {
        id: format!("sos-session-{}", Uuid::new_v4()),
        username: username.to_string(),
        email,
        full_name: full_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| username.to_string()),
        phone: phone.map(|value| value.to_string()),
        role: role.to_string(),
        permissions: role_permissions(role),
        status: "active".into(),
        language: "vi".into(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    }
}

fn claims_for(user: &AuthUser, typ: &str, extras: &SessionExtras) -> Claims {
    let now = Utc::now().timestamp();
    let ttl = if typ == "access" {
        ACCESS_TOKEN_TTL_SECONDS
    } else {
        REFRESH_TOKEN_TTL_SECONDS
    };
    Claims {
        sub: user.id.clone(),
        username: user.username.clone(),
        email: user.email.clone(),
        full_name: user.full_name.clone(),
        phone: user.phone.clone(),
        role: user.role.clone(),
        status: user.status.clone(),
        permissions: user.permissions.clone(),
        typ: typ.to_string(),
        iat: now,
        exp: now + ttl,
        jti: Uuid::new_v4().to_string(),
        auth_source: extras.auth_source.clone(),
        tier2_token: extras.tier2_token.clone(),
        tier2_refresh_token: extras.tier2_refresh_token.clone(),
    }
}

fn encode_token(config: &Config, claims: &Claims) -> Result<String, ApiError> {
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(config.auth_secret.as_bytes()),
    )
    .map_err(|error| ApiError::internal(error))
}

pub fn issue_session(config: &Config, user: &AuthUser, extras: SessionExtras) -> Result<AuthResponse, ApiError> {
    let access = claims_for(user, "access", &extras);
    let refresh = claims_for(user, "refresh", &extras);
    Ok(AuthResponse {
        access_token: encode_token(config, &access)?,
        refresh_token: encode_token(config, &refresh)?,
        user: user.clone(),
    })
}

pub fn verify_token(config: &Config, token: &str, expected_type: &str) -> Option<Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    validation.leeway = 0;
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.auth_secret.as_bytes()),
        &validation,
    )
    .ok()?;
    let claims = data.claims;
    if claims.typ != expected_type {
        return None;
    }
    if claims.sub.is_empty() || claims.username.is_empty() {
        return None;
    }
    if claims.auth_source.as_deref() != Some("tier2") && !config.demo_auth_allowed() {
        return None;
    }
    Some(claims)
}

pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("authorization")?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub fn session_from_headers(config: &Config, headers: &HeaderMap) -> Option<Claims> {
    bearer_token(headers).and_then(|token| verify_token(config, &token, "access"))
}

pub fn require_session(config: &Config, headers: &HeaderMap) -> Result<Claims, ApiError> {
    session_from_headers(config, headers).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid SOS session is required.",
        )
    })
}

pub fn require_permission(config: &Config, headers: &HeaderMap, permission: &str) -> Result<Claims, ApiError> {
    let claims = require_session(config, headers)?;
    if has_permission(&claims, permission) {
        Ok(claims)
    } else {
        Err(ApiError::forbidden(
            "forbidden",
            format!("The session does not grant {permission}."),
        ))
    }
}

pub fn user_from_claims(claims: &Claims) -> AuthUser {
    AuthUser {
        id: claims.sub.clone(),
        username: claims.username.clone(),
        email: claims.email.clone(),
        full_name: claims.full_name.clone(),
        phone: claims.phone.clone(),
        role: claims.role.clone(),
        permissions: claims.permissions.clone(),
        status: claims.status.clone(),
        language: "vi".into(),
        created_at: crate::now_iso(),
        updated_at: crate::now_iso(),
    }
}

// ---------------------------------------------------------------------------
// Tier-2 identity
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct VerifiedIdentity {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Tier2Session {
    pub identity: VerifiedIdentity,
    pub token: Option<String>,
    pub refresh_token: Option<String>,
    pub exchanged: bool,
}

fn string_value(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn first_string(values: &[Option<&Value>]) -> String {
    values
        .iter()
        .filter_map(|value| value.and_then(|entry| entry.as_str()))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or("")
        .to_string()
}

fn scopes_of(raw: &Value) -> Vec<String> {
    raw.get("scopes")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn identity_from_session(session: &Value) -> Result<VerifiedIdentity, ApiError> {
    let access_token = first_string(&[session.get("accessToken"), session.get("access_token")]);
    let refresh_token = first_string(&[session.get("refreshToken"), session.get("refresh_token")]);
    let user = session.get("user").cloned().unwrap_or_else(|| json!({}));
    let email = first_string(&[user.get("email"), session.get("email")]).to_ascii_lowercase();
    let user_id = first_string(&[
        user.get("id"),
        user.get("sub"),
        session.get("userId"),
        session.get("sub"),
    ]);
    if user_id.is_empty() && email.is_empty() {
        return Err(ApiError::bad_gateway(
            "identity_missing_subject",
            "The identity provider returned no subject.",
        ));
    }
    let display_name = first_string(&[
        user.get("display_name"),
        user.get("displayName"),
        user.get("full_name"),
    ]);
    let display_name = if display_name.is_empty() {
        if email.is_empty() {
            user_id.clone()
        } else {
            email.clone()
        }
    } else {
        display_name
    };
    let expires_in = session
        .get("expiresIn")
        .or_else(|| session.get("expires_in"))
        .and_then(Value::as_i64);
    let mut scopes = scopes_of(session);
    scopes.extend(scopes_of(&user));
    Ok(VerifiedIdentity {
        user_id: if user_id.is_empty() {
            format!("user-{email}")
        } else {
            user_id
        },
        email,
        display_name,
        access_token: (!access_token.is_empty()).then_some(access_token),
        refresh_token: (!refresh_token.is_empty()).then_some(refresh_token),
        expires_in,
        scopes,
    })
}

pub fn auth_error_status(error: &synapsedx::Error) -> (StatusCode, String, String) {
    match error.status() {
        Some(401) => (
            StatusCode::UNAUTHORIZED,
            "invalid_credentials".into(),
            "Email or password is incorrect.".into(),
        ),
        Some(400) | Some(422) => (
            StatusCode::BAD_REQUEST,
            "invalid_request".into(),
            "The identity provider rejected the request.".into(),
        ),
        Some(403) => (
            StatusCode::FORBIDDEN,
            "auth_rejected".into(),
            "The identity provider rejected this identity operation.".into(),
        ),
        Some(429) => (
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited".into(),
            "Too many authentication attempts.".into(),
        ),
        Some(409) => (
            StatusCode::CONFLICT,
            "identity_conflict".into(),
            "The identity already exists.".into(),
        ),
        Some(503) | Some(502) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "identity_not_configured".into(),
            "The Tier-2 identity capability is unavailable.".into(),
        ),
        Some(404) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "identity_not_configured".into(),
            "The Tier-2 identity capability is not published on this deployment.".into(),
        ),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "identity_not_configured".into(),
            "Identity verification is unavailable.".into(),
        ),
    }
}

pub fn identity_error(error: synapsedx::Error) -> ApiError {
    let (status, code, detail) = auth_error_status(&error);
    ApiError::new(status, code, detail)
}

pub fn exchange_enabled() -> bool {
    matches!(
        std::env::var("SOS_AUTH_EXCHANGE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "true" | "1"
    )
}

pub fn exchange_scopes() -> Vec<String> {
    std::env::var("SOS_AUTH_EXCHANGE_SCOPES")
        .unwrap_or_else(|_| "read,write".into())
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

pub fn bootstrap_admins_set(raw: &str) -> HashSet<String> {
    raw.split(',')
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}
