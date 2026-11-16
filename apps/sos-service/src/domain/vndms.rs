// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! VNDMS hazard wire contract and ingestion normalisation.
//!
//! The public VNDMS layer expects flat coordinates (`lat`/`lon`) plus
//! `warning_type`/`warning_level`, while stored SOS hazards use GeoJSON
//! `geometry`. This module is the single place that converts between the two.
//!
//! Ingestion is push-based: a Tier-2 scheduled connector posts a feed batch to
//! `POST /v1/hazards/ingest`. SOS validates, normalises and upserts by stable
//! `hazard_id`, then records the run in `sos-hazard-ingest-runs`. SOS never
//! runs a cron/poller of its own.

use crate::domain::error::{bad_request, DomainError};
use crate::domain::filters::{
    iso_from_millis, js_number, js_string, js_truthy, non_null, now_iso, number_value,
    parse_timestamp, string_or, Data,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VndmsWarningType {
    WaterLevel,
    WarningRain,
    WarningWind,
    WarningEarthquake,
    WarningFlood,
}

impl VndmsWarningType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WaterLevel => "water_level",
            Self::WarningRain => "warning_rain",
            Self::WarningWind => "warning_wind",
            Self::WarningEarthquake => "warning_earthquake",
            Self::WarningFlood => "warning_flood",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "water_level" => Some(Self::WaterLevel),
            "warning_rain" => Some(Self::WarningRain),
            "warning_wind" => Some(Self::WarningWind),
            "warning_earthquake" => Some(Self::WarningEarthquake),
            "warning_flood" => Some(Self::WarningFlood),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VndmsSeverity {
    Low,
    Medium,
    High,
}

impl VndmsSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VndmsGeometry {
    #[serde(rename = "type")]
    pub kind: String,
    pub coordinates: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VndmsHazard {
    pub id: String,
    pub hazard_id: String,
    pub lat: f64,
    pub lon: f64,
    pub label: String,
    pub warning_type: VndmsWarningType,
    pub warning_level: i64,
    pub severity: VndmsSeverity,
    pub value: String,
    #[serde(rename = "popupInfo")]
    pub popup_info: String,
    pub source: String,
    pub is_active: bool,
    pub observed_at: Option<String>,
    pub expires_at: Option<String>,
    pub geometry: Option<VndmsGeometry>,
}

const EVENT_TO_WARNING: &[(&str, VndmsWarningType)] = &[
    ("flood", VndmsWarningType::WarningFlood),
    ("storm", VndmsWarningType::WarningWind),
    ("landslide", VndmsWarningType::WarningRain),
    ("earthquake", VndmsWarningType::WarningEarthquake),
    ("heavy_rain", VndmsWarningType::WarningRain),
    ("rainfall", VndmsWarningType::WarningRain),
    ("water_level", VndmsWarningType::WaterLevel),
];

fn severity_to_level(severity: &str) -> Option<i64> {
    match severity {
        "low" => Some(1),
        "medium" => Some(2),
        "high" | "critical" => Some(3),
        _ => None,
    }
}

fn level_to_severity(level: i64) -> Option<VndmsSeverity> {
    match level {
        1 => Some(VndmsSeverity::Low),
        2 => Some(VndmsSeverity::Medium),
        3 => Some(VndmsSeverity::High),
        _ => None,
    }
}

fn metadata_of(row: &Data) -> Option<&Data> {
    row.get("metadata").and_then(Value::as_object)
}

fn valid_point(lat: f64, lon: f64) -> bool {
    lat.abs() <= 90.0 && lon.abs() <= 180.0
}

/// `(lat, lon)` from GeoJSON or the flat VNDMS/legacy fields.
fn point_of(row: &Data) -> Option<(f64, f64)> {
    if let Some(geometry) = row.get("geometry").and_then(Value::as_object) {
        if geometry.get("type").and_then(Value::as_str) == Some("Point") {
            if let Some(Value::Array(coordinates)) = geometry.get("coordinates") {
                if coordinates.len() >= 2 {
                    let lon = js_number(Some(&coordinates[0]));
                    let lat = js_number(Some(&coordinates[1]));
                    if let (Some(lat), Some(lon)) = (lat, lon) {
                        if valid_point(lat, lon) {
                            return Some((lat, lon));
                        }
                    }
                }
            }
        }
    }
    let metadata = metadata_of(row);
    let lat = non_null(row, "lat")
        .or_else(|| metadata.and_then(|metadata| non_null(metadata, "lat")))
        .and_then(|value| js_number(Some(value)));
    let lon = non_null(row, "lon")
        .or_else(|| non_null(row, "lng"))
        .or_else(|| metadata.and_then(|metadata| non_null(metadata, "lon")))
        .or_else(|| metadata.and_then(|metadata| non_null(metadata, "lng")))
        .and_then(|value| js_number(Some(value)));
    match (lat, lon) {
        (Some(lat), Some(lon)) if valid_point(lat, lon) => Some((lat, lon)),
        _ => None,
    }
}

pub fn warning_type_of(row: &Data) -> VndmsWarningType {
    let raw = non_null(row, "warning_type")
        .or_else(|| metadata_of(row).and_then(|metadata| non_null(metadata, "warning_type")))
        .map(js_string)
        .unwrap_or_default();
    let raw = raw.trim();
    if let Some(warning_type) = VndmsWarningType::parse(raw) {
        return warning_type;
    }
    let event_type = string_or(row, "event_type", "").to_lowercase();
    EVENT_TO_WARNING
        .iter()
        .find(|(key, _)| *key == event_type.as_str())
        .map(|(_, warning_type)| *warning_type)
        .unwrap_or(VndmsWarningType::WarningFlood)
}

pub fn warning_level_of(row: &Data) -> i64 {
    let raw = non_null(row, "warning_level")
        .or_else(|| metadata_of(row).and_then(|metadata| non_null(metadata, "warning_level")))
        .and_then(|value| js_number(Some(value)));
    if let Some(raw) = raw {
        if raw >= 1.0 {
            return raw.floor().min(3.0) as i64;
        }
    }
    severity_to_level(&string_or(row, "severity", "")).unwrap_or(2)
}

pub fn severity_of(row: &Data) -> VndmsSeverity {
    let level = warning_level_of(row);
    match string_or(row, "severity", "").as_str() {
        "critical" | "high" => VndmsSeverity::High,
        "medium" => VndmsSeverity::Medium,
        "low" => VndmsSeverity::Low,
        _ => level_to_severity(level).unwrap_or(VndmsSeverity::Medium),
    }
}

pub fn is_vndms_record(row: &Data) -> bool {
    let source = non_null(row, "source")
        .or_else(|| metadata_of(row).and_then(|metadata| non_null(metadata, "source")))
        .map(js_string)
        .unwrap_or_default()
        .to_lowercase();
    source == "vndms"
        || row.contains_key("warning_type")
        || metadata_of(row)
            .map(|metadata| metadata.contains_key("warning_type"))
            .unwrap_or(false)
}

fn raw_string(row: &Data, key: &str) -> String {
    row.get(key)
        .map(js_string)
        .unwrap_or_else(|| "undefined".to_string())
}

fn nullish_string(row: &Data, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = non_null(row, key) {
            return Some(js_string(value));
        }
    }
    None
}

/// Convert a stored hazard record to the flat VNDMS wire schema.
pub fn to_vndms_hazard(row: &Data) -> Option<VndmsHazard> {
    let (lat, lon) = point_of(row)?;
    let severity = severity_of(row);
    let warning_type = warning_type_of(row);
    let warning_level = warning_level_of(row);
    let district = string_or(row, "district", "");
    let description = string_or(row, "description", "");
    let observed_at = nullish_string(row, &["observed_at", "created_at"]).filter(|value| !value.is_empty());

    let label = non_null(row, "title")
        .or_else(|| non_null(row, "label"))
        .map(js_string)
        .unwrap_or_else(|| "Cảnh báo VNDMS".to_string());
    let value = non_null(row, "value")
        .or_else(|| metadata_of(row).and_then(|metadata| non_null(metadata, "value")))
        .map(js_string)
        .unwrap_or_else(|| {
            format!(
                "{} · cấp {}",
                severity.as_str().to_uppercase(),
                warning_level
            )
        });
    let popup_info = [
        description,
        district,
        observed_at
            .as_ref()
            .map(|observed| format!("Quan sát: {observed}"))
            .unwrap_or_default(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");

    let expires_at = nullish_string(row, &["expires_at"]).filter(|value| !value.is_empty());
    let is_active = !matches!(row.get("is_active"), Some(Value::Bool(false)))
        && string_or(row, "status", "") != "expired";

    Some(VndmsHazard {
        id: raw_string(row, "id"),
        hazard_id: non_null(row, "hazard_id")
            .or_else(|| non_null(row, "id"))
            .map(js_string)
            .unwrap_or_else(|| "undefined".to_string()),
        lat,
        lon,
        label,
        warning_type,
        warning_level,
        severity,
        value,
        popup_info,
        source: "vndms".to_string(),
        is_active,
        observed_at,
        expires_at,
        geometry: Some(VndmsGeometry {
            kind: "Point".to_string(),
            coordinates: [lon, lat],
        }),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NormalizedIngestRecord {
    pub hazard: Data,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedIngestRecord {
    pub index: usize,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hazard_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NormalizedIngestBatch {
    pub accepted: Vec<NormalizedIngestRecord>,
    pub rejected: Vec<RejectedIngestRecord>,
}

const SEVERITIES: &[&str] = &["low", "medium", "high", "critical"];
const EVENT_TYPES: &[&str] = &[
    "flood",
    "storm",
    "landslide",
    "fire",
    "earthquake",
    "outage",
    "pollution",
    "drought",
    "traffic",
    "epidemic",
    "other",
];

/// `(lon, lat)` for an ingest record; flat fields are accepted as a fallback.
fn ingest_point(record: &Data) -> Option<(f64, f64)> {
    if let Some(geometry) = record.get("geometry").and_then(Value::as_object) {
        if geometry.get("type").and_then(Value::as_str) == Some("Point") {
            if let Some(Value::Array(coordinates)) = geometry.get("coordinates") {
                if coordinates.len() >= 2 {
                    let lon = js_number(Some(&coordinates[0]));
                    let lat = js_number(Some(&coordinates[1]));
                    if let (Some(lat), Some(lon)) = (lat, lon) {
                        if valid_point(lat, lon) {
                            return Some((lon, lat));
                        }
                    }
                }
            }
        }
    }
    let lat = js_number(record.get("lat"));
    let lon = non_null(record, "lon")
        .or_else(|| non_null(record, "lng"))
        .and_then(|value| js_number(Some(value)));
    match (lat, lon) {
        (Some(lat), Some(lon)) if valid_point(lat, lon) => Some((lon, lat)),
        _ => None,
    }
}

/// Validate and normalise a VNDMS feed batch.
///
/// The mapping from a VNDMS record to the stored SOS hazard is deterministic
/// so a fixture produces stable output.
pub fn normalize_ingest_batch(
    input: &Value,
    at: Option<&str>,
) -> Result<NormalizedIngestBatch, DomainError> {
    let records = match input {
        Value::Array(records) => records,
        Value::Object(object) => match object.get("records") {
            Some(Value::Array(records)) => records,
            _ => {
                return Err(bad_request(
                    "records_required",
                    "records must be an array",
                    None,
                ))
            }
        },
        _ => {
            return Err(bad_request(
                "records_required",
                "records must be an array",
                None,
            ))
        }
    };
    if records.len() > 2000 {
        return Err(bad_request(
            "too_many_records",
            "a batch may contain at most 2000 records",
            None,
        ));
    }

    let at = at.map(str::to_string).unwrap_or_else(now_iso);
    let mut accepted: Vec<NormalizedIngestRecord> = Vec::new();
    let mut rejected: Vec<RejectedIngestRecord> = Vec::new();

    for (index, raw) in records.iter().enumerate() {
        let Some(record) = raw.as_object() else {
            rejected.push(RejectedIngestRecord {
                index,
                reason: "record_must_be_an_object".to_string(),
                hazard_id: None,
            });
            continue;
        };
        let hazard_id = nullish_string(record, &["hazard_id", "id"])
            .unwrap_or_default()
            .trim()
            .to_string();
        if hazard_id.is_empty() {
            rejected.push(RejectedIngestRecord {
                index,
                reason: "hazard_id_required".to_string(),
                hazard_id: None,
            });
            continue;
        }
        let title = nullish_string(record, &["title", "label"])
            .unwrap_or_default()
            .trim()
            .to_string();
        if title.is_empty() {
            rejected.push(RejectedIngestRecord {
                index,
                reason: "title_required".to_string(),
                hazard_id: Some(hazard_id),
            });
            continue;
        }
        let Some((lon, lat)) = ingest_point(record) else {
            rejected.push(RejectedIngestRecord {
                index,
                reason: "point_geometry_required".to_string(),
                hazard_id: Some(hazard_id),
            });
            continue;
        };

        let raw_event_type = string_or(record, "event_type", "").to_lowercase();
        let warning_type = warning_type_of(record);
        let event_type = if EVENT_TYPES.contains(&raw_event_type.as_str()) {
            raw_event_type
        } else {
            match warning_type {
                VndmsWarningType::WarningFlood => "flood",
                VndmsWarningType::WarningWind => "storm",
                VndmsWarningType::WarningEarthquake => "earthquake",
                _ => "flood",
            }
            .to_string()
        };
        let raw_severity = string_or(record, "severity", "").to_lowercase();
        let warning_level = warning_level_of(record);
        let severity = if SEVERITIES.contains(&raw_severity.as_str()) {
            raw_severity
        } else {
            level_to_severity(warning_level)
                .unwrap_or(VndmsSeverity::Medium)
                .as_str()
                .to_string()
        };
        let observed_at = nullish_string(record, &["observed_at", "issued_at"])
            .unwrap_or_else(|| at.clone());
        let expires_at = record
            .get("expires_at")
            .filter(|value| js_truthy(value))
            .map(js_string);

        let hazard = json!({
            "id": hazard_id.clone(),
            "hazard_id": hazard_id,
            "title": title,
            "description": string_or(record, "description", ""),
            "event_type": event_type,
            "severity": severity,
            "source": "vndms",
            "is_active": !matches!(record.get("is_active"), Some(Value::Bool(false))),
            "status": if matches!(record.get("is_active"), Some(Value::Bool(false))) { "expired" } else { "active" },
            "warning_type": warning_type.as_str(),
            "warning_level": warning_level,
            "value": string_or(record, "value", ""),
            "geometry": {
                "type": "Point",
                "coordinates": [number_value(lon), number_value(lat)]
            },
            "lat": number_value(lat),
            "lon": number_value(lon),
            "district": string_or(record, "district", ""),
            "ward": string_or(record, "ward", ""),
            "observed_at": observed_at,
            "ingested_at": at.clone(),
            "expires_at": expires_at.map(Value::String).unwrap_or(Value::Null),
            "metadata": {
                "source": "vndms",
                "feed_version": record.get("feed_version").cloned().unwrap_or(Value::Null),
                "source_ref": record.get("source_ref").cloned().unwrap_or(Value::Null)
            }
        });
        accepted.push(NormalizedIngestRecord {
            hazard: hazard.as_object().cloned().unwrap_or_default(),
        });
    }

    Ok(NormalizedIngestBatch { accepted, rejected })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IngestRun {
    pub id: String,
    pub source: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: String,
    pub records_received: f64,
    pub records_ingested: f64,
    pub records_rejected: f64,
    pub error: Option<String>,
    pub feed_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectorSchedule {
    pub cron: Option<String>,
    pub every_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IngestConnectorStatus {
    pub source: String,
    pub available: bool,
    pub configured: bool,
    pub job_id: Option<String>,
    pub job_name: Option<String>,
    pub job_kind: Option<String>,
    pub enabled: Option<bool>,
    pub schedule: Option<ConnectorSchedule>,
    pub last_run_at: Option<String>,
    pub last_run_status: Option<String>,
    pub last_run_error: Option<String>,
    pub last_success_at: Option<String>,
    pub runs_considered: usize,
    pub error: Option<String>,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IngestStatus {
    pub status: String,
    pub configured: bool,
    pub source: String,
    pub last_run_at: Option<String>,
    pub last_success_at: Option<String>,
    pub records_ingested: f64,
    pub records_rejected: f64,
    pub error: Option<String>,
    pub stale: bool,
    pub feed_version: Option<String>,
    pub checked_at: String,
    pub stale_after_minutes: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector: Option<IngestConnectorStatus>,
}

const CONNECTOR_DATASET: &str = "sos-hazard-layers";

/// Identify the VNDMS ingestion job in the Tier-2 scheduled-job list.
pub fn is_vndms_connector_job(job: &Data) -> bool {
    let payload = job.get("payload").and_then(Value::as_object);
    let marker = [
        job.get("id"),
        job.get("name"),
        job.get("kind"),
        job.get("datasetId"),
        payload.and_then(|payload| payload.get("source")),
        payload.and_then(|payload| payload.get("connector")),
        payload.and_then(|payload| payload.get("feed")),
        payload.and_then(|payload| payload.get("target")),
    ]
    .into_iter()
    .map(|value| {
        value
            .filter(|value| !value.is_null())
            .map(js_string)
            .unwrap_or_default()
    })
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
    if marker.contains("vndms") {
        return true;
    }
    let dataset_id = nullish_string(job, &["datasetId"]).unwrap_or_default();
    dataset_id == CONNECTOR_DATASET && (marker.contains("ingest") || marker.contains("hazard"))
}

pub fn connector_unavailable(
    error: Option<&DomainError>,
    checked_at: Option<&str>,
) -> IngestConnectorStatus {
    let status = error.map(|error| error.status);
    let code = error.map(|error| error.code.as_str());
    let message = if matches!(status, Some(401) | Some(403)) {
        "tier2_jobs_forbidden"
    } else if status == Some(404) {
        "tier2_jobs_unavailable"
    } else if code == Some("capability_unavailable") {
        "tier2_jobs_unavailable"
    } else {
        "tier2_jobs_unreachable"
    };
    IngestConnectorStatus {
        source: "tier-2-scheduled-job".to_string(),
        available: false,
        configured: false,
        job_id: None,
        job_name: None,
        job_kind: None,
        enabled: None,
        schedule: None,
        last_run_at: None,
        last_run_status: None,
        last_run_error: None,
        last_success_at: None,
        runs_considered: 0,
        error: Some(message.to_string()),
        checked_at: checked_at.map(str::to_string).unwrap_or_else(now_iso),
    }
}

pub fn connector_not_configured(checked_at: Option<&str>) -> IngestConnectorStatus {
    IngestConnectorStatus {
        source: "tier-2-scheduled-job".to_string(),
        available: true,
        configured: false,
        job_id: None,
        job_name: None,
        job_kind: None,
        enabled: None,
        schedule: None,
        last_run_at: None,
        last_run_status: None,
        last_run_error: None,
        last_success_at: None,
        runs_considered: 0,
        error: None,
        checked_at: checked_at.map(str::to_string).unwrap_or_else(now_iso),
    }
}

const RUN_SUCCEEDED: &[&str] = &["success", "succeeded", "completed", "complete", "ok"];
const RUN_FAILED: &[&str] = &["failed", "error", "crashed", "timeout", "timed_out"];

fn run_stamp(run: &Data) -> i64 {
    nullish_string(run, &["finishedAt", "finished_at", "startedAt", "started_at"])
        .as_deref()
        .and_then(parse_timestamp)
        .unwrap_or(0)
}

fn run_status(run: &Data) -> String {
    string_or(run, "status", "").to_lowercase()
}

fn run_last_error(run: &Data) -> Option<String> {
    let value = non_null(run, "lastError")
        .or_else(|| non_null(run, "last_error"))
        .map(js_string)
        .unwrap_or_default();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn run_stamp_text(run: &Data) -> Option<String> {
    let value = nullish_string(run, &["finishedAt", "finished_at", "startedAt", "started_at"])
        .unwrap_or_default();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Project a Tier-2 job plus its run history into a connector status.
pub fn connector_status_from_runs(
    job: &Data,
    runs: &[Data],
    now_ms: i64,
) -> IngestConnectorStatus {
    let mut ordered: Vec<&Data> = runs.iter().collect();
    ordered.sort_by(|left, right| run_stamp(right).cmp(&run_stamp(left)));
    let last = ordered.first().copied();
    let mut success: Option<&Data> = None;
    for &run in &ordered {
        if RUN_SUCCEEDED.contains(&run_status(run).as_str()) && run_last_error(run).is_none() {
            success = Some(run);
            break;
        }
    }
    let schedule = job.get("schedule").and_then(Value::as_object);
    let enabled = job
        .get("enabled")
        .map(|value| !matches!(value, Value::Bool(false)));
    let last_status = last.map(|run| {
        let status = string_or(run, "status", "unknown").to_lowercase();
        status
    });
    let last_error = last.and_then(run_last_error);
    let error = if enabled == Some(false) {
        Some("connector_disabled".to_string())
    } else if last_status
        .as_deref()
        .map(|status| RUN_FAILED.contains(&status))
        .unwrap_or(false)
    {
        Some(
            last_error
                .clone()
                .unwrap_or_else(|| "connector_run_failed".to_string()),
        )
    } else {
        None
    };
    let schedule = Some(ConnectorSchedule {
        cron: schedule
            .and_then(|schedule| non_null(schedule, "cron"))
            .filter(|value| js_truthy(value))
            .map(js_string),
        every_seconds: schedule
            .and_then(|schedule| schedule.get("everySeconds"))
            .and_then(|value| js_number(Some(value))),
    });
    IngestConnectorStatus {
        source: "tier-2-scheduled-job".to_string(),
        available: true,
        configured: true,
        job_id: non_null(job, "id").filter(|value| js_truthy(value)).map(js_string),
        job_name: non_null(job, "name")
            .filter(|value| js_truthy(value))
            .map(js_string),
        job_kind: non_null(job, "kind")
            .filter(|value| js_truthy(value))
            .map(js_string),
        enabled,
        schedule,
        last_run_at: last.and_then(run_stamp_text),
        last_run_status: last_status,
        last_run_error: last_error,
        last_success_at: success.and_then(|run| run_stamp_text(run)),
        runs_considered: ordered.len(),
        error,
        checked_at: iso_from_millis(now_ms).unwrap_or_default(),
    }
}

/// Effective staleness window in minutes.
///
/// The service layer resolves `VNDMS_STALE_MINUTES` and passes it here. Values
/// outside 5 minutes .. 24 hours are clamped; invalid values fall back to 60.
pub fn ingest_stale_minutes(value: Option<&Value>) -> f64 {
    let parsed = match value {
        None | Some(Value::Null) => return 60.0,
        Some(value) => js_number(Some(value)),
    };
    match parsed {
        Some(parsed) if parsed > 0.0 => parsed.clamp(5.0, 24.0 * 60.0),
        _ => 60.0,
    }
}

fn value_to_count(run: Option<&Data>, key: &str) -> f64 {
    js_number(run.and_then(|run| run.get(key)))
        .filter(|value| *value != 0.0)
        .unwrap_or(0.0)
}

/// Derive the public ingest status from persisted push-run state and, when
/// available, the Tier-2 scheduled connector. A never-run feed is
/// `unconfigured`, never a fake `ready`.
pub fn ingest_status_from_run(
    run: Option<&Data>,
    now_ms: i64,
    connector: Option<&IngestConnectorStatus>,
) -> IngestStatus {
    let stale_after = ingest_stale_minutes(None);
    let checked_at = iso_from_millis(now_ms).unwrap_or_default();
    let connector_configured = connector.map(|connector| connector.configured).unwrap_or(false);
    if run.is_none() && !connector_configured {
        return IngestStatus {
            status: "unconfigured".to_string(),
            configured: false,
            source: "vndms".to_string(),
            last_run_at: None,
            last_success_at: None,
            records_ingested: 0.0,
            records_rejected: 0.0,
            error: connector.and_then(|connector| connector.error.clone()),
            stale: true,
            feed_version: None,
            checked_at,
            stale_after_minutes: stale_after,
            connector: connector.cloned(),
        };
    }
    let last_run_at = run.and_then(|run| nullish_string(run, &["finished_at", "created_at"]))
        .filter(|value| !value.is_empty());
    let push_success_at = run.and_then(|run| {
        if let Some(value) = non_null(run, "last_success_at") {
            let value = js_string(value);
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        } else if string_or(run, "status", "") == "succeeded" {
            last_run_at.clone()
        } else {
            None
        }
    });
    let connector_success_at = connector.and_then(|connector| connector.last_success_at.clone());
    let mut success_candidates: Vec<(String, i64)> = Vec::new();
    for value in [push_success_at, connector_success_at].into_iter().flatten() {
        if let Some(ms) = parse_timestamp(&value) {
            success_candidates.push((value, ms));
        }
    }
    success_candidates.sort_by(|left, right| right.1.cmp(&left.1).then(Ordering::Equal));
    let last_success_at = success_candidates.first().map(|(value, _)| value.clone());
    let success_ms = success_candidates.first().map(|(_, ms)| *ms);
    let stale = success_ms
        .map(|ms| (now_ms - ms) as f64 > stale_after * 60.0 * 1000.0)
        .unwrap_or(true);
    let run_status = run.map(|run| string_or(run, "status", "")).unwrap_or_default();
    let connector_error = connector.and_then(|connector| connector.error.clone());
    let run_error = run
        .and_then(|run| run.get("error"))
        .filter(|value| js_truthy(value))
        .map(js_string);
    let status = if run_status == "failed"
        || (run_error.is_some() && last_success_at.is_none())
    {
        "error"
    } else if connector_error.is_some() && last_success_at.is_none() {
        "error"
    } else if stale {
        "stale"
    } else if run_status == "partial" || run_error.is_some() || connector_error.is_some() {
        "degraded"
    } else {
        "ready"
    };
    IngestStatus {
        status: status.to_string(),
        configured: true,
        source: "vndms".to_string(),
        last_run_at: last_run_at.or_else(|| connector.and_then(|connector| connector.last_run_at.clone())),
        last_success_at,
        records_ingested: value_to_count(run, "records_ingested"),
        records_rejected: value_to_count(run, "records_rejected"),
        error: run_error.or(connector_error),
        stale,
        feed_version: run
            .and_then(|run| run.get("feed_version"))
            .filter(|value| js_truthy(value))
            .map(js_string),
        checked_at,
        stale_after_minutes: stale_after,
        connector: connector.cloned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(value: Value) -> Data {
        value.as_object().cloned().unwrap_or_default()
    }

    const NOW: i64 = 1_791_000_000_000;

    fn iso_at(offset_minutes: i64) -> String {
        iso_from_millis(NOW + offset_minutes * 60_000).unwrap()
    }

    #[test]
    fn stored_hazard_converts_to_the_flat_vndms_contract() {
        let wire = to_vndms_hazard(&row(json!({
            "id": "h1", "hazard_id": "VNDMS-1", "title": "Flood A", "description": "Rising",
            "event_type": "flood", "severity": "critical", "source": "vndms", "is_active": true,
            "district": "Hai Chau", "geometry": {"type": "Point", "coordinates": [108, 16]},
            "observed_at": "2026-11-04T00:00:00.000Z"
        })))
        .expect("vndms hazard");
        assert_eq!(wire.lat, 16.0);
        assert_eq!(wire.lon, 108.0);
        assert_eq!(wire.label, "Flood A");
        assert_eq!(wire.warning_type, VndmsWarningType::WarningFlood);
        assert_eq!(wire.warning_level, 3);
        assert_eq!(wire.severity, VndmsSeverity::High);
        assert_eq!(
            wire.geometry.expect("geometry").coordinates,
            [108.0, 16.0]
        );
    }

    #[test]
    fn vndms_detection_distinguishes_manual_hazards() {
        assert!(is_vndms_record(&row(json!({"source": "vndms"}))));
        assert!(is_vndms_record(&row(json!({"warning_type": "warning_rain"}))));
        assert!(!is_vndms_record(&row(
            json!({"source": "manual", "event_type": "flood"})
        )));
    }

    #[test]
    fn warning_type_and_level_are_derived_deterministically() {
        assert_eq!(
            warning_type_of(&row(json!({"event_type": "storm"}))),
            VndmsWarningType::WarningWind
        );
        assert_eq!(
            warning_type_of(&row(json!({"event_type": "landslide"}))),
            VndmsWarningType::WarningRain
        );
        assert_eq!(warning_level_of(&row(json!({"severity": "critical"}))), 3);
        assert_eq!(
            warning_level_of(&row(json!({"warning_level": 1.9}))),
            1
        );
        assert_eq!(
            severity_of(&row(json!({"warning_level": 3}))),
            VndmsSeverity::High
        );
    }

    #[test]
    fn ingest_batch_normalises_and_rejects_invalid_records() {
        let batch = normalize_ingest_batch(
            &json!({
                "records": [
                    {"hazard_id": "V-1", "title": "Flood", "event_type": "flood", "severity": "high", "lat": 16, "lon": 108, "warning_level": 3},
                    {"hazard_id": "V-1", "title": "Flood (duplicate)", "event_type": "flood", "lat": 16, "lon": 108},
                    {"title": "Missing id", "lat": 16, "lon": 108},
                    {"hazard_id": "V-2", "title": "Missing point"},
                    {"hazard_id": "V-3", "title": "Storm", "event_type": "storm", "lat": 16, "lon": 108}
                ]
            }),
            Some("2026-11-04T00:00:00.000Z"),
        )
        .expect("batch");
        assert_eq!(batch.accepted.len(), 3);
        assert_eq!(batch.rejected.len(), 2);
        assert_eq!(
            batch
                .accepted
                .iter()
                .map(|entry| entry.hazard["hazard_id"].clone())
                .collect::<Vec<_>>(),
            vec![json!("V-1"), json!("V-1"), json!("V-3")]
        );
        assert_eq!(batch.accepted[0].hazard["source"], json!("vndms"));
        assert_eq!(
            batch.accepted[0].hazard["geometry"],
            json!({"type": "Point", "coordinates": [108, 16]})
        );
        assert_eq!(batch.rejected[0].reason, "hazard_id_required");
        assert_eq!(batch.rejected[1].reason, "point_geometry_required");
    }

    #[test]
    fn ingest_batch_rejects_non_arrays_and_oversized_batches() {
        assert_eq!(
            normalize_ingest_batch(&json!({"records": "nope"}), None)
                .expect_err("not an array")
                .code,
            "records_required"
        );
        let records = (0..2001)
            .map(|index| json!({"hazard_id": format!("H-{index}"), "title": "x", "lat": 16, "lon": 108}))
            .collect::<Vec<_>>();
        assert_eq!(
            normalize_ingest_batch(&json!({"records": records}), None)
                .expect_err("too many")
                .code,
            "too_many_records"
        );
    }

    #[test]
    fn ingest_status_is_unconfigured_before_the_first_run_and_stale_after_the_window() {
        let empty = ingest_status_from_run(None, NOW, None);
        assert_eq!(empty.status, "unconfigured");
        assert!(!empty.configured);

        let ready = ingest_status_from_run(
            Some(&row(json!({
                "status": "succeeded", "finished_at": iso_at(-5), "last_success_at": iso_at(-5),
                "records_ingested": 4, "records_rejected": 0
            }))),
            NOW,
            None,
        );
        assert_eq!(ready.status, "ready");
        assert!(!ready.stale);

        let stale = ingest_status_from_run(
            Some(&row(json!({
                "status": "succeeded", "finished_at": iso_at(-120), "last_success_at": iso_at(-120)
            }))),
            NOW,
            None,
        );
        assert_eq!(stale.status, "stale");

        let failed = ingest_status_from_run(
            Some(&row(json!({
                "status": "failed", "finished_at": iso_at(-5), "error": "upstream timeout"
            }))),
            NOW,
            None,
        );
        assert_eq!(failed.status, "error");
    }

    #[test]
    fn vndms_connector_job_is_identified_by_name_payload_or_dataset() {
        assert!(is_vndms_connector_job(&row(
            json!({"id": "vndms-connector", "name": "VNDMS feed ingest"})
        )));
        assert!(is_vndms_connector_job(&row(
            json!({"id": "feed", "payload": {"source": "vndms"}})
        )));
        assert!(is_vndms_connector_job(&row(
            json!({"id": "hazards-sync", "datasetId": "sos-hazard-layers"})
        )));
        assert!(!is_vndms_connector_job(&row(
            json!({"id": "email-digest", "name": "Email digest"})
        )));
    }

    #[test]
    fn connector_status_is_derived_from_the_job_and_run_history() {
        let job = row(json!({
            "id": "vndms-connector", "name": "VNDMS feed ingest", "kind": "ingest",
            "schedule": {"everySeconds": 300}, "enabled": true
        }));
        let runs = vec![
            row(json!({"id": "r2", "status": "success", "startedAt": iso_at(-10), "finishedAt": iso_at(-5), "attempt": 1, "lastError": null})),
            row(json!({"id": "r1", "status": "failed", "startedAt": iso_at(-20), "finishedAt": iso_at(-19), "attempt": 1, "lastError": "timeout"})),
        ];
        let status = connector_status_from_runs(&job, &runs, NOW);
        assert!(status.configured);
        assert!(status.available);
        assert_eq!(status.job_id.as_deref(), Some("vndms-connector"));
        assert_eq!(status.enabled, Some(true));
        assert_eq!(
            status.schedule.expect("schedule"),
            ConnectorSchedule {
                cron: None,
                every_seconds: Some(300.0)
            }
        );
        assert_eq!(status.last_run_status.as_deref(), Some("success"));
        assert_eq!(status.last_success_at.as_deref(), Some(iso_at(-5).as_str()));
        assert_eq!(status.runs_considered, 2);
        assert_eq!(status.error, None);

        let failed = connector_status_from_runs(
            &job,
            &[row(json!({
                "id": "r3", "status": "failed", "startedAt": iso_at(-1),
                "finishedAt": iso_at(-1), "lastError": "connection reset"
            }))],
            NOW,
        );
        assert_eq!(failed.last_run_status.as_deref(), Some("failed"));
        assert_eq!(failed.error.as_deref(), Some("connection reset"));

        let disabled_job = row(json!({
            "id": "vndms-connector", "name": "VNDMS feed ingest",
            "schedule": {"everySeconds": 300}, "enabled": false
        }));
        let disabled = connector_status_from_runs(&disabled_job, &[], NOW);
        assert_eq!(disabled.enabled, Some(false));
        assert_eq!(disabled.error.as_deref(), Some("connector_disabled"));
        assert_eq!(disabled.last_success_at, None);
    }

    #[test]
    fn ingest_status_combines_a_push_run_with_connector_freshness() {
        let connector = connector_status_from_runs(
            &row(json!({
                "id": "vndms-connector", "name": "VNDMS feed ingest",
                "schedule": {"cron": "*/5 * * * *"}, "enabled": true
            })),
            &[row(json!({"id": "r1", "status": "success", "finishedAt": iso_at(-5)}))],
            NOW,
        );
        let ready = ingest_status_from_run(None, NOW, Some(&connector));
        assert_eq!(ready.status, "ready");
        assert!(ready.configured);
        assert_eq!(ready.last_success_at.as_deref(), Some(iso_at(-5).as_str()));
        assert_eq!(ready.last_run_at.as_deref(), Some(iso_at(-5).as_str()));
        assert_eq!(ready.connector, Some(connector.clone()));

        let stale = ingest_status_from_run(None, NOW + 120 * 60_000, Some(&connector));
        assert_eq!(stale.status, "stale");

        let not_configured =
            connector_not_configured(Some("2026-11-04T12:00:00.000Z"));
        let unconfigured = ingest_status_from_run(None, NOW, Some(&not_configured));
        assert_eq!(unconfigured.status, "unconfigured");
        assert!(!unconfigured.configured);

        let unavailable = connector_unavailable(
            Some(&DomainError::service_unavailable("", "", None)),
            Some("2026-11-04T12:00:00.000Z"),
        );
        assert!(!unavailable.available);
        assert_eq!(
            unavailable.error.as_deref(),
            Some("tier2_jobs_unavailable")
        );
        let with_unavailable = ingest_status_from_run(
            Some(&row(json!({
                "status": "succeeded", "finished_at": iso_at(-5), "last_success_at": iso_at(-5)
            }))),
            NOW,
            Some(&unavailable),
        );
        assert_eq!(
            with_unavailable.status, "degraded",
            "an unavailable connector is a monitoring gap, never silently healthy"
        );
        assert!(!with_unavailable.connector.expect("connector").available);
    }

    #[test]
    fn stale_minutes_are_bounded() {
        assert_eq!(ingest_stale_minutes(None), 60.0);
        assert_eq!(ingest_stale_minutes(Some(&json!(2))), 5.0);
        assert_eq!(ingest_stale_minutes(Some(&json!(1_000_000))), 1440.0);
        assert_eq!(ingest_stale_minutes(Some(&json!("bad"))), 60.0);
    }
}
