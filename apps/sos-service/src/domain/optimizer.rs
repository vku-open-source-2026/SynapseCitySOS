// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Deterministic dispatch assignment.
//!
//! This is Tier-3 business logic (matching a task to an emergency resource
//! unit) persisted through the Tier-2 records API. It deliberately does not
//! call a routing provider: ETA is a documented straight-line estimate until
//! the Tier-2 routing/ETA capability exists. The optimizer never invents work:
//! the returned counts are exactly the records it changed.

use crate::domain::filters::{
    js_number, js_string, js_truthy, non_null, parse_timestamp, string_or, Data,
};
use crate::domain::geo::{haversine_meters, LatLng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;

pub const DEFAULT_STALE_MINUTES: f64 = 120.0;
const AVERAGE_RESPONSE_KMH: f64 = 35.0;
const BASE_DISPATCH_MINUTES: f64 = 5.0;

const TERMINAL: &[&str] = &["completed", "canceled", "rejected"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssignmentDecision {
    pub order_id: String,
    pub resource_unit_id: String,
    pub eta_minutes: i64,
    pub distance_km: Option<f64>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OptimizePlan {
    pub assignments: Vec<AssignmentDecision>,
    pub stale: Vec<String>,
    pub unassignable: Vec<String>,
    pub skipped_terminal: Vec<String>,
    pub used_resources: Vec<String>,
}

/// Optional inputs for [`plan_optimization`]. `now_ms` defaults to the current
/// clock; tests and replays should pass an explicit value.
#[derive(Debug, Clone, Copy, Default)]
pub struct OptimizeOptions {
    pub now_ms: Option<i64>,
    pub stale_minutes: Option<f64>,
}

fn coordinates_of(value: Option<&Value>) -> Option<LatLng> {
    let geometry = value?.as_object()?;
    if geometry.get("type").and_then(Value::as_str) != Some("Point") {
        return None;
    }
    let Value::Array(coordinates) = geometry.get("coordinates")? else {
        return None;
    };
    if coordinates.len() < 2 {
        return None;
    }
    let lng = js_number(Some(&coordinates[0]))?;
    let lat = js_number(Some(&coordinates[1]))?;
    if lat.abs() <= 90.0 && lng.abs() <= 180.0 {
        Some(LatLng { lat, lng })
    } else {
        None
    }
}

fn metadata_of(order: &Data) -> Option<&Data> {
    order.get("metadata").and_then(Value::as_object)
}

pub fn required_capability(order: &Data) -> String {
    let metadata = metadata_of(order);
    let value = non_null(order, "required_capability")
        .or_else(|| metadata.and_then(|metadata| non_null(metadata, "required_capability")));
    let capability = match value {
        Some(value) => js_string(value),
        None => "personnel".to_string(),
    };
    capability.to_lowercase()
}

pub fn resource_types_for_capability(capability: &str) -> Vec<&'static str> {
    match capability {
        "personnel" => vec!["personnel"],
        "vehicle" => vec!["vehicle", "personnel"],
        "medical" | "medical_supply" => vec!["medical_supply", "personnel"],
        "rescue" | "rescue_equipment" => vec!["rescue_equipment", "vehicle"],
        "shelter" => vec!["shelter"],
        "communications" => vec!["personnel", "vehicle"],
        "any" => vec![
            "personnel",
            "vehicle",
            "medical_supply",
            "rescue_equipment",
            "shelter",
        ],
        _ => vec!["personnel"],
    }
}

fn resource_eligible(
    resource: &Data,
    capability: &str,
    used: &HashSet<String>,
    order_district: &str,
) -> bool {
    let id = id_of(resource);
    if used.contains(&id) {
        return false;
    }
    let status = string_or(resource, "status", "available");
    // Never auto-assign a unit that is offline, under maintenance, or already
    // deployed.
    if status != "available" {
        return false;
    }
    let resource_type = string_or(resource, "resource_type", "");
    if !resource_types_for_capability(capability).contains(&resource_type.as_str()) {
        return false;
    }
    // A shelter is a fixed facility; do not send it to an unrelated district.
    if resource_type == "shelter" && !order_district.is_empty() {
        let district = string_or(resource, "district", "");
        if !district.is_empty() && district != order_district {
            return false;
        }
    }
    true
}

fn order_district(order: &Data) -> String {
    non_null(order, "district")
        .map(js_string)
        .or_else(|| {
            order
                .get("target_location")
                .and_then(Value::as_object)
                .and_then(|location| non_null(location, "district"))
                .map(js_string)
        })
        .unwrap_or_default()
}

fn score_resource(resource: &Data, order: &Data, distance_meters: Option<f64>) -> f64 {
    let mut score = 0.0;
    let district = order_district(order);
    let ward = string_or(order, "ward", "");
    if !district.is_empty() && string_or(resource, "district", "") == district {
        score += 20.0;
    }
    if !ward.is_empty() && string_or(resource, "ward", "") == ward {
        score += 10.0;
    }
    if let Some(distance) = distance_meters {
        score += (15.0 - distance / 1000.0).max(0.0);
    }
    if let Some(capacity) = js_number(resource.get("capacity")) {
        score += (capacity / 100.0).min(5.0);
    }
    let resource_type = string_or(resource, "resource_type", "");
    if resource_type == string_or(order, "required_resource_type", "") {
        score += 5.0;
    }
    score
}

fn eta_for(resource: &Data, order: &Data, distance_meters: Option<f64>) -> i64 {
    if let Some(distance) = distance_meters {
        return (BASE_DISPATCH_MINUTES + (distance / 1000.0 / AVERAGE_RESPONSE_KMH) * 60.0)
            .round()
            .max(1.0) as i64;
    }
    let resource_district = string_or(resource, "district", "");
    let order_district = string_or(order, "district", "");
    let resource_ward = string_or(resource, "ward", "");
    let order_ward = string_or(order, "ward", "");
    if !resource_ward.is_empty() && resource_ward == order_ward {
        10
    } else if !resource_district.is_empty() && resource_district == order_district {
        20
    } else {
        45
    }
}

fn order_string(order: &Data, key: &str, fallback: &str) -> String {
    string_or(order, key, fallback)
}

fn is_terminal(order: &Data) -> bool {
    TERMINAL.contains(&order_string(order, "status", "pending").as_str())
}

fn priority_rank(priority: &str) -> i32 {
    match priority {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 2,
    }
}

fn created_at(order: &Data) -> i64 {
    order
        .get("created_at")
        .map(js_string)
        .and_then(|value| parse_timestamp(&value))
        .unwrap_or(0)
}

fn id_of(row: &Data) -> String {
    row.get("id")
        .map(js_string)
        .unwrap_or_else(|| "undefined".to_string())
}

/// `order.assigned_resource_unit_id ?? assignments[*].(assigned_resource_unit_id
/// ?? resource_unit_id).find(Boolean)`.
fn existing_assignment(order: &Data) -> Option<String> {
    if let Some(value) = order.get("assigned_resource_unit_id") {
        if !value.is_null() {
            return if js_truthy(value) {
                Some(js_string(value))
            } else {
                None
            };
        }
    }
    let Value::Array(assignments) = order.get("assignments")? else {
        return None;
    };
    for assignment in assignments {
        let Some(assignment) = assignment.as_object() else {
            continue;
        };
        let candidate = match assignment.get("assigned_resource_unit_id") {
            Some(value) if !value.is_null() => Some(value),
            _ => assignment
                .get("resource_unit_id")
                .filter(|value| !value.is_null()),
        };
        if let Some(value) = candidate {
            if js_truthy(value) {
                return Some(js_string(value));
            }
        }
    }
    None
}

#[derive(Default)]
struct UsedUnits {
    ordered: Vec<String>,
    set: HashSet<String>,
}

impl UsedUnits {
    fn contains(&self, id: &str) -> bool {
        self.set.contains(id)
    }

    fn insert(&mut self, id: String) {
        if self.set.insert(id.clone()) {
            self.ordered.push(id);
        }
    }
}

struct Candidate<'a> {
    resource: &'a Data,
    distance: Option<f64>,
    score: f64,
}

/// Build a deterministic dispatch plan.
///
/// Highest priority first, then oldest first, then id, matching the TypeScript
/// implementation. A unit can only be used once per run.
pub fn plan_optimization(
    orders: &[Data],
    resources: &[Data],
    options: OptimizeOptions,
) -> OptimizePlan {
    let now_ms = options.now_ms.unwrap_or_else(|| {
        chrono::Utc::now().timestamp_millis()
    });
    let stale_minutes = options.stale_minutes.unwrap_or(DEFAULT_STALE_MINUTES);
    let mut used = UsedUnits::default();
    let mut assignments: Vec<AssignmentDecision> = Vec::new();
    let mut stale: Vec<String> = Vec::new();
    let mut unassignable: Vec<String> = Vec::new();
    let mut skipped_terminal: Vec<String> = Vec::new();

    for order in orders {
        if is_terminal(order) {
            skipped_terminal.push(id_of(order));
        }
    }

    let mut sorted: Vec<&Data> = orders.iter().filter(|order| !is_terminal(order)).collect();
    sorted.sort_by(|left, right| {
        let left_priority = priority_rank(&order_string(left, "priority", "medium"));
        let right_priority = priority_rank(&order_string(right, "priority", "medium"));
        if left_priority != right_priority {
            return left_priority.cmp(&right_priority);
        }
        let left_created = created_at(left);
        let right_created = created_at(right);
        if left_created != right_created {
            return left_created.cmp(&right_created);
        }
        id_of(left).cmp(&id_of(right))
    });

    for order in sorted {
        let order_id = id_of(order);
        if let Some(existing) = existing_assignment(order) {
            // Already assigned: keep it, but still count it as used so a
            // second order cannot steal the same unit in the same run.
            used.insert(existing);
            continue;
        }
        let capability = required_capability(order);
        let district = order_district(order);
        let order_point = coordinates_of(order.get("target_location"));
        let mut candidates: Vec<Candidate<'_>> = resources
            .iter()
            .filter(|resource| resource_eligible(resource, &capability, &used.set, &district))
            .map(|resource| {
                let resource_point = coordinates_of(resource.get("current_location"));
                let distance = match (order_point, resource_point) {
                    (Some(order_point), Some(resource_point)) => {
                        Some(haversine_meters(order_point, resource_point))
                    }
                    _ => None,
                };
                let score = score_resource(resource, order, distance);
                Candidate {
                    resource,
                    distance,
                    score,
                }
            })
            .collect();
        candidates.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| id_of(left.resource).cmp(&id_of(right.resource)))
        });

        let Some(chosen) = candidates.first() else {
            unassignable.push(order_id.clone());
            let created = parse_timestamp(
                &order
                    .get("created_at")
                    .map(js_string)
                    .unwrap_or_default(),
            );
            if let Some(created) = created {
                if (now_ms - created) as f64 > stale_minutes * 60.0 * 1000.0 {
                    stale.push(order_id);
                }
            }
            continue;
        };

        let resource_id = id_of(chosen.resource);
        used.insert(resource_id.clone());
        assignments.push(AssignmentDecision {
            order_id,
            resource_unit_id: resource_id,
            eta_minutes: eta_for(chosen.resource, order, chosen.distance),
            distance_km: chosen
                .distance
                .map(|distance| ((distance / 1000.0) * 10.0).round() / 10.0),
            reason: if chosen.distance.is_none() {
                "district-and-capability-match".to_string()
            } else {
                "nearest-compatible-unit".to_string()
            },
        });
    }

    OptimizePlan {
        assignments,
        stale,
        unassignable,
        skipped_terminal,
        used_resources: used.ordered,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_793_000_000_000; // 2026-11-04T... arbitrary fixed clock

    fn row(value: Value) -> Data {
        value.as_object().cloned().unwrap_or_default()
    }

    fn created(value: &str) -> i64 {
        parse_timestamp(value).expect("timestamp")
    }

    #[test]
    fn capability_mapping_covers_sos_resource_types() {
        assert_eq!(
            resource_types_for_capability("medical"),
            vec!["medical_supply", "personnel"]
        );
        assert_eq!(
            resource_types_for_capability("shelter"),
            vec!["shelter"]
        );
        assert_eq!(
            required_capability(&row(json!({"metadata": {"required_capability": "vehicle"}}))),
            "vehicle"
        );
        assert_eq!(required_capability(&row(json!({}))), "personnel");
    }

    #[test]
    fn optimizer_assigns_only_available_compatible_units_and_never_reuses_one() {
        let orders = vec![
            row(json!({
                "id": "o1", "status": "pending", "priority": "critical", "district": "A",
                "required_capability": "personnel", "created_at": "2026-11-04T10:00:00.000Z"
            })),
            row(json!({
                "id": "o2", "status": "pending", "priority": "high", "district": "A",
                "required_capability": "personnel", "created_at": "2026-11-04T10:05:00.000Z"
            })),
        ];
        let resources = vec![
            row(json!({"id": "r1", "status": "available", "resource_type": "personnel", "district": "A", "capacity": 10})),
            row(json!({"id": "r2", "status": "offline", "resource_type": "personnel", "district": "A"})),
            row(json!({"id": "r3", "status": "maintenance", "resource_type": "personnel", "district": "A"})),
            row(json!({"id": "r4", "status": "available", "resource_type": "medical_supply", "district": "A"})),
        ];
        let plan = plan_optimization(
            &orders,
            &resources,
            OptimizeOptions {
                now_ms: Some(NOW),
                stale_minutes: None,
            },
        );
        assert_eq!(plan.assignments.len(), 1);
        assert_eq!(plan.assignments[0].resource_unit_id, "r1");
        assert_eq!(plan.unassignable, vec!["o2"]);
    }

    #[test]
    fn optimizer_prefers_the_nearest_compatible_unit_and_computes_eta() {
        let orders = vec![row(json!({
            "id": "o1", "status": "pending", "priority": "high",
            "required_capability": "personnel",
            "target_location": {"type": "Point", "coordinates": [108, 16]},
            "created_at": "2026-11-04T11:00:00.000Z"
        }))];
        let resources = vec![
            row(json!({"id": "far", "status": "available", "resource_type": "personnel", "current_location": {"type": "Point", "coordinates": [109, 17]}})),
            row(json!({"id": "near", "status": "available", "resource_type": "personnel", "current_location": {"type": "Point", "coordinates": [108.01, 16]}})),
        ];
        let plan = plan_optimization(
            &orders,
            &resources,
            OptimizeOptions {
                now_ms: Some(NOW),
                stale_minutes: None,
            },
        );
        assert_eq!(plan.assignments[0].resource_unit_id, "near");
        assert!(plan.assignments[0].eta_minutes >= 1);
        assert!(plan.assignments[0].distance_km.unwrap() < 5.0);
        assert_eq!(plan.assignments[0].reason, "nearest-compatible-unit");
    }

    #[test]
    fn optimizer_flags_stale_unassignable_orders_and_skips_terminal_orders() {
        let orders = vec![
            row(json!({"id": "stale", "status": "pending", "priority": "low", "required_capability": "shelter", "created_at": "2026-11-04T08:00:00.000Z"})),
            row(json!({"id": "done", "status": "completed", "priority": "low", "created_at": "2026-11-04T08:00:00.000Z"})),
        ];
        let plan = plan_optimization(
            &orders,
            &[],
            OptimizeOptions {
                now_ms: Some(created("2026-11-04T12:00:00.000Z")),
                stale_minutes: Some(120.0),
            },
        );
        assert_eq!(plan.unassignable, vec!["stale"]);
        assert_eq!(plan.stale, vec!["stale"]);
        assert_eq!(plan.skipped_terminal, vec!["done"]);
    }

    #[test]
    fn optimizer_keeps_an_already_assigned_unit_reserved() {
        let orders = vec![
            row(json!({"id": "a", "status": "assigned", "assigned_resource_unit_id": "r1", "priority": "high", "created_at": "2026-11-04T10:00:00.000Z"})),
            row(json!({"id": "b", "status": "pending", "priority": "high", "required_capability": "personnel", "created_at": "2026-11-04T10:00:00.000Z"})),
        ];
        let resources = vec![row(json!({"id": "r1", "status": "available", "resource_type": "personnel"}))];
        let plan = plan_optimization(
            &orders,
            &resources,
            OptimizeOptions {
                now_ms: Some(NOW),
                stale_minutes: None,
            },
        );
        assert!(plan.assignments.is_empty());
        assert_eq!(plan.used_resources, vec!["r1"]);
        assert_eq!(plan.unassignable, vec!["b"]);
    }

    #[test]
    fn eta_falls_back_to_district_and_ward_when_coordinates_are_missing() {
        let order = row(json!({"id": "o", "status": "pending", "ward": "W", "district": "D"}));
        let same_ward = row(json!({"id": "r", "status": "available", "resource_type": "personnel", "ward": "W", "district": "D"}));
        let same_district = row(json!({"id": "r", "status": "available", "resource_type": "personnel", "district": "D"}));
        assert_eq!(eta_for(&same_ward, &order, None), 10);
        assert_eq!(eta_for(&same_district, &order, None), 20);
        assert_eq!(eta_for(&row(json!({"id": "r"})), &order, None), 45);
    }

    #[test]
    fn shelters_are_not_sent_to_an_unrelated_district() {
        let order = row(json!({"id": "o", "status": "pending", "required_capability": "shelter", "district": "A"}));
        let resources = vec![row(json!({"id": "s1", "status": "available", "resource_type": "shelter", "district": "B"}))];
        let plan = plan_optimization(
            &orders_vec(order),
            &resources,
            OptimizeOptions {
                now_ms: Some(NOW),
                stale_minutes: None,
            },
        );
        assert_eq!(plan.unassignable, vec!["o"]);
    }

    fn orders_vec(order: Data) -> Vec<Data> {
        vec![order]
    }
}
