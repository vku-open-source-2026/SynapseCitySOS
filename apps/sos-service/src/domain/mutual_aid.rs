// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Mutual-aid request semantics (issue #23).
//!
//! SOS owns the request/accept/decline/handoff state machine; partner agencies
//! integrate through the public SOS boundary only. No City API or shared
//! database is used.

use crate::domain::error::DomainError;
use crate::domain::filters::{
    base36, js_number, js_string, js_truthy, non_null, now_millis, number_value, Data,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutualAidStatus {
    Open,
    PartiallyFilled,
    Filled,
    Declined,
    HandedOff,
}

impl MutualAidStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::PartiallyFilled => "partially_filled",
            Self::Filled => "filled",
            Self::Declined => "declined",
            Self::HandedOff => "handed_off",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MutualAidRequest {
    pub id: String,
    pub request_number: String,
    pub resource_type: String,
    pub quantity: f64,
    pub filled_quantity: f64,
    pub location: Data,
    pub urgency: String,
    pub contact: Data,
    pub requesting_agency: String,
    pub status: MutualAidStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub history: Vec<Data>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MutualAidAccept {
    pub unit_id: String,
    pub accepted_quantity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta_minutes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact: Option<Data>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<f64>,
}

/// The validated subset of a create payload (the fields the service owns are
/// added at persistence time).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValidatedMutualAidRequest {
    pub request_number: String,
    pub resource_type: String,
    pub quantity: f64,
    pub filled_quantity: f64,
    pub location: Data,
    pub urgency: String,
    pub contact: Data,
    pub requesting_agency: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AcceptValidation {
    pub remaining: f64,
    pub available: f64,
}

fn object_or_empty(value: Option<&Value>) -> Data {
    value
        .filter(|value| js_truthy(value))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Optimistic-concurrency guard used by the accept route.
pub fn assert_request_version(
    request: &Data,
    expected: Option<f64>,
) -> Result<(), DomainError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let current = match request.get("record_version") {
        Some(value) if js_truthy(value) => js_number(Some(value)).unwrap_or(f64::NAN),
        _ => 0.0,
    };
    if current != expected {
        return Err(DomainError::conflict(
            "request_version_conflict",
            "request_version_conflict",
            None,
        ));
    }
    Ok(())
}

/// Stable duplicate detection for partner retries.
pub fn duplicate_request<'a>(
    rows: &'a [Data],
    request_number: &str,
) -> Option<&'a Data> {
    rows.iter().find(|row| {
        let candidate = row
            .get("request_number")
            .filter(|value| js_truthy(value))
            .map(js_string)
            .unwrap_or_default();
        candidate == request_number
    })
}

pub fn valid_urgency(value: Option<&Value>) -> String {
    let raw = value
        .map(js_string)
        .unwrap_or_else(|| "undefined".to_string());
    if ["low", "medium", "high", "critical"].contains(&raw.as_str()) {
        raw
    } else {
        "medium".to_string()
    }
}

/// Validate a mutual-aid create payload. `Err` carries the stable error code.
pub fn validate_request(input: &Data) -> Result<ValidatedMutualAidRequest, String> {
    let resource_type = input
        .get("resource_type")
        .filter(|value| js_truthy(value))
        .map(js_string)
        .unwrap_or_default()
        .trim()
        .to_string();
    if resource_type.is_empty() || resource_type.chars().count() > 100 {
        return Err("resource_type_required".to_string());
    }

    let quantity = js_number(input.get("quantity"));
    let Some(quantity) = quantity.filter(|quantity| *quantity > 0.0 && *quantity <= 100_000.0)
    else {
        return Err("invalid_quantity".to_string());
    };

    let agency = input
        .get("requesting_agency")
        .filter(|value| js_truthy(value))
        .map(js_string)
        .unwrap_or_default()
        .trim()
        .to_string();
    if agency.is_empty() || agency.chars().count() > 200 {
        return Err("requesting_agency_required".to_string());
    }

    let location = object_or_empty(input.get("location"));
    let contact = object_or_empty(input.get("contact"));

    let request_number = match input.get("request_number").filter(|value| js_truthy(value)) {
        Some(value) => js_string(value),
        None => format!("MA-{}", base36(now_millis().max(0) as u128).to_uppercase()),
    };
    let request_number: String = request_number.chars().take(64).collect();

    let notes = input
        .get("notes")
        .filter(|value| js_truthy(value))
        .map(|value| js_string(value).chars().take(2000).collect());

    Ok(ValidatedMutualAidRequest {
        request_number,
        resource_type,
        quantity,
        filled_quantity: 0.0,
        location,
        urgency: valid_urgency(input.get("urgency")),
        contact,
        requesting_agency: agency,
        notes,
    })
}

/// Validate a partial/full fill against the request and the lending unit.
pub fn validate_accept(
    request: &MutualAidRequest,
    input: &MutualAidAccept,
    unit: &Data,
) -> Result<AcceptValidation, DomainError> {
    if !matches!(
        request.status,
        MutualAidStatus::Open | MutualAidStatus::PartiallyFilled
    ) {
        return Err(DomainError::conflict(
            "request_not_open",
            "request_not_open",
            None,
        ));
    }
    if input.unit_id.trim().is_empty() {
        return Err(DomainError::bad_request(
            "unit_id_required",
            "unit_id_required",
            None,
        ));
    }
    let accepted = input.accepted_quantity;
    let remaining = (request.quantity - request.filled_quantity).max(0.0);
    if !accepted.is_finite() || accepted <= 0.0 {
        return Err(DomainError::bad_request(
            "invalid_accepted_quantity",
            "invalid_accepted_quantity",
            None,
        ));
    }
    if accepted > remaining {
        return Err(DomainError::conflict(
            "quantity_exceeds_request",
            "quantity_exceeds_request",
            Some(json!({ "remaining": remaining })),
        ));
    }
    if matches!(string_or_status(unit).as_str(), "offline" | "maintenance") {
        return Err(DomainError::conflict(
            "resource_unit_unavailable",
            "resource_unit_unavailable",
            None,
        ));
    }
    let available = non_null(unit, "available_quantity")
        .or_else(|| non_null(unit, "capacity"))
        .or_else(|| non_null(unit, "quantity"))
        .and_then(|value| js_number(Some(value)))
        .unwrap_or(accepted);
    if accepted > available {
        return Err(DomainError::conflict(
            "insufficient_capacity",
            "insufficient_capacity",
            Some(json!({ "available": available })),
        ));
    }
    Ok(AcceptValidation {
        remaining,
        available,
    })
}

fn string_or_status(unit: &Data) -> String {
    match unit.get("status").filter(|value| js_truthy(value)) {
        Some(value) => js_string(value),
        None => String::new(),
    }
}

/// Public status projection: no contact, agency detail or precise coordinates.
pub fn public_mutual_aid_projection(request: &MutualAidRequest) -> Data {
    let mut location = Data::new();
    if let Some(city) = request.location.get("city").filter(|value| js_truthy(value)) {
        location.insert("city".to_string(), city.clone());
    }
    if let Some(address) = request
        .location
        .get("address")
        .filter(|value| js_truthy(value))
    {
        let address = js_string(address);
        let area = address.split(',').next().unwrap_or("");
        location.insert(
            "area".to_string(),
            Value::String(area.chars().take(120).collect()),
        );
    }

    let mut projection = Data::new();
    projection.insert("id".to_string(), Value::String(request.id.clone()));
    projection.insert(
        "request_number".to_string(),
        Value::String(request.request_number.clone()),
    );
    projection.insert(
        "resource_type".to_string(),
        Value::String(request.resource_type.clone()),
    );
    projection.insert("quantity".to_string(), number_value(request.quantity));
    projection.insert(
        "filled_quantity".to_string(),
        number_value(request.filled_quantity),
    );
    projection.insert(
        "remaining_quantity".to_string(),
        number_value((request.quantity - request.filled_quantity).max(0.0)),
    );
    projection.insert(
        "status".to_string(),
        Value::String(request.status.as_str().to_string()),
    );
    projection.insert(
        "urgency".to_string(),
        Value::String(request.urgency.clone()),
    );
    projection.insert("location".to_string(), Value::Object(location));
    projection.insert(
        "updated_at".to_string(),
        Value::String(request.updated_at.clone()),
    );
    projection
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(value: Value) -> Data {
        value.as_object().cloned().unwrap_or_default()
    }

    fn request() -> MutualAidRequest {
        MutualAidRequest {
            id: "ma-1".to_string(),
            request_number: "MA-1".to_string(),
            resource_type: "ambulance".to_string(),
            quantity: 10.0,
            filled_quantity: 2.0,
            location: row(json!({
                "latitude": 21.0278,
                "longitude": 105.8342,
                "address": "12 Main Street, Hanoi",
                "city": "Hanoi"
            })),
            urgency: "high".to_string(),
            contact: row(json!({
                "name": "Duty officer",
                "phone": "0900000000",
                "email": "duty@example.com",
                "agency": "Partner EMS"
            })),
            requesting_agency: "Partner EMS".to_string(),
            status: MutualAidStatus::PartiallyFilled,
            notes: None,
            history: Vec::new(),
            created_at: "2026-11-01T00:00:00Z".to_string(),
            updated_at: "2026-11-01T00:00:00Z".to_string(),
            created_by: None,
        }
    }

    #[test]
    fn request_validation_checks_required_capacity_fields_and_dedupes_retries() {
        let valid = validate_request(&row(json!({
            "resource_type": "ambulance",
            "quantity": 10,
            "requesting_agency": "Partner EMS",
            "location": {"city": "Hanoi"},
            "urgency": "high"
        })))
        .expect("valid request");
        assert_eq!(valid.filled_quantity, 0.0);
        assert_eq!(valid.urgency, "high");

        assert_eq!(
            validate_request(&row(json!({"quantity": 10, "requesting_agency": "x"}))),
            Err("resource_type_required".to_string())
        );
        assert_eq!(
            validate_request(&row(json!({"resource_type": "ambulance", "quantity": 0, "requesting_agency": "x"}))),
            Err("invalid_quantity".to_string())
        );
        assert_eq!(
            validate_request(&row(json!({"resource_type": "ambulance", "quantity": 1}))),
            Err("requesting_agency_required".to_string())
        );

        let rows = vec![request_to_data(&request())];
        assert_eq!(duplicate_request(&rows, "MA-1").unwrap()["id"], json!("ma-1"));
        assert!(duplicate_request(&rows, "MA-2").is_none());
    }

    fn request_to_data(request: &MutualAidRequest) -> Data {
        serde_json::to_value(request)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    #[test]
    fn partial_fills_never_exceed_capacity() {
        let request = request();
        let partial = validate_accept(
            &request,
            &MutualAidAccept {
                unit_id: "unit-1".to_string(),
                accepted_quantity: 3.0,
                eta_minutes: Some(20.0),
                contact: None,
                expected_version: None,
            },
            &row(json!({"status": "available", "available_quantity": 5})),
        )
        .expect("valid accept");
        assert_eq!(partial.remaining, 8.0);
        assert_eq!(partial.available, 5.0);

        let exceed = validate_accept(
            &request,
            &MutualAidAccept {
                unit_id: "unit-1".to_string(),
                accepted_quantity: 9.0,
                eta_minutes: None,
                contact: None,
                expected_version: None,
            },
            &row(json!({"available_quantity": 20})),
        )
        .expect_err("exceeds request");
        assert_eq!(exceed.code, "quantity_exceeds_request");

        let offline = validate_accept(
            &request,
            &MutualAidAccept {
                unit_id: "unit-1".to_string(),
                accepted_quantity: 1.0,
                eta_minutes: None,
                contact: None,
                expected_version: None,
            },
            &row(json!({"status": "offline"})),
        )
        .expect_err("offline unit");
        assert_eq!(offline.code, "resource_unit_unavailable");

        let capacity = validate_accept(
            &request,
            &MutualAidAccept {
                unit_id: "unit-1".to_string(),
                accepted_quantity: 4.0,
                eta_minutes: None,
                contact: None,
                expected_version: None,
            },
            &row(json!({"available_quantity": 2})),
        )
        .expect_err("insufficient capacity");
        assert_eq!(capacity.code, "insufficient_capacity");

        let mut filled = request.clone();
        filled.status = MutualAidStatus::Filled;
        let closed = validate_accept(
            &filled,
            &MutualAidAccept {
                unit_id: "unit-1".to_string(),
                accepted_quantity: 1.0,
                eta_minutes: None,
                contact: None,
                expected_version: None,
            },
            &row(json!({})),
        )
        .expect_err("closed request");
        assert_eq!(closed.code, "request_not_open");
    }

    #[test]
    fn optimistic_versions_reject_the_second_accept_in_a_race() {
        let current = row(json!({"record_version": 4}));
        assert!(assert_request_version(&current, Some(4.0)).is_ok());
        let error = assert_request_version(&current, Some(3.0)).expect_err("conflict");
        assert_eq!(error.status, 409);
        assert_eq!(error.code, "request_version_conflict");
        assert!(assert_request_version(&current, None).is_ok());
    }

    #[test]
    fn public_projection_removes_contact_agency_and_coordinates() {
        let projection = public_mutual_aid_projection(&request());
        assert!(!projection.contains_key("contact"));
        assert!(!projection.contains_key("requesting_agency"));
        let location = projection["location"].as_object().expect("location");
        assert!(!location.contains_key("latitude"));
        assert!(!location.contains_key("longitude"));
        assert_eq!(location["city"], json!("Hanoi"));
        assert_eq!(location["area"], json!("12 Main Street"));
        let serialized = serde_json::to_string(&projection).unwrap();
        assert!(!serialized.contains("0900000000"));
        assert!(!serialized.contains("duty@example.com"));
        assert!(!serialized.contains("Partner EMS"));
    }

    #[test]
    fn urgency_validation_falls_back_to_medium() {
        assert_eq!(valid_urgency(Some(&json!("high"))), "high");
        assert_eq!(valid_urgency(Some(&json!("urgent"))), "medium");
        assert_eq!(valid_urgency(None), "medium");
    }
}
