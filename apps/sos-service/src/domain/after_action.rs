// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! After-action report (AAR) KPI engine.
//!
//! All inputs are SOS records loaded through the Tier-2 records API. The
//! formula is deterministic and documented here and in README.md:
//!
//! ```text
//! response_time_minutes = first assigned dispatch (or event end) - event start
//! response_speed_score  = severity SLA band -> 100/80/60/40/20/0
//! dispatch_completion   = completed / (created - canceled) x 100
//! sitrep_coverage       = published SITREPs / ceil(duration_hours / 6) x 100
//! resource_efficiency   = unique assigned units / (available + assigned) x 100
//! overall_score         = 0.3*response + 0.3*dispatch + 0.2*sitrep + 0.2*resource
//! ```
//!
//! Scores are 0..100 and rounded to two decimals; a missing input yields 0,
//! never NaN or a fake success.

use crate::domain::filters::{
    iso_from_millis, js_string, js_truthy, now_millis, number_text, parse_timestamp, string_or,
    Data,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AfterActionTimelineEntry {
    pub timestamp: String,
    pub source: String,
    pub action: String,
    pub details: Data,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AfterActionKpi {
    pub response_time_minutes: f64,
    pub response_sla_minutes: f64,
    pub response_speed_score: f64,
    pub dispatch_completion_rate: f64,
    pub sitrep_coverage_rate: f64,
    pub resource_efficiency_score: f64,
    pub overall_score: f64,
    pub dispatch_total: usize,
    pub dispatch_completed: usize,
    pub dispatch_canceled: usize,
    pub sitrep_published: usize,
    pub sitrep_expected: i64,
    pub resources_assigned: usize,
    pub resources_available: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputedAfterAction {
    pub timeline: Vec<AfterActionTimelineEntry>,
    pub kpi: AfterActionKpi,
    pub summary: String,
    pub metadata: Data,
}

/// Inputs for [`compute_after_action`]. Optional collections default to empty
/// and `now_ms` defaults to the current clock.
#[derive(Debug, Clone)]
pub struct AfterActionInput<'a> {
    pub event: &'a Data,
    pub orders: &'a [Data],
    pub sitreps: &'a [Data],
    pub resources: &'a [Data],
    pub now_ms: Option<i64>,
}

impl<'a> AfterActionInput<'a> {
    pub fn new(event: &'a Data) -> Self {
        Self {
            event,
            orders: &[],
            sitreps: &[],
            resources: &[],
            now_ms: None,
        }
    }

    pub fn with_orders(mut self, orders: &'a [Data]) -> Self {
        self.orders = orders;
        self
    }

    pub fn with_sitreps(mut self, sitreps: &'a [Data]) -> Self {
        self.sitreps = sitreps;
        self
    }

    pub fn with_resources(mut self, resources: &'a [Data]) -> Self {
        self.resources = resources;
        self
    }

    pub fn with_now_ms(mut self, now_ms: i64) -> Self {
        self.now_ms = Some(now_ms);
        self
    }
}

fn sla_minutes_for(severity: &str) -> f64 {
    match severity {
        "critical" => 30.0,
        "high" => 60.0,
        "medium" => 120.0,
        "low" => 240.0,
        _ => 120.0,
    }
}

fn parse_time_value(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_str).and_then(parse_timestamp)
}

fn parse_time_field(row: &Data, key: &str) -> Option<i64> {
    parse_time_value(row.get(key))
}

fn iso(ms: i64) -> String {
    iso_from_millis(ms).unwrap_or_default()
}

fn round(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    (value * factor).round() / factor
}

fn clamp_score(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    round(value.clamp(0.0, 100.0), 2)
}

/// SLA-band response score. A response that never happened scores 0.
pub fn response_speed_score(
    minutes: Option<f64>,
    sla_minutes: f64,
    responded: bool,
) -> f64 {
    if !responded {
        return 0.0;
    }
    let Some(minutes) = minutes else {
        return 0.0;
    };
    if minutes <= sla_minutes {
        100.0
    } else if minutes <= sla_minutes * 1.5 {
        80.0
    } else if minutes <= sla_minutes * 2.0 {
        60.0
    } else if minutes <= sla_minutes * 4.0 {
        40.0
    } else {
        20.0
    }
}

fn assignment_time(order: &Data) -> Option<i64> {
    if let Some(Value::Array(assignments)) = order.get("assignments") {
        for assignment in assignments {
            let Some(assignment) = assignment.as_object() else {
                continue;
            };
            if let Some(time) = parse_time_field(assignment, "assigned_at") {
                return Some(time);
            }
        }
    }
    parse_time_field(order, "assigned_at").or_else(|| parse_time_field(order, "started_at"))
}

fn id_of(row: &Data) -> String {
    row.get("id")
        .map(js_string)
        .unwrap_or_else(|| "undefined".to_string())
}

fn assigned_resource_id(order: &Data) -> Option<&Value> {
    order
        .get("assigned_resource_unit_id")
        .filter(|value| !value.is_null())
        .or_else(|| {
            order
                .get("assigned_user_id")
                .filter(|value| !value.is_null())
        })
}

fn details_with(row: &Data, fields: &[(&str, &str)]) -> Data {
    let mut details = Data::new();
    for (target, source) in fields {
        if let Some(value) = row.get(*source) {
            details.insert((*target).to_string(), value.clone());
        }
    }
    details
}

/// Compute the AAR timeline, KPIs and summary for one emergency event.
pub fn compute_after_action(input: &AfterActionInput<'_>) -> ComputedAfterAction {
    let event = input.event;
    let orders = input.orders;
    let sitreps = input.sitreps;
    let resources = input.resources;
    let now_ms = input.now_ms.unwrap_or_else(now_millis);

    let event_created = parse_time_field(event, "created_at");
    let event_started = parse_time_field(event, "started_at");
    let event_start = event_started.or(event_created);
    let event_status = string_or(event, "status", "");
    let event_ended = parse_time_field(event, "ended_at").or_else(|| {
        if event_status == "resolved" {
            parse_time_field(event, "updated_at")
        } else {
            None
        }
    });
    let severity = string_or(event, "severity", "medium");
    let sla_minutes = sla_minutes_for(&severity);
    let mut timeline: Vec<AfterActionTimelineEntry> = Vec::new();

    if let Some(created) = event_created {
        timeline.push(AfterActionTimelineEntry {
            timestamp: iso(created),
            source: "event".to_string(),
            action: "event.created".to_string(),
            details: details_with(event, &[("event_id", "id"), ("title", "title")]),
        });
    }
    if let Some(started) = event_started {
        let mut details = Data::new();
        details.insert("severity".to_string(), Value::String(severity.clone()));
        if let Some(event_type) = event.get("event_type") {
            details.insert("event_type".to_string(), event_type.clone());
        }
        timeline.push(AfterActionTimelineEntry {
            timestamp: iso(started),
            source: "event".to_string(),
            action: "event.started".to_string(),
            details,
        });
    }

    let mut first_assignment: Option<i64> = None;
    let mut completed: usize = 0;
    let mut canceled: usize = 0;
    let mut assigned_resources: HashSet<String> = HashSet::new();
    for order in orders {
        if let Some(created) = parse_time_field(order, "created_at") {
            timeline.push(AfterActionTimelineEntry {
                timestamp: iso(created),
                source: "dispatch".to_string(),
                action: "dispatch.created".to_string(),
                details: details_with(
                    order,
                    &[
                        ("order_id", "id"),
                        ("task_title", "task_title"),
                        ("priority", "priority"),
                    ],
                ),
            });
        }
        if let Some(assigned_at) = assignment_time(order) {
            if first_assignment.is_none() || assigned_at < first_assignment.unwrap() {
                first_assignment = Some(assigned_at);
            }
            let mut details = details_with(order, &[("order_id", "id")]);
            details.insert(
                "resource_unit_id".to_string(),
                assigned_resource_id(order).cloned().unwrap_or(Value::Null),
            );
            timeline.push(AfterActionTimelineEntry {
                timestamp: iso(assigned_at),
                source: "dispatch".to_string(),
                action: "dispatch.assigned".to_string(),
                details,
            });
        }
        if let Some(resource_id) = assigned_resource_id(order) {
            if js_truthy(resource_id) {
                assigned_resources.insert(js_string(resource_id));
            }
        }
        let status = string_or(order, "status", "");
        if status == "completed" {
            completed += 1;
            if let Some(completed_at) =
                parse_time_field(order, "completed_at").or_else(|| parse_time_field(order, "updated_at"))
            {
                timeline.push(AfterActionTimelineEntry {
                    timestamp: iso(completed_at),
                    source: "dispatch".to_string(),
                    action: "dispatch.completed".to_string(),
                    details: details_with(order, &[("order_id", "id")]),
                });
            }
        } else if status == "canceled" || status == "rejected" {
            canceled += 1;
        }
    }

    let mut published_sitreps: usize = 0;
    for sitrep in sitreps {
        if let Some(created) = parse_time_field(sitrep, "created_at") {
            timeline.push(AfterActionTimelineEntry {
                timestamp: iso(created),
                source: "sitrep".to_string(),
                action: "sitrep.created".to_string(),
                details: details_with(sitrep, &[("sitrep_id", "id"), ("title", "title")]),
            });
        }
        if string_or(sitrep, "status", "") == "published" {
            published_sitreps += 1;
            if let Some(published) = parse_time_field(sitrep, "published_at")
                .or_else(|| parse_time_field(sitrep, "updated_at"))
            {
                timeline.push(AfterActionTimelineEntry {
                    timestamp: iso(published),
                    source: "sitrep".to_string(),
                    action: "sitrep.published".to_string(),
                    details: details_with(sitrep, &[("sitrep_id", "id")]),
                });
            }
        }
    }

    if parse_time_field(event, "ended_at").is_some() || event_status == "resolved" {
        let ended = parse_time_field(event, "ended_at")
            .or_else(|| parse_time_field(event, "updated_at"))
            .unwrap_or(now_ms);
        let mut details = Data::new();
        details.insert(
            "status".to_string(),
            Value::String(string_or(event, "status", "resolved")),
        );
        timeline.push(AfterActionTimelineEntry {
            timestamp: iso(ended),
            source: "event".to_string(),
            action: "event.resolved".to_string(),
            details,
        });
    }

    timeline.sort_by(|left, right| {
        let left_time = parse_timestamp(&left.timestamp).unwrap_or(0);
        let right_time = parse_timestamp(&right.timestamp).unwrap_or(0);
        left_time
            .cmp(&right_time)
            .then_with(|| left.action.cmp(&right.action))
    });

    let response_at = first_assignment.or(event_ended);
    let responded = first_assignment.is_some();
    let response_minutes = match (event_start, response_at) {
        (Some(start), Some(response)) => Some(round(
            ((response - start) as f64 / 60_000.0).max(0.0),
            1,
        )),
        _ => None,
    };

    let counted_orders = orders
        .iter()
        .filter(|order| {
            let status = string_or(order, "status", "");
            status != "canceled" && status != "rejected"
        })
        .count();
    let dispatch_completion = if counted_orders > 0 {
        round((completed as f64 / counted_orders as f64) * 100.0, 2)
    } else {
        0.0
    };

    let duration_ms = match event_start {
        Some(start) => ((event_ended.unwrap_or(now_ms) - start) as f64).max(0.0),
        None => 0.0,
    };
    let expected_sitreps = ((duration_ms / (6.0 * 60.0 * 60.0 * 1000.0)).ceil() as i64).max(1);
    let sitrep_coverage = round(
        (published_sitreps.min(expected_sitreps as usize) as f64 / expected_sitreps as f64)
            * 100.0,
        2,
    );

    let available_resources = resources
        .iter()
        .filter(|resource| {
            string_or(resource, "status", "") == "available"
                && !assigned_resources.contains(&id_of(resource))
        })
        .count();
    let denominator = available_resources + assigned_resources.len();
    let resource_efficiency = if denominator > 0 {
        round(
            (assigned_resources.len() as f64 / denominator as f64) * 100.0,
            2,
        )
    } else {
        0.0
    };

    let response_score = response_speed_score(response_minutes, sla_minutes, responded);
    let overall = round(
        0.3 * response_score
            + 0.3 * dispatch_completion
            + 0.2 * sitrep_coverage
            + 0.2 * resource_efficiency,
        2,
    );

    let kpi = AfterActionKpi {
        response_time_minutes: response_minutes.unwrap_or(0.0),
        response_sla_minutes: sla_minutes,
        response_speed_score: clamp_score(response_score),
        dispatch_completion_rate: clamp_score(dispatch_completion),
        sitrep_coverage_rate: clamp_score(sitrep_coverage),
        resource_efficiency_score: clamp_score(resource_efficiency),
        overall_score: clamp_score(overall),
        dispatch_total: orders.len(),
        dispatch_completed: completed,
        dispatch_canceled: canceled,
        sitrep_published: published_sitreps,
        sitrep_expected: expected_sitreps,
        resources_assigned: assigned_resources.len(),
        resources_available: available_resources,
    };

    let event_code = event
        .get("event_code")
        .filter(|value| !value.is_null())
        .map(js_string)
        .unwrap_or_else(|| id_of(event));
    let event_title = event
        .get("title")
        .filter(|value| !value.is_null())
        .map(js_string)
        .unwrap_or_default();
    let response_sentence = if responded {
        format!(
            "Phản ứng đầu tiên sau {} phút (SLA {} phút).",
            number_text(response_minutes.unwrap_or(0.0)),
            number_text(sla_minutes)
        )
    } else {
        "Không ghi nhận phân công phản ứng nào.".to_string()
    };
    let summary = format!(
        "Sự kiện {} ({}) kết thúc với {}/{} nhiệm vụ hoàn thành. {} {}/{} SITREP đã xuất bản; {} nguồn lực được điều động.",
        event_code,
        event_title,
        completed,
        counted_orders,
        response_sentence,
        published_sitreps,
        expected_sitreps,
        assigned_resources.len()
    );

    let metadata = json!({
        "generated_by": "sos-kpi-engine-v1",
        "formula": "overall=0.3*response+0.3*dispatch+0.2*sitrep+0.2*resource",
        "event_start": event_start.map(iso),
        "event_end": event_ended.map(iso),
        "first_assignment_at": first_assignment.map(iso),
        "sla_minutes": sla_minutes,
        "computed_at": iso(now_ms),
    });
    let metadata = metadata.as_object().cloned().unwrap_or_default();

    ComputedAfterAction {
        timeline,
        kpi,
        summary,
        metadata,
    }
}

/// Compute the SOS timeline SLA column from real thresholds.
pub fn sla_breach_count(
    event: &Data,
    first_assignment_at: Option<i64>,
    now_ms: i64,
) -> i64 {
    let severity = string_or(event, "severity", "medium");
    let sla_minutes = sla_minutes_for(&severity);
    let Some(start) = parse_time_field(event, "started_at")
        .or_else(|| parse_time_field(event, "created_at"))
    else {
        return 0;
    };
    let status = string_or(event, "status", "");
    let terminal = status == "resolved" || status == "canceled";
    let end = parse_time_field(event, "ended_at").or_else(|| {
        if terminal {
            parse_time_field(event, "updated_at")
        } else {
            Some(now_ms)
        }
    });
    let Some(response) = first_assignment_at.or(end) else {
        return 0;
    };
    let elapsed = (response - start) as f64 / 60_000.0;
    if elapsed > sla_minutes {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: i64 = 1_791_000_000_000;

    fn iso_at(offset_minutes: i64) -> String {
        iso_from_millis(START + offset_minutes * 60_000).expect("iso")
    }

    fn row(value: Value) -> Data {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn empty_event_produces_zero_metrics_without_nan() {
        let event = row(json!({
            "id": "e", "title": "Empty", "status": "resolved", "severity": "medium",
            "created_at": iso_at(0), "ended_at": iso_at(120), "updated_at": iso_at(120)
        }));
        let computed = compute_after_action(
            &AfterActionInput::new(&event).with_now_ms(START + 120 * 60_000),
        );
        assert_eq!(computed.kpi.dispatch_total, 0);
        assert_eq!(computed.kpi.dispatch_completion_rate, 0.0);
        assert_eq!(computed.kpi.resource_efficiency_score, 0.0);
        assert!(computed.kpi.overall_score.is_finite());
        assert!(computed.timeline.len() >= 2);
    }

    #[test]
    fn kpi_values_match_a_fixture_event() {
        let event = row(json!({
            "id": "e", "title": "Flood", "status": "resolved", "severity": "high",
            "created_at": iso_at(0), "started_at": iso_at(0),
            "ended_at": iso_at(360), "updated_at": iso_at(360)
        }));
        let orders = vec![
            row(json!({"id": "1", "status": "completed", "created_at": iso_at(10), "completed_at": iso_at(100), "assigned_resource_unit_id": "r1", "assignments": [{"assigned_at": iso_at(30)}]})),
            row(json!({"id": "2", "status": "completed", "created_at": iso_at(15), "completed_at": iso_at(200), "assigned_resource_unit_id": "r2", "assignments": [{"assigned_at": iso_at(40)}]})),
            row(json!({"id": "3", "status": "canceled", "created_at": iso_at(20)})),
        ];
        let sitreps = vec![row(json!({
            "id": "s1", "status": "published", "created_at": iso_at(60), "published_at": iso_at(70)
        }))];
        let resources = vec![
            row(json!({"id": "r1", "status": "available"})),
            row(json!({"id": "r2", "status": "available"})),
            row(json!({"id": "r3", "status": "offline"})),
        ];
        let computed = compute_after_action(
            &AfterActionInput::new(&event)
                .with_orders(&orders)
                .with_sitreps(&sitreps)
                .with_resources(&resources)
                .with_now_ms(START + 360 * 60_000),
        );
        assert_eq!(computed.kpi.response_time_minutes, 30.0);
        assert_eq!(computed.kpi.response_sla_minutes, 60.0);
        assert_eq!(computed.kpi.response_speed_score, 100.0);
        assert_eq!(computed.kpi.dispatch_completion_rate, 100.0);
        assert_eq!(computed.kpi.sitrep_coverage_rate, 100.0);
        assert_eq!(computed.kpi.resource_efficiency_score, 100.0);
        assert_eq!(computed.kpi.overall_score, 100.0);
        assert_eq!(computed.kpi.dispatch_total, 3);
        assert_eq!(computed.kpi.dispatch_completed, 2);
        assert_eq!(computed.kpi.dispatch_canceled, 1);
        assert_eq!(computed.kpi.resources_assigned, 2);
        assert!(computed
            .timeline
            .iter()
            .all(|entry| parse_timestamp(&entry.timestamp).is_some()));
        let mut sorted = computed.timeline.clone();
        sorted.sort_by(|left, right| {
            parse_timestamp(&left.timestamp)
                .unwrap()
                .cmp(&parse_timestamp(&right.timestamp).unwrap())
                .then_with(|| left.action.cmp(&right.action))
        });
        assert_eq!(
            computed
                .timeline
                .iter()
                .map(|entry| entry.timestamp.clone())
                .collect::<Vec<_>>(),
            sorted
                .iter()
                .map(|entry| entry.timestamp.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn partial_data_degrades_the_score_instead_of_fabricating_success() {
        let event = row(json!({
            "id": "e", "title": "Partial", "status": "active", "severity": "critical",
            "created_at": iso_at(0), "started_at": iso_at(0)
        }));
        let orders = vec![row(json!({"id": "1", "status": "pending", "created_at": iso_at(5)}))];
        let resources = vec![row(json!({"id": "r1", "status": "available"}))];
        let computed = compute_after_action(
            &AfterActionInput::new(&event)
                .with_orders(&orders)
                .with_resources(&resources)
                .with_now_ms(START + 600 * 60_000),
        );
        assert_eq!(computed.kpi.dispatch_completion_rate, 0.0);
        assert_eq!(computed.kpi.sitrep_coverage_rate, 0.0);
        assert_eq!(computed.kpi.response_speed_score, 0.0);
        assert!(computed.kpi.overall_score < 30.0);
    }

    #[test]
    fn response_speed_score_follows_the_documented_sla_bands() {
        assert_eq!(response_speed_score(Some(10.0), 60.0, true), 100.0);
        assert_eq!(response_speed_score(Some(80.0), 60.0, true), 80.0);
        assert_eq!(response_speed_score(Some(110.0), 60.0, true), 60.0);
        assert_eq!(response_speed_score(Some(200.0), 60.0, true), 40.0);
        assert_eq!(response_speed_score(Some(1000.0), 60.0, true), 20.0);
        assert_eq!(response_speed_score(None, 60.0, false), 0.0);
        assert_eq!(response_speed_score(Some(10.0), 60.0, false), 0.0);
    }

    #[test]
    fn sla_breach_count_changes_when_the_response_crosses_the_threshold() {
        let event = row(json!({"id": "e", "status": "active", "severity": "critical", "started_at": iso_at(0)}));
        assert_eq!(
            sla_breach_count(&event, Some(START + 10 * 60_000), START + 20 * 60_000),
            0
        );
        assert_eq!(
            sla_breach_count(&event, Some(START + 120 * 60_000), START + 120 * 60_000),
            1
        );
        assert_eq!(sla_breach_count(&event, None, START + 120 * 60_000), 1);
    }

    #[test]
    fn summary_carries_the_real_counts() {
        let event = row(json!({
            "id": "e", "title": "Flood", "severity": "high", "status": "resolved",
            "created_at": iso_at(0), "started_at": iso_at(0), "ended_at": iso_at(60)
        }));
        let computed = compute_after_action(&AfterActionInput::new(&event));
        assert!(computed.summary.contains("0/0 nhiệm vụ"));
        assert!(computed.summary.contains("Không ghi nhận"));
        assert_eq!(computed.metadata["generated_by"], json!("sos-kpi-engine-v1"));
    }
}
