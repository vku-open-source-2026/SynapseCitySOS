// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SITREP validation and lifecycle rules.
//!
//! A SITREP is an operational report, not arbitrary JSON:
//! - it must reference a real emergency event;
//! - it needs a title, an author, a source and a reporting period;
//! - casualty/damage counters are non-negative integers;
//! - the lifecycle is draft -> review_pending -> published;
//! - a published report is immutable. A delta against a published report
//!   creates a new revision with `amends_sitrep_id` instead of mutating
//!   history.

use crate::domain::error::{bad_request, conflict, DomainError};
use crate::domain::filters::{
    iso_from_millis, js_number, js_string, js_truthy, non_null, now_iso, now_millis, number_value,
    parse_timestamp, string_or, Data,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const SITREP_STATUSES: &[&str] = &["draft", "review_pending", "published", "archived"];
pub const IMMUTABLE_SITREP_STATUSES: &[&str] = &["published", "archived"];

pub const COUNT_FIELDS: &[&str] = &[
    "casualties",
    "deaths",
    "injuries",
    "missing",
    "affected_people",
    "evacuated_people",
    "damaged_structures",
    "destroyed_structures",
    "rescued_people",
    "resources_deployed",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldError {
    pub field: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValidationResult {
    pub value: Data,
    pub errors: Vec<FieldError>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SitrepActor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

fn field_error(field: &str, code: &str, message: &str) -> FieldError {
    FieldError {
        field: field.to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn is_iso_date(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(parse_timestamp)
        .is_some()
}

fn is_empty_string(value: &Value) -> bool {
    matches!(value, Value::String(text) if text.is_empty())
}

fn validate_counts(source: &Data, prefix: &str, errors: &mut Vec<FieldError>) {
    for field in COUNT_FIELDS {
        let Some(value) = source.get(*field) else {
            continue;
        };
        if value.is_null() || is_empty_string(value) {
            continue;
        }
        let valid = js_number(Some(value))
            .map(|parsed| parsed.fract() == 0.0 && parsed >= 0.0)
            .unwrap_or(false);
        if !valid {
            errors.push(field_error(
                &format!("{prefix}{field}"),
                "non_negative_integer_required",
                &format!("{field} must be a non-negative integer"),
            ));
        }
    }
    if let Some(numbers) = source.get("numbers") {
        match numbers {
            Value::Object(nested) => validate_counts(nested, &format!("{prefix}numbers."), errors),
            _ => errors.push(field_error(
                &format!("{prefix}numbers"),
                "object_required",
                "numbers must be an object",
            )),
        }
    }
}

fn normalise_counts(source: &Data) -> Data {
    let mut output = source.clone();
    for field in COUNT_FIELDS {
        if let Some(current) = output.get(*field) {
            if !current.is_null() && !is_empty_string(current) {
                if let Some(parsed) = js_number(Some(current)) {
                    output.insert((*field).to_string(), number_value(parsed));
                }
            }
        }
    }
    let numbers = match output.get("numbers") {
        Some(Value::Object(numbers)) => Some(numbers.clone()),
        _ => None,
    };
    if let Some(mut numbers) = numbers {
        for field in COUNT_FIELDS {
            if let Some(current) = numbers.get(*field) {
                if !current.is_null() && !is_empty_string(current) {
                    if let Some(parsed) = js_number(Some(current)) {
                        numbers.insert((*field).to_string(), number_value(parsed));
                    }
                }
            }
        }
        output.insert("numbers".to_string(), Value::Object(numbers));
    }
    output
}

/// Validate a SITREP create payload. Event existence is checked by the route.
pub fn validate_sitrep_create(input: &Data, actor: &SitrepActor) -> ValidationResult {
    let mut errors: Vec<FieldError> = Vec::new();
    let mut value = input.clone();

    let event_id = input
        .get("emergency_event_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if event_id.is_empty() {
        errors.push(field_error(
            "emergency_event_id",
            "required",
            "emergency_event_id is required",
        ));
    }

    let title = input
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if title.is_empty() {
        errors.push(field_error("title", "required", "title is required"));
    }
    value.insert("title".to_string(), Value::String(title.to_string()));

    let period_start = non_null(&value, "reporting_period_start")
        .cloned()
        .or_else(|| {
            value
                .get("reporting_period")
                .and_then(Value::as_object)
                .and_then(|period| non_null(period, "start"))
                .cloned()
        });
    let period_end = non_null(&value, "reporting_period_end")
        .cloned()
        .or_else(|| {
            value
                .get("reporting_period")
                .and_then(Value::as_object)
                .and_then(|period| non_null(period, "end"))
                .cloned()
        });
    if !is_iso_date(period_start.as_ref()) {
        errors.push(field_error(
            "reporting_period_start",
            "iso_date_required",
            "reporting_period_start must be an ISO timestamp",
        ));
    }
    if !is_iso_date(period_end.as_ref()) {
        errors.push(field_error(
            "reporting_period_end",
            "iso_date_required",
            "reporting_period_end must be an ISO timestamp",
        ));
    }
    if let (Some(start), Some(end)) = (
        period_start
            .as_ref()
            .and_then(Value::as_str)
            .and_then(parse_timestamp),
        period_end
            .as_ref()
            .and_then(Value::as_str)
            .and_then(parse_timestamp),
    ) {
        if end < start {
            errors.push(field_error(
                "reporting_period_end",
                "before_start",
                "reporting_period_end must not precede reporting_period_start",
            ));
        }
    }
    let normalized_start = period_start
        .as_ref()
        .and_then(Value::as_str)
        .and_then(parse_timestamp)
        .and_then(iso_from_millis)
        .map(Value::String)
        .unwrap_or(Value::Null);
    let normalized_end = period_end
        .as_ref()
        .and_then(Value::as_str)
        .and_then(parse_timestamp)
        .and_then(iso_from_millis)
        .map(Value::String)
        .unwrap_or(Value::Null);
    value.insert("reporting_period_start".to_string(), normalized_start);
    value.insert("reporting_period_end".to_string(), normalized_end);

    let author = value
        .get("author")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|author| !author.is_empty())
        .map(str::to_string)
        .or_else(|| {
            actor
                .username
                .clone()
                .filter(|username| !username.is_empty())
        })
        .unwrap_or_else(|| "sos-operator".to_string());
    value.insert("author".to_string(), Value::String(author));

    let source = value
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|source| !source.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "sos-console".to_string());
    value.insert("source".to_string(), Value::String(source));

    let status = match value.get("status") {
        None => "draft".to_string(),
        Some(value) => js_string(value),
    };
    if !SITREP_STATUSES.contains(&status.as_str()) {
        errors.push(field_error(
            "status",
            "invalid_status",
            "status must be draft, review_pending, published or archived",
        ));
    }
    if status == "published" || status == "archived" {
        errors.push(field_error(
            "status",
            "publish_requires_review",
            "create a draft and publish it through /publish",
        ));
    }
    let stored_status = if status == "review_pending" {
        "review_pending"
    } else {
        "draft"
    };
    value.insert(
        "status".to_string(),
        Value::String(stored_status.to_string()),
    );

    validate_counts(&value, "", &mut errors);

    ValidationResult {
        value: normalise_counts(&value),
        errors,
    }
}

fn status_index(status: &str) -> i32 {
    SITREP_STATUSES
        .iter()
        .position(|candidate| *candidate == status)
        .map(|index| index as i32)
        .unwrap_or(-1)
}

/// Validate a SITREP update payload against the current record.
pub fn validate_sitrep_update(
    input: &Data,
    current: &Data,
) -> Result<ValidationResult, DomainError> {
    let mut errors: Vec<FieldError> = Vec::new();
    let current_status = string_or(current, "status", "draft");
    if IMMUTABLE_SITREP_STATUSES.contains(&current_status.as_str()) {
        return Err(conflict(
            "sitrep_published_immutable",
            "a published or archived SITREP cannot be mutated; create a delta revision instead",
            None,
        ));
    }
    let mut value = input.clone();
    if value.contains_key("title") {
        let title = value
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        if title.is_empty() {
            errors.push(field_error(
                "title",
                "required",
                "title must not be empty",
            ));
        }
        value.insert("title".to_string(), Value::String(title));
    }
    if value.contains_key("status") {
        let next = value
            .get("status")
            .map(js_string)
            .unwrap_or_else(|| "undefined".to_string());
        if !SITREP_STATUSES.contains(&next.as_str()) {
            errors.push(field_error(
                "status",
                "invalid_status",
                "invalid SITREP status",
            ));
        }
        if status_index(&next) < status_index(&current_status) {
            return Err(conflict(
                "invalid_status_transition",
                format!("cannot move SITREP from {current_status} to {next}"),
                None,
            ));
        }
        if next == "published" || next == "archived" {
            errors.push(field_error(
                "status",
                "publish_requires_review",
                "use /publish to publish a SITREP",
            ));
        }
    }
    validate_counts(&value, "", &mut errors);
    Ok(ValidationResult {
        value: normalise_counts(&value),
        errors,
    })
}

/// A published report cannot be published again without a review cycle.
pub fn assert_publishable(current: &Data) -> Result<(), DomainError> {
    let status = string_or(current, "status", "draft");
    if status == "published" || status == "archived" {
        return Err(conflict(
            "sitrep_already_published",
            "this SITREP is already published; create a delta revision",
            None,
        ));
    }
    let snapshot_has_content = current
        .get("snapshot")
        .filter(|value| js_truthy(value))
        .map(|snapshot| match snapshot {
            Value::Object(map) => !map.is_empty(),
            Value::Array(items) => !items.is_empty(),
            _ => false,
        })
        .unwrap_or(false);
    let summary_has_content = current
        .get("summary")
        .filter(|value| js_truthy(value))
        .map(|summary| !js_string(summary).trim().is_empty())
        .unwrap_or(false);
    let period_has_content = current
        .get("reporting_period_start")
        .map(js_truthy)
        .unwrap_or(false)
        && current
            .get("reporting_period_end")
            .map(js_truthy)
            .unwrap_or(false);
    if !(snapshot_has_content || summary_has_content || period_has_content) {
        return Err(bad_request(
            "sitrep_content_required",
            "a SITREP needs a snapshot, summary or reporting period before publishing",
            None,
        ));
    }
    if status != "review_pending" {
        return Err(conflict(
            "sitrep_review_required",
            format!(
                "move the SITREP to review_pending before publishing (current: {status})"
            ),
            None,
        ));
    }
    Ok(())
}

/// Build a new draft revision that amends a published SITREP.
pub fn revision_from_delta(
    current: &Data,
    delta: &Data,
    actor: &SitrepActor,
    now: Option<String>,
) -> Data {
    let now = now.unwrap_or_else(now_iso);
    let nonce: String = Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(6)
        .collect();
    let id = format!("sitrep-{}-{}", now_millis(), nonce);

    let version = match js_number(current.get("version")) {
        Some(value) if value != 0.0 => value,
        _ => 1.0,
    } + 1.0;

    let mut revision = current.clone();
    revision.insert("id".to_string(), Value::String(id));
    revision.insert("status".to_string(), Value::String("draft".to_string()));
    revision.insert(
        "amends_sitrep_id".to_string(),
        current.get("id").cloned().unwrap_or(Value::Null),
    );
    revision.insert("version".to_string(), number_value(version));

    let mut delta_record = delta.clone();
    delta_record.insert("actor_id".to_string(), actor_id(actor));
    delta_record.insert("created_at".to_string(), Value::String(now.clone()));
    revision.insert(
        "deltas".to_string(),
        Value::Array(vec![Value::Object(delta_record)]),
    );
    revision.insert("published_at".to_string(), Value::Null);
    revision.insert("published_by".to_string(), Value::Null);
    revision.insert("created_at".to_string(), Value::String(now.clone()));
    revision.insert("updated_at".to_string(), Value::String(now.clone()));

    let author = match &actor.username {
        Some(username) => Value::String(username.clone()),
        None => current
            .get("author")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("sos-operator".to_string())),
    };
    revision.insert("author".to_string(), author);
    revision
}

fn actor_id(actor: &SitrepActor) -> Value {
    if let Some(id) = &actor.id {
        return Value::String(id.clone());
    }
    if let Some(username) = &actor.username {
        return Value::String(username.clone());
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(value: Value) -> Data {
        value.as_object().cloned().unwrap_or_default()
    }

    fn period() -> Value {
        json!({
            "reporting_period_start": "2026-11-04T08:00:00.000Z",
            "reporting_period_end": "2026-11-04T14:00:00.000Z"
        })
    }

    fn actor() -> SitrepActor {
        SitrepActor {
            username: Some("qa".to_string()),
            id: None,
        }
    }

    #[test]
    fn create_requires_event_title_period_and_non_negative_counters() {
        let missing = validate_sitrep_create(&row(json!({})), &actor());
        assert!(missing
            .errors
            .iter()
            .any(|error| error.field == "emergency_event_id"));
        assert!(missing.errors.iter().any(|error| error.field == "title"));
        assert!(missing
            .errors
            .iter()
            .any(|error| error.field == "reporting_period_start"));

        let mut negative_value = period().as_object().cloned().unwrap_or_default();
        negative_value.insert("emergency_event_id".into(), json!("e"));
        negative_value.insert("title".into(), json!("T"));
        negative_value.insert("casualties".into(), json!(-2));
        let negative = validate_sitrep_create(&negative_value, &actor());
        assert!(negative
            .errors
            .iter()
            .any(|error| error.field == "casualties"));

        let mut ok_value = period().as_object().cloned().unwrap_or_default();
        ok_value.insert("emergency_event_id".into(), json!("e"));
        ok_value.insert("title".into(), json!("T"));
        ok_value.insert("casualties".into(), json!(2));
        ok_value.insert("numbers".into(), json!({"deaths": 0}));
        let ok = validate_sitrep_create(&ok_value, &actor());
        assert!(ok.errors.is_empty());
        assert_eq!(ok.value["author"], json!("qa"));
        assert_eq!(ok.value["casualties"], json!(2));
        assert_eq!(ok.value["numbers"]["deaths"], json!(0));
    }

    #[test]
    fn a_sitrep_cannot_be_created_already_published() {
        let mut value = period().as_object().cloned().unwrap_or_default();
        value.insert("emergency_event_id".into(), json!("e"));
        value.insert("title".into(), json!("T"));
        value.insert("status".into(), json!("published"));
        let result = validate_sitrep_create(&value, &actor());
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "publish_requires_review"));
        assert_eq!(result.value["status"], json!("draft"));
    }

    #[test]
    fn published_sitreps_are_immutable_and_status_cannot_move_backwards() {
        let immutable = validate_sitrep_update(
            &row(json!({"title": "x"})),
            &row(json!({"status": "published"})),
        );
        assert_eq!(
            immutable.expect_err("immutable").code,
            "sitrep_published_immutable"
        );

        let backwards = validate_sitrep_update(
            &row(json!({"status": "draft"})),
            &row(json!({"status": "review_pending"})),
        );
        assert_eq!(
            backwards.expect_err("backwards").code,
            "invalid_status_transition"
        );
    }

    #[test]
    fn publishing_requires_content_and_a_reviewable_state() {
        assert_eq!(
            assert_publishable(&row(json!({"status": "published"})))
                .expect_err("already published")
                .code,
            "sitrep_already_published"
        );
        assert_eq!(
            assert_publishable(&row(json!({"status": "draft", "snapshot": {}})))
                .expect_err("content required")
                .code,
            "sitrep_content_required"
        );
        assert!(assert_publishable(&row(
            json!({"status": "review_pending", "snapshot": {"summary": "ok"}})
        ))
        .is_ok());
        assert_eq!(
            assert_publishable(&row(
                json!({"status": "draft", "snapshot": {"summary": "ok"}})
            ))
            .expect_err("review required")
            .code,
            "sitrep_review_required"
        );
    }

    #[test]
    fn a_delta_against_a_published_sitrep_creates_a_new_revision() {
        let revision = revision_from_delta(
            &row(json!({
                "id": "s1", "status": "published", "version": 1,
                "emergency_event_id": "e", "title": "T", "author": "qa"
            })),
            &row(json!({"action_type": "update", "changes": {"casualties": 3}})),
            &SitrepActor {
                username: Some("operator".to_string()),
                id: None,
            },
            Some("2026-11-04T12:00:00.000Z".to_string()),
        );
        assert_ne!(revision["id"], json!("s1"));
        assert_eq!(revision["amends_sitrep_id"], json!("s1"));
        assert_eq!(revision["version"], json!(2));
        assert_eq!(revision["status"], json!("draft"));
        assert_eq!(revision["deltas"][0]["actor_id"], json!("operator"));
        assert_eq!(
            revision["deltas"][0]["created_at"],
            json!("2026-11-04T12:00:00.000Z")
        );
        assert_eq!(revision["author"], json!("operator"));
    }

    #[test]
    fn counters_are_normalised_from_numeric_strings() {
        let mut value = period().as_object().cloned().unwrap_or_default();
        value.insert("emergency_event_id".into(), json!("e"));
        value.insert("title".into(), json!("T"));
        value.insert("casualties".into(), json!("3"));
        value.insert("numbers".into(), json!({"deaths": "1"}));
        let result = validate_sitrep_create(&value, &actor());
        assert!(result.errors.is_empty());
        assert_eq!(result.value["casualties"], json!(3));
        assert_eq!(result.value["numbers"]["deaths"], json!(1));
    }
}
