// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Hazard helpers: stale-feed expiry and the SSE frame format.

use crate::domain::filters::{js_number, now_iso, parse_timestamp, string_or, Data};
use serde_json::Value;

pub const DEFAULT_HAZARD_TTL_HOURS: f64 = 24.0;
pub const MAX_HAZARD_TTL_HOURS: f64 = 24.0 * 30.0;

fn normalize_ttl(hours: f64) -> f64 {
    if !hours.is_finite() || hours <= 0.0 {
        return DEFAULT_HAZARD_TTL_HOURS;
    }
    hours.min(MAX_HAZARD_TTL_HOURS)
}

/// Effective hazard TTL in hours.
///
/// The transport/configuration layer is expected to resolve the
/// `HAZARD_TTL_HOURS` environment value and pass it here as `value`; an
/// unparseable or non-positive value falls back to 24 hours and the result is
/// capped at 30 days.
pub fn hazard_ttl_hours(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => DEFAULT_HAZARD_TTL_HOURS,
        Some(value) => normalize_ttl(js_number(Some(value)).unwrap_or(DEFAULT_HAZARD_TTL_HOURS)),
    }
}

/// Most recent meaningful hazard timestamp, in ms since epoch.
pub fn hazard_timestamp(hazard: &Data) -> Option<i64> {
    for key in [
        "observed_at",
        "created_at",
        "updated_at",
        "detected_at",
        "last_seen_at",
    ] {
        if let Some(timestamp) = hazard.get(key).and_then(Value::as_str).and_then(parse_timestamp) {
            return Some(timestamp);
        }
    }
    None
}

/// A hazard is stale when it is active and older than the TTL.
pub fn is_hazard_stale(hazard: &Data, now_ms: i64, ttl_hours: Option<f64>) -> bool {
    if matches!(hazard.get("is_active"), Some(Value::Bool(false)))
        || string_or(hazard, "status", "") == "expired"
    {
        return false;
    }
    let Some(timestamp) = hazard_timestamp(hazard) else {
        return false;
    };
    let ttl = normalize_ttl(ttl_hours.unwrap_or(DEFAULT_HAZARD_TTL_HOURS));
    (now_ms - timestamp) as f64 > ttl * 60.0 * 60.0 * 1000.0
}

fn json_text(payload: &Value) -> String {
    serde_json::to_string(payload).unwrap_or_else(|_| "null".to_string())
}

/// Wire format for one SSE frame. Real LF bytes, never an escaped `\\n`.
pub fn sse_hazards_frame(payload: &Value, id: Option<&str>) -> String {
    let prefix = id.map(|id| format!("id: {id}\n")).unwrap_or_default();
    format!("{prefix}event: hazards\ndata: {}\n\n", json_text(payload))
}

/// Error frame for a degraded dependency.
///
/// It is a named `error` event so the client can show "data unavailable"
/// without replacing its last good snapshot with a synthetic empty list
/// (issue #10).
pub fn sse_error_frame(payload: &Value, id: Option<&str>) -> String {
    let prefix = id.map(|id| format!("id: {id}\n")).unwrap_or_default();
    format!("{prefix}event: error\ndata: {}\n\n", json_text(payload))
}

/// Heartbeat/comment frame keeps proxies from idling the connection.
pub fn sse_heartbeat_frame(at: Option<&str>) -> String {
    let at = at.map(str::to_string).unwrap_or_else(now_iso);
    format!(": heartbeat {at}\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_791_000_000_000;

    fn row(value: Value) -> Data {
        value.as_object().cloned().unwrap_or_default()
    }

    fn iso_at(offset_minutes: i64) -> String {
        crate::domain::filters::iso_from_millis(NOW + offset_minutes * 60_000).unwrap()
    }

    #[test]
    fn hazard_timestamp_prefers_observed_at() {
        let hazard = row(json!({
            "observed_at": iso_at(-120),
            "created_at": iso_at(-2400),
            "updated_at": iso_at(-60)
        }));
        assert_eq!(
            hazard_timestamp(&hazard),
            parse_timestamp(&iso_at(-120))
        );
        assert!(hazard_timestamp(&row(json!({}))).is_none());
        assert!(hazard_timestamp(&row(json!({"observed_at": "not-a-date"}))).is_none());
    }

    #[test]
    fn old_active_hazards_are_stale() {
        let old = row(json!({"is_active": true, "observed_at": iso_at(-25 * 60)}));
        assert!(is_hazard_stale(&old, NOW, None));
        let fresh = row(json!({"is_active": true, "observed_at": iso_at(-60)}));
        assert!(!is_hazard_stale(&fresh, NOW, None));
    }

    #[test]
    fn inactive_expired_and_untimestamped_hazards_are_not_rewritten() {
        assert!(!is_hazard_stale(
            &row(json!({"is_active": false, "observed_at": "2020-01-01T00:00:00.000Z"})),
            NOW,
            None
        ));
        assert!(!is_hazard_stale(
            &row(json!({"status": "expired", "observed_at": "2020-01-01T00:00:00.000Z"})),
            NOW,
            None
        ));
        assert!(!is_hazard_stale(
            &row(json!({"is_active": true})),
            NOW,
            None
        ));
    }

    #[test]
    fn ttl_is_configurable_but_bounded() {
        assert_eq!(hazard_ttl_hours(None), DEFAULT_HAZARD_TTL_HOURS);
        assert_eq!(hazard_ttl_hours(Some(&json!(2))), 2.0);
        assert_eq!(hazard_ttl_hours(Some(&json!(0))), DEFAULT_HAZARD_TTL_HOURS);
        assert_eq!(
            hazard_ttl_hours(Some(&json!("bad"))),
            DEFAULT_HAZARD_TTL_HOURS
        );
        assert_eq!(hazard_ttl_hours(Some(&json!(24 * 365))), 24.0 * 30.0);
    }

    #[test]
    fn sse_frames_use_real_newline_bytes() {
        let payload = json!({"snapshot": [{"id": "h1"}]});
        let frame = sse_hazards_frame(&payload, None);
        assert_eq!(frame, "event: hazards\ndata: {\"snapshot\":[{\"id\":\"h1\"}]}\n\n");
        assert!(frame.ends_with("\n\n"));
        assert!(frame.starts_with("event: hazards\n"));
        assert!(!frame.contains("\\n"));

        let with_id = sse_error_frame(&json!({"error": "unavailable"}), Some("7"));
        assert!(with_id.starts_with("id: 7\nevent: error\ndata: "));

        let heartbeat = sse_heartbeat_frame(Some("2026-11-03T12:00:00.000Z"));
        assert_eq!(heartbeat, ": heartbeat 2026-11-03T12:00:00.000Z\n\n");
        assert!(sse_heartbeat_frame(None).starts_with(": heartbeat "));
    }
}
