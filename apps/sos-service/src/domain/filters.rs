// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Query filtering and pagination helpers.
//!
//! The SOS service pages datasets first and filters in memory because the
//! Tier-2 records API currently exposes only `limit`/`offset`. The important
//! correctness rule is that supported query keys are interpreted with their
//! real types: a generic string comparison made `active_only=true` match
//! nothing (issue #11).

use crate::domain::error::DomainError;
use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::Value;

/// A record payload: a JSON object without a fixed schema.
pub type Data = serde_json::Map<String, Value>;

pub const MAX_SCAN_RECORDS: usize = 5_000;
pub const SCAN_PAGE_SIZE: usize = 500;

/// Milliseconds since the Unix epoch as an ISO-8601 UTC string with
/// millisecond precision, matching JavaScript `Date#toISOString()`.
pub fn iso_from_millis(ms: i64) -> Option<String> {
    chrono::DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Current wall-clock time in milliseconds since the Unix epoch.
pub fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

/// Current wall-clock time as an ISO-8601 string.
pub fn now_iso() -> String {
    iso_from_millis(now_millis()).unwrap_or_default()
}

/// Parse an ISO-8601-ish timestamp into milliseconds since the epoch.
///
/// This accepts RFC 3339 (the form SOS stores), a timezone-less
/// `YYYY-MM-DDTHH:MM:SS` value (interpreted as UTC) and a bare date.
pub fn parse_timestamp(value: &str) -> Option<i64> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(Utc.from_utc_datetime(&naive).timestamp_millis());
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f") {
        return Some(Utc.from_utc_datetime(&naive).timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|naive| Utc.from_utc_datetime(&naive).timestamp_millis());
    }
    None
}

/// JavaScript `Number(value)`, restricted to finite results.
///
/// `None` represents a missing/undefined value (`NaN` in JavaScript), while a
/// JSON `null` becomes `0`. Strings are trimmed; empty strings are `0`; an
/// empty array is `0` and a single-element array is converted recursively.
pub fn js_number(value: Option<&Value>) -> Option<f64> {
    match value {
        None => None,
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(flag)) => Some(if *flag { 1.0 } else { 0.0 }),
        Some(Value::Number(number)) => number.as_f64().filter(|n| n.is_finite()),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
        }
        Some(Value::Array(items)) => {
            if items.is_empty() {
                Some(0.0)
            } else if items.len() == 1 {
                js_number(Some(&items[0]))
            } else {
                None
            }
        }
        Some(Value::Object(_)) => None,
    }
}

fn number_to_js_string(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    if let Some(value) = number.as_f64() {
        if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
            return (value as i64).to_string();
        }
        return value.to_string();
    }
    number.to_string()
}

/// JavaScript `String(value)` for JSON values.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_js_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JavaScript truthiness for JSON values.
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Fetch a key only when it is present and not JSON `null`.
pub fn non_null<'a>(data: &'a Data, key: &str) -> Option<&'a Value> {
    data.get(key).filter(|value| !value.is_null())
}

/// `String(row[key] ?? fallback)`, with a nullish fallback.
pub fn string_or(data: &Data, key: &str, fallback: &str) -> String {
    match data.get(key) {
        Some(value) if !value.is_null() => js_string(value),
        _ => fallback.to_string(),
    }
}

/// Render a finite number the way JavaScript `${number}` does.
pub fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        (value as i64).to_string()
    } else {
        value.to_string()
    }
}

/// Encode a non-negative integer in base 36, matching `Number#toString(36)`.
pub fn base36(mut value: u128) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buffer = Vec::new();
    while value > 0 {
        buffer.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    buffer.reverse();
    String::from_utf8(buffer).unwrap_or_default()
}

/// Convert a JavaScript number-ish value into a `serde_json::Value`.
///
/// `serde_json::Number` cannot represent `NaN`/infinity, so non-finite values
/// become `null`. Integral values are stored as integers so JSON output stays
/// stable (`2`, not `2.0`).
pub fn number_value(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// Parse a boolean query value; `undefined` means "not supplied".
pub fn parse_boolean(value: Option<&Value>) -> Option<bool> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(Value::String(text)) if text.is_empty() => None,
        Some(other) => {
            let normalized = js_string(other).trim().to_lowercase();
            match normalized.as_str() {
                "true" | "1" | "yes" | "on" => Some(true),
                "false" | "0" | "no" | "off" => Some(false),
                _ => None,
            }
        }
    }
}

/// Options for [`parse_number`].
#[derive(Debug, Clone, Copy, Default)]
pub struct NumberOptions {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub fallback: Option<f64>,
}

/// Parse a finite number query value, clamped to `[min, max]`.
pub fn parse_number(value: Option<&Value>, options: &NumberOptions) -> Option<f64> {
    if value.is_none() || matches!(value, Some(Value::Null)) {
        return options.fallback;
    }
    if let Some(Value::String(text)) = value {
        if text.is_empty() {
            return options.fallback;
        }
    }
    let Some(parsed) = js_number(value) else {
        return options.fallback;
    };
    let mut result = parsed;
    if let Some(minimum) = options.min {
        result = result.max(minimum);
    }
    if let Some(maximum) = options.max {
        result = result.min(maximum);
    }
    Some(result)
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number_to_js_string(number)),
        _ => None,
    }
}

fn timestamp_of(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::String(text)) => parse_timestamp(text),
        _ => None,
    }
}

const TIME_FIELDS: &[&str] = &[
    "observed_at",
    "detected_at",
    "issued_at",
    "created_at",
    "updated_at",
    "started_at",
    "last_seen_at",
];

/// Most recent meaningful record timestamp, in milliseconds since the epoch.
pub fn record_timestamp(row: &Data) -> Option<i64> {
    for field in TIME_FIELDS {
        if let Some(parsed) = timestamp_of(row.get(*field)) {
            return Some(parsed);
        }
    }
    None
}

const PAGING_KEYS: &[&str] = &["limit", "skip", "offset", "page", "page_size"];
const BOOLEAN_KEYS: &[&str] = &["active_only", "is_active"];
const TEXT_KEYS: &[&str] = &[
    "event_type",
    "severity",
    "source",
    "district",
    "ward",
    "status",
    "event_id",
    "emergency_event_id",
    "eop_plan_id",
    "resource_type",
    "priority",
    "linked_event_id",
    "report_code",
];

fn matches_text(row: &Data, key: &str, expected: &str) -> bool {
    let expected = expected.to_lowercase();
    let candidates: Vec<Option<&Value>> = if key == "event_id" {
        vec![row.get("event_id"), row.get("emergency_event_id")]
    } else {
        vec![row.get(key)]
    };
    candidates.into_iter().any(|candidate| {
        candidate
            .and_then(text)
            .map(|candidate| candidate.to_lowercase() == expected)
            .unwrap_or(false)
    })
}

fn active_with_archived(row: &Data) -> bool {
    !matches!(row.get("is_active"), Some(Value::Bool(false)))
        && string_or(row, "status", "") != "expired"
        && string_or(row, "status", "") != "archived"
}

fn active_basic(row: &Data) -> bool {
    !matches!(row.get("is_active"), Some(Value::Bool(false)))
        && string_or(row, "status", "") != "expired"
}

/// Filter rows by the supported query contract. Unknown keys are ignored on
/// purpose: a typo must never turn a list into an empty success response.
///
/// `now_ms` is explicit so the function stays deterministic; pass
/// [`now_millis`] from the transport layer for live behaviour.
pub fn filter_rows(rows: &[Data], query: &Data, now_ms: i64) -> Vec<Data> {
    let active_only = parse_boolean(query.get("active_only"));
    let is_active = parse_boolean(query.get("is_active"));
    let hours = parse_number(
        query.get("hours"),
        &NumberOptions {
            min: Some(0.0),
            max: Some((24 * 365) as f64),
            fallback: None,
        },
    );
    let q = query.get("q").and_then(text).map(|text| text.to_lowercase());
    let cutoff = hours
        .filter(|hours| *hours > 0.0)
        .map(|hours| now_ms as f64 - hours * 60.0 * 60.0 * 1000.0);

    rows.iter()
        .filter(|row| {
            if let Some(expected) = active_only {
                if active_with_archived(row) != expected {
                    return false;
                }
            }
            if let Some(expected) = is_active {
                if active_basic(row) != expected {
                    return false;
                }
            }
            for (key, value) in query {
                if PAGING_KEYS.contains(&key.as_str()) || BOOLEAN_KEYS.contains(&key.as_str()) {
                    continue;
                }
                if key == "hours" || key == "q" {
                    continue;
                }
                if TEXT_KEYS.contains(&key.as_str()) {
                    if let Some(expected) = text(value) {
                        if !matches_text(row, key, &expected) {
                            return false;
                        }
                    }
                }
                // Unknown keys are ignored rather than silently filtering
                // everything out.
            }
            if let Some(cutoff) = cutoff {
                match record_timestamp(row) {
                    Some(stamp) if (stamp as f64) >= cutoff => {}
                    _ => return false,
                }
            }
            if let Some(needle) = &q {
                let haystack = [
                    row.get("id"),
                    row.get("hazard_id"),
                    row.get("title"),
                    row.get("description"),
                    row.get("task_title"),
                    row.get("report_code"),
                ]
                .into_iter()
                .filter_map(|value| value.and_then(text))
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
                if !haystack.contains(needle.as_str()) {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect()
}

/// One item returned by a records `listPage` call.
#[derive(Debug, Clone, PartialEq)]
pub struct PageItem<T> {
    pub id: String,
    pub data: T,
}

/// The subset of a records page the paginator needs.
#[derive(Debug, Clone, PartialEq)]
pub struct PageLike<T> {
    pub items: Vec<PageItem<T>>,
    /// Present when the upstream page reports a dataset total.
    pub total: Option<f64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// The request passed to the caller's page loader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageQuery {
    pub limit: usize,
    pub offset: usize,
}

/// Result of a bounded multi-page scan.
#[derive(Debug, Clone, PartialEq)]
pub struct Paginated<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub scanned: usize,
    pub truncated: bool,
}

/// Bounded scan policy.
#[derive(Debug, Clone, Copy, Default)]
pub struct PageOptions {
    pub max_records: Option<usize>,
    pub page_size: Option<usize>,
}

/// Read every page of a dataset up to a bounded scan budget.
///
/// The result reports whether the scan was truncated so callers can be honest
/// about incomplete answers instead of silently returning a partial list.
/// The loader is synchronous: the async transport adapter is responsible for
/// awaiting its HTTP call before invoking this function.
pub fn page_all<T, F>(
    mut list_page: F,
    options: PageOptions,
) -> Result<Paginated<T>, DomainError>
where
    F: FnMut(PageQuery) -> Result<PageLike<T>, DomainError>,
{
    let max_records = options.max_records.unwrap_or(MAX_SCAN_RECORDS).max(1);
    let page_size = options.page_size.unwrap_or(SCAN_PAGE_SIZE).max(1);
    let mut items: Vec<T> = Vec::new();
    let mut offset: usize = 0;
    let mut scanned: usize = 0;
    let mut truncated = false;

    while scanned < max_records {
        let page = list_page(PageQuery {
            limit: page_size.min(max_records - scanned),
            offset,
        })?;
        let batch_len = page.items.len();
        for item in page.items {
            items.push(item.data);
            scanned += 1;
        }
        let total = page.total.filter(|value| value.is_finite());
        offset += batch_len;
        if batch_len == 0 {
            break;
        }
        if let Some(total) = total {
            if offset as f64 >= total {
                break;
            }
        }
        if batch_len < page_size {
            break;
        }
        if scanned >= max_records {
            truncated = match total {
                Some(total) => (offset as f64) < total,
                None => true,
            };
            break;
        }
    }

    let total = items.len();
    Ok(Paginated {
        items,
        total,
        scanned,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(value: Value) -> Data {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn parse_boolean_accepts_the_documented_spellings() {
        assert_eq!(parse_boolean(Some(&json!(true))), Some(true));
        assert_eq!(parse_boolean(Some(&json!(" YES "))), Some(true));
        assert_eq!(parse_boolean(Some(&json!("off"))), Some(false));
        assert_eq!(parse_boolean(Some(&json!(1))), Some(true));
        assert_eq!(parse_boolean(Some(&json!(0))), Some(false));
        assert_eq!(parse_boolean(Some(&json!("maybe"))), None);
        assert_eq!(parse_boolean(None), None);
    }

    #[test]
    fn parse_number_clamps_and_uses_the_fallback() {
        let options = NumberOptions {
            min: Some(0.0),
            max: Some(100.0),
            fallback: Some(50.0),
        };
        assert_eq!(parse_number(Some(&json!(150)), &options), Some(100.0));
        assert_eq!(parse_number(Some(&json!(-5)), &options), Some(0.0));
        assert_eq!(parse_number(Some(&json!("abc")), &options), Some(50.0));
        assert_eq!(parse_number(None, &options), Some(50.0));
        assert_eq!(parse_number(Some(&json!("")), &options), Some(50.0));
    }

    #[test]
    fn record_timestamp_prefers_observed_at() {
        let record = row(json!({
            "observed_at": "2026-11-03T10:00:00.000Z",
            "created_at": "2026-11-01T00:00:00.000Z",
            "updated_at": "2026-11-03T11:00:00.000Z"
        }));
        assert_eq!(
            record_timestamp(&record),
            parse_timestamp("2026-11-03T10:00:00.000Z")
        );
    }

    #[test]
    fn active_only_and_text_filters_use_real_types() {
        let rows = vec![
            row(json!({"id": "a", "status": "active", "is_active": true, "event_type": "flood", "severity": "high"})),
            row(json!({"id": "b", "status": "expired", "event_type": "flood", "severity": "low"})),
            row(json!({"id": "c", "status": "archived", "event_type": "storm", "severity": "high"})),
        ];
        let active = filter_rows(&rows, &row(json!({"active_only": "true"})), 0);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["id"], json!("a"));

        let floods = filter_rows(&rows, &row(json!({"event_type": "FLOOD"})), 0);
        assert_eq!(floods.len(), 2);

        let unknown = filter_rows(&rows, &row(json!({"typo_key": "x"})), 0);
        assert_eq!(unknown.len(), 3);
    }

    #[test]
    fn hours_filter_excludes_missing_and_old_timestamps() {
        let now = parse_timestamp("2026-11-04T12:00:00.000Z").unwrap();
        let rows = vec![
            row(json!({"id": "fresh", "observed_at": "2026-11-04T11:00:00.000Z"})),
            row(json!({"id": "old", "observed_at": "2026-11-01T11:00:00.000Z"})),
            row(json!({"id": "none"})),
        ];
        let result = filter_rows(&rows, &row(json!({"hours": 6})), now);
        assert_eq!(
            result.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(),
            vec![json!("fresh")]
        );
    }

    #[test]
    fn q_searches_the_supported_text_fields() {
        let rows = vec![
            row(json!({"id": "h1", "title": "Flood in Hai Chau"})),
            row(json!({"id": "h2", "description": "Landslide"})),
        ];
        let result = filter_rows(&rows, &row(json!({"q": "flood"})), 0);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["id"], json!("h1"));
    }

    #[test]
    fn page_all_stops_at_total_and_reports_truncation() {
        let pages = vec![
            vec![
                PageItem {
                    id: "1".into(),
                    data: 1,
                },
                PageItem {
                    id: "2".into(),
                    data: 2,
                },
            ],
            vec![PageItem {
                id: "3".into(),
                data: 3,
            }],
        ];
        let mut cursor = 0usize;
        let result = page_all(
            |_query| {
                let page = pages.get(cursor).cloned().unwrap_or_default();
                cursor += 1;
                Ok(PageLike {
                    items: page,
                    total: Some(3.0),
                    limit: None,
                    offset: None,
                })
            },
            PageOptions {
                max_records: Some(2),
                page_size: Some(2),
            },
        )
        .expect("page scan");
        assert_eq!(result.items, vec![1, 2]);
        assert_eq!(result.scanned, 2);
        assert!(result.truncated);
        assert_eq!(result.total, 2);
    }

    #[test]
    fn page_all_handles_an_empty_dataset() {
        let result = page_all(
            |_query| {
                Ok(PageLike::<i32> {
                    items: Vec::new(),
                    total: Some(0.0),
                    limit: None,
                    offset: None,
                })
            },
            PageOptions::default(),
        )
        .expect("page scan");
        assert!(result.items.is_empty());
        assert!(!result.truncated);
    }
}
