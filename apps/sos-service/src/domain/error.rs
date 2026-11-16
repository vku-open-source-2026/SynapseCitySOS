// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Small HTTP-shaped domain error shared by the SOS modules.
//!
//! The TypeScript service throws `HttpError`; the Rust port returns this value
//! so a transport layer can render it with the same status and stable
//! machine-readable code.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// A domain failure with an HTTP status and a stable machine-readable code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DomainError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl DomainError {
    /// Create an error. An empty message falls back to the code, matching
    /// `super(message || code)` in the TypeScript constructor.
    pub fn new(
        status: u16,
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        let code = code.into();
        let raw_message = message.into();
        let message = if raw_message.is_empty() {
            code.clone()
        } else {
            raw_message
        };
        Self {
            status,
            code,
            message,
            details,
        }
    }

    /// 400 Bad Request.
    pub fn bad_request(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self::new(400, code, message, details)
    }

    /// 409 Conflict.
    pub fn conflict(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self::new(409, code, message, details)
    }

    /// 404 Not Found. Defaults to `not_found` when the code is empty.
    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        let code = default_code(code, "not_found");
        Self::new(404, code, message, None)
    }

    /// 403 Forbidden. Defaults to `forbidden` when the code is empty.
    pub fn forbidden(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        let code = default_code(code, "forbidden");
        Self::new(403, code, message, details)
    }

    /// 502 Bad Gateway. Defaults to `upstream_invalid_response`.
    pub fn bad_gateway(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        let code = default_code(code, "upstream_invalid_response");
        Self::new(502, code, message, details)
    }

    /// 503 Service Unavailable. Defaults to `capability_unavailable`.
    pub fn service_unavailable(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        let code = default_code(code, "capability_unavailable");
        Self::new(503, code, message, details)
    }
}

fn default_code(code: impl Into<String>, fallback: &str) -> String {
    let code = code.into();
    if code.is_empty() {
        fallback.to_string()
    } else {
        code
    }
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for DomainError {}

/// Free-function form of [`DomainError::bad_request`].
pub fn bad_request(
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<Value>,
) -> DomainError {
    DomainError::bad_request(code, message, details)
}

/// Free-function form of [`DomainError::conflict`].
pub fn conflict(
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<Value>,
) -> DomainError {
    DomainError::conflict(code, message, details)
}

/// Free-function form of [`DomainError::not_found`].
pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> DomainError {
    DomainError::not_found(code, message)
}

/// Free-function form of [`DomainError::forbidden`].
pub fn forbidden(
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<Value>,
) -> DomainError {
    DomainError::forbidden(code, message, details)
}

/// Free-function form of [`DomainError::bad_gateway`].
pub fn bad_gateway(
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<Value>,
) -> DomainError {
    DomainError::bad_gateway(code, message, details)
}

/// Free-function form of [`DomainError::service_unavailable`].
pub fn service_unavailable(
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<Value>,
) -> DomainError {
    DomainError::service_unavailable(code, message, details)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn constructors_match_the_typescript_status_codes() {
        let e = bad_request("invalid_geometry", "bad shape", None);
        assert_eq!(e.status, 400);
        assert_eq!(e.code, "invalid_geometry");
        assert_eq!(e.message, "bad shape");
        assert_eq!(e.details, None);

        assert_eq!(conflict("duplicate", "", None).status, 409);
        assert_eq!(not_found("not_found", "").status, 404);
        assert_eq!(bad_gateway("", "oops", None).code, "upstream_invalid_response");
        assert_eq!(
            service_unavailable("", "down", None).code,
            "capability_unavailable"
        );
    }

    #[test]
    fn empty_message_falls_back_to_the_code() {
        let e = conflict("request_not_open", "", None);
        assert_eq!(e.message, "request_not_open");
        assert_eq!(e.to_string(), "request_not_open");
    }

    #[test]
    fn details_are_preserved() {
        let e = bad_request("bad", "bad", Some(json!({ "field": "x" })));
        assert_eq!(e.details, Some(json!({ "field": "x" })));
    }
}
