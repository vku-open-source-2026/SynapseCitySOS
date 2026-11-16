// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Axum request/response helpers shared by all SOS handlers.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};

pub const DEFAULT_BODY_LIMIT: usize = 4 * 1024 * 1024;

pub async fn raw_body(req: Request, limit: usize) -> ApiResult<(Bytes, axum::http::HeaderMap, axum::http::Uri)> {
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, limit)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", "The request body is too large."))?;
    Ok((bytes, parts.headers, parts.uri))
}

pub async fn json_body(req: Request, limit: usize) -> ApiResult<(Map<String, Value>, axum::http::HeaderMap, axum::http::Uri)> {
    let (bytes, headers, uri) = raw_body(req, limit).await?;
    if bytes.is_empty() {
        return Ok((Map::new(), headers, uri));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::bad_request(
            "invalid_json",
            "The request body must be a JSON object.",
        )
    })?;
    match value {
        Value::Object(map) => Ok((map, headers, uri)),
        _ => Err(ApiError::bad_request(
            "request_body_must_be_an_object",
            "The request body must be a JSON object.",
        )),
    }
}

pub fn query_map(uri: &axum::http::Uri) -> HashMap<String, String> {
    let mut values = HashMap::new();
    if let Some(query) = uri.query() {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            values.insert(key.into_owned(), value.into_owned());
        }
    }
    values
}

pub fn json_response(value: Value) -> Response {
    (StatusCode::OK, Json(value)).into_response()
}

pub fn status_json(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

pub fn created(value: Value) -> Response {
    status_json(StatusCode::CREATED, value)
}

pub fn accepted(value: Value) -> Response {
    status_json(StatusCode::ACCEPTED, value)
}

pub fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

pub fn text_response(content_type: &str, body: String) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type.to_string())],
        body,
    )
        .into_response()
}

pub fn send_record(data: Map<String, Value>) -> Response {
    let version = data.get("record_version").and_then(Value::as_i64);
    let mut response = json_response(Value::Object(data));
    if let Some(version) = version {
        if let Ok(value) = HeaderValue::from_str(&format!("\"{version}\"")) {
            response.headers_mut().insert(header::ETAG, value);
        }
        if let Ok(value) = HeaderValue::from_str(&version.to_string()) {
            response.headers_mut().insert("x-record-version", value);
        }
    }
    response
}

pub fn bool_value(value: Option<&Value>) -> Option<bool> {
    let value = value?;
    if let Some(value) = value.as_bool() {
        return Some(value);
    }
    match value.as_str()?.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn string_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

pub fn required_string(body: &Map<String, Value>, field: &str) -> Result<String, ApiError> {
    string_value(body.get(field)).ok_or_else(|| {
        ApiError::bad_request(
            format!("field_required:{field}"),
            format!("{field} is required."),
        )
    })
}

pub fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub fn ensure_object(value: Value, code: &str) -> Result<Map<String, Value>, ApiError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(ApiError::bad_request(code, "Expected a JSON object.")),
    }
}
