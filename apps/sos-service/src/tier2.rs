// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Thin Tier-2 data-access layer shared by every SOS route.

use std::sync::Arc;

use axum::http::HeaderMap;
use chrono::Utc;
use serde_json::{json, Map, Value};
use synapsedx::{Client, Dataset, DatasetInput, RecordItem, RecordListQuery, RequestOptions};

use crate::auth::{self, Claims};
use crate::config::Config;
use crate::error::ApiError;

pub const MAX_PAGE_SIZE: i64 = 500;

#[derive(Clone, Copy, Debug)]
pub struct DatasetSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub entity_type: &'static str,
    pub description: &'static str,
    pub public: bool,
}

pub const EVENTS: DatasetSpec = DatasetSpec {
    id: "sos-emergency-events",
    name: "SynapseCitySOS emergency events",
    entity_type: "EmergencyEvent",
    description: "Emergency event command records",
    public: true,
};
pub const EOP: DatasetSpec = DatasetSpec {
    id: "sos-eop-plans",
    name: "SynapseCitySOS EOP plans",
    entity_type: "EmergencyOperationsPlan",
    description: "Emergency operations plans",
    public: false,
};
pub const DISPATCH: DatasetSpec = DatasetSpec {
    id: "sos-dispatch-orders",
    name: "SynapseCitySOS dispatch orders",
    entity_type: "DispatchOrder",
    description: "Emergency dispatch orders",
    public: false,
};
pub const RESOURCES: DatasetSpec = DatasetSpec {
    id: "sos-resource-units",
    name: "SynapseCitySOS resource units",
    entity_type: "ResourceUnit",
    description: "Emergency response resources",
    public: false,
};
pub const SITREP: DatasetSpec = DatasetSpec {
    id: "sos-sitreps",
    name: "SynapseCitySOS situation reports",
    entity_type: "SituationReport",
    description: "Emergency situation reports",
    public: false,
};
pub const HAZARDS: DatasetSpec = DatasetSpec {
    id: "sos-hazard-layers",
    name: "SynapseCitySOS hazard layers",
    entity_type: "HazardLayer",
    description: "Flood, storm and other hazard observations",
    public: true,
};
pub const AFTER_ACTION: DatasetSpec = DatasetSpec {
    id: "sos-after-action-reports",
    name: "SynapseCitySOS after action reports",
    entity_type: "AfterActionReport",
    description: "Emergency after action reports",
    public: false,
};
pub const HAZARD_RUNS: DatasetSpec = DatasetSpec {
    id: "sos-hazard-ingest-runs",
    name: "SynapseCitySOS hazard ingest runs",
    entity_type: "HazardIngestRun",
    description: "VNDMS ingest run history",
    public: false,
};
pub const MUTUAL_AID: DatasetSpec = DatasetSpec {
    id: "sos-mutual-aid-requests",
    name: "SynapseCitySOS mutual aid requests",
    entity_type: "MutualAidRequest",
    description: "Cross-agency resource requests, accepts and handoffs",
    public: false,
};

pub const DATASETS: [DatasetSpec; 9] = [
    EVENTS,
    EOP,
    DISPATCH,
    RESOURCES,
    SITREP,
    HAZARDS,
    AFTER_ACTION,
    HAZARD_RUNS,
    MUTUAL_AID,
];

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn request_options_from(
    config_key: Option<&str>,
    config_token: Option<&str>,
    header_key: Option<&str>,
    session_token: Option<&str>,
) -> RequestOptions {
    let mut opts = RequestOptions::new();
    if let Some(token) = session_token.filter(|value| !value.is_empty()).or(config_token.filter(|value| !value.is_empty())) {
        opts = opts.token(token);
    }
    if let Some(key) = header_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| config_key.map(str::trim).filter(|value| !value.is_empty()))
    {
        opts = opts.api_key(key);
    }
    opts
}

pub fn request_options(config: &Config, headers: &HeaderMap, session: Option<&Claims>) -> RequestOptions {
    let header_key = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok());
    request_options_from(
        config.tier2_api_key.as_deref(),
        config.tier2_token.as_deref(),
        header_key,
        session.and_then(|claims| claims.tier2_token.as_deref()),
    )
}

pub fn client_for(config: &Config, headers: &HeaderMap, session: Option<&Claims>) -> (Arc<Client>, RequestOptions) {
    // The base client is built once in AppState; callers get a clone through
    // the state instead. This helper exists for routes that only have config.
    let client = config
        .tier2_client()
        .expect("Tier-2 client configuration was validated at startup");
    (Arc::new(client), request_options(config, headers, session))
}

pub async fn ensure_dataset(
    client: &Client,
    opts: &RequestOptions,
    spec: DatasetSpec,
) -> Result<Dataset, ApiError> {
    match client.datasets().get(spec.id, opts).await {
        Ok(existing) => {
            let desired_public = spec.public;
            let needs_reconcile = existing.license != "CC-BY-4.0"
                || existing.public != desired_public
                || existing.name != spec.name
                || existing.entity_type != spec.entity_type
                || existing.description.as_deref().unwrap_or("") != spec.description;
            if !needs_reconcile {
                return Ok(existing);
            }
            if existing.public && !desired_public && existing.status == "published" {
                let _ = client.datasets().revoke(existing.id.as_str(), opts).await;
            }
            let patch = json!({
                "name": spec.name,
                "entityType": spec.entity_type,
                "license": "CC-BY-4.0",
                "description": spec.description,
                "public": desired_public,
                "schemaVersion": existing.schema_version.clone().unwrap_or_else(|| "1.0.0".into()),
            });
            client
                .datasets()
                .update(existing.id.as_str(), patch, opts)
                .await
                .map_err(ApiError::from)
        }
        Err(error) if error.is_not_found() => {
            let input = DatasetInput {
                slug: spec.id.to_string(),
                name: spec.name.to_string(),
                entity_type: spec.entity_type.to_string(),
                license: "CC-BY-4.0".into(),
                description: Some(spec.description.to_string()),
                public: Some(spec.public),
                schema_version: Some("1.0.0".into()),
                ..Default::default()
            };
            match client.datasets().create(input, opts).await {
                Ok(created) => {
                    if spec.public {
                        match client.datasets().publish(created.id.as_str(), opts).await {
                            Ok(published) => Ok(published),
                            Err(_) => Ok(created),
                        }
                    } else {
                        Ok(created)
                    }
                }
                Err(create_error) => {
                    if matches!(create_error.status(), Some(400 | 409)) {
                        client.datasets().get(spec.id, opts).await.map_err(ApiError::from)
                    } else {
                        Err(ApiError::from(create_error))
                    }
                }
            }
        }
        Err(error) => Err(ApiError::from(error)),
    }
}

pub fn record_data(item: &RecordItem) -> Map<String, Value> {
    let mut data = match &item.data {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    data.entry("id".to_string())
        .or_insert_with(|| Value::String(item.id.clone()));
    if !item.created_at.is_empty() {
        data.entry("created_at".to_string())
            .or_insert_with(|| Value::String(item.created_at.clone()));
    }
    if !item.updated_at.is_empty() {
        data.entry("updated_at".to_string())
            .or_insert_with(|| Value::String(item.updated_at.clone()));
    }
    data.insert("record_version".into(), json!(item.version));
    data
}

pub fn record_value(item: &RecordItem) -> Value {
    Value::Object(record_data(item))
}

pub fn stored_payload(input: &Map<String, Value>) -> Map<String, Value> {
    let mut data = input.clone();
    for key in ["record_version", "if_version", "ifVersion", "if_match"] {
        data.remove(key);
    }
    data
}

pub async fn list_page(
    client: &Client,
    opts: &RequestOptions,
    spec: DatasetSpec,
    limit: i64,
    offset: i64,
) -> Result<Vec<Map<String, Value>>, ApiError> {
    let dataset = ensure_dataset(client, opts, spec).await?;
    let page = client
        .records()
        .list(
            dataset.id.as_str(),
            RecordListQuery::new()
                .limit(limit.clamp(1, MAX_PAGE_SIZE))
                .offset(offset.max(0)),
            opts,
        )
        .await
        .map_err(ApiError::from)?;
    Ok(page.items.iter().map(record_data).collect())
}

pub struct AllRows {
    pub items: Vec<Map<String, Value>>,
    pub scanned: usize,
    pub truncated: bool,
}

pub async fn list_all(
    client: &Client,
    opts: &RequestOptions,
    spec: DatasetSpec,
    max_records: usize,
) -> Result<AllRows, ApiError> {
    let dataset = ensure_dataset(client, opts, spec).await?;
    let max_records = max_records.max(1);
    let mut items = Vec::new();
    let mut offset = 0i64;
    let mut scanned = 0usize;
    let mut truncated = false;
    loop {
        let take = (max_records.saturating_sub(scanned)).min(MAX_PAGE_SIZE as usize) as i64;
        if take <= 0 {
            break;
        }
        let page = client
            .records()
            .list(
                dataset.id.as_str(),
                RecordListQuery::new().limit(take).offset(offset),
                opts,
            )
            .await
            .map_err(ApiError::from)?;
        let batch_len = page.items.len();
        for item in &page.items {
            items.push(record_data(item));
            scanned += 1;
        }
        offset += batch_len as i64;
        if batch_len == 0 {
            break;
        }
        if page.total > 0 && offset >= page.total {
            break;
        }
        if batch_len < take as usize {
            break;
        }
        if scanned >= max_records {
            truncated = page.total < 0 || offset < page.total;
            break;
        }
    }
    Ok(AllRows {
        items,
        scanned,
        truncated,
    })
}

pub async fn get(
    client: &Client,
    opts: &RequestOptions,
    spec: DatasetSpec,
    id: &str,
) -> Result<Map<String, Value>, ApiError> {
    let dataset = ensure_dataset(client, opts, spec).await?;
    let item = client
        .records()
        .get(dataset.id.as_str(), id, opts)
        .await
        .map_err(ApiError::from)?;
    Ok(record_data(&item))
}

pub async fn write(
    client: &Client,
    opts: &RequestOptions,
    spec: DatasetSpec,
    input: Map<String, Value>,
    id: Option<&str>,
) -> Result<Map<String, Value>, ApiError> {
    let dataset = ensure_dataset(client, opts, spec).await?;
    let record_id = id
        .map(str::to_string)
        .or_else(|| input.get("id").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let timestamp = now_iso();
    let mut data = stored_payload(&input);
    data.insert("id".into(), Value::String(record_id.clone()));
    data.entry("created_at".to_string())
        .or_insert_with(|| Value::String(timestamp.clone()));
    data.insert("updated_at".into(), Value::String(timestamp));
    match client
        .records()
        .create(
            dataset.id.as_str(),
            Value::Object(data.clone()),
            Some(record_id.as_str()),
            Some(spec.public),
            opts,
        )
        .await
    {
        Ok(created) => Ok(record_data(&created)),
        Err(error) if error.is_conflict() => {
            let current = get(client, opts, spec, &record_id).await?;
            let expected = current
                .get("record_version")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let mut merged = data;
            if let Some(created_at) = current.get("created_at") {
                merged.insert("created_at".into(), created_at.clone());
            }
            let mut update_opts = opts.clone();
            if expected > 0 {
                update_opts = update_opts.if_version(expected);
            }
            match client
                .records()
                .update(
                    dataset.id.as_str(),
                    record_id.as_str(),
                    Value::Object(merged),
                    Some(spec.public),
                    &update_opts,
                )
                .await
            {
                Ok(updated) => Ok(record_data(&updated)),
                Err(retry) if retry.is_conflict() => Err(ApiError::conflict(
                    "record_version_conflict",
                    format!("record {record_id} changed while it was being created"),
                )),
                Err(retry) => Err(ApiError::from(retry)),
            }
        }
        Err(error) => Err(ApiError::from(error)),
    }
}

pub async fn update(
    client: &Client,
    opts: &RequestOptions,
    spec: DatasetSpec,
    id: &str,
    patch: Map<String, Value>,
    if_version: Option<i64>,
) -> Result<Map<String, Value>, ApiError> {
    let current = get(client, opts, spec, id).await?;
    let current_version = current
        .get("record_version")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if let Some(expected) = if_version {
        if current_version > 0 && expected != current_version {
            return Err(ApiError::conflict(
                "record_version_conflict",
                format!("expected version {expected}, found {current_version}"),
            )
            .with_details(json!({ "current_version": current_version })));
        }
    }
    let dataset = ensure_dataset(client, opts, spec).await?;
    let mut merged = current;
    for (key, value) in stored_payload(&patch) {
        merged.insert(key, value);
    }
    merged.insert("id".into(), Value::String(id.to_string()));
    merged.insert("updated_at".into(), Value::String(now_iso()));
    merged.remove("record_version");
    let expected = if_version.unwrap_or(current_version);
    let mut update_opts = opts.clone();
    if expected > 0 {
        update_opts = update_opts.if_version(expected);
    }
    match client
        .records()
        .update(
            dataset.id.as_str(),
            id,
            Value::Object(merged),
            Some(spec.public),
            &update_opts,
        )
        .await
    {
        Ok(updated) => Ok(record_data(&updated)),
        Err(error) if error.is_conflict() => Err(ApiError::conflict(
            "record_version_conflict",
            format!("record {id} was modified by another request"),
        )
        .with_details(json!({ "current_version": current_version }))),
        Err(error) => Err(ApiError::from(error)),
    }
}

pub struct PublicRows {
    pub items: Vec<Map<String, Value>>,
    pub truncated: bool,
}

pub async fn list_all_public(
    client: &Client,
    opts: &RequestOptions,
    spec: DatasetSpec,
    max_records: usize,
) -> Result<PublicRows, ApiError> {
    let dataset = ensure_dataset(client, opts, spec).await?;
    if spec.public && dataset.status != "published" {
        let _ = client.datasets().publish(dataset.id.as_str(), opts).await;
    }
    let max = max_records.max(1);
    let mut items = Vec::new();
    let mut offset = 0i64;
    let mut truncated = false;
    loop {
        if items.len() >= max {
            break;
        }
        let limit = ((max - items.len()).min(MAX_PAGE_SIZE as usize)) as i64;
        let entities = client
            .datasets()
            .entities(dataset.id.as_str(), Some(limit), Some(offset), opts)
            .await
            .map_err(ApiError::from)?;
        let batch: Vec<Map<String, Value>> = entities
            .iter()
            .filter_map(from_ngsi_ld)
            .collect();
        let batch_len = batch.len();
        items.extend(batch);
        offset += batch_len as i64;
        if batch_len < limit as usize {
            break;
        }
        if items.len() >= max {
            truncated = true;
        }
    }
    items.truncate(max);
    Ok(PublicRows { items, truncated })
}

pub fn from_ngsi_ld(entity: &Value) -> Option<Map<String, Value>> {
    let source = entity.as_object()?;
    let id = source
        .get("id")
        .or_else(|| source.get("entityId"))
        .and_then(Value::as_str)?;
    let mut output = Map::new();
    output.insert("id".into(), Value::String(id.to_string()));
    for (key, value) in source {
        if key == "@context" || key == "id" || key == "type" {
            continue;
        }
        let mapped = match value {
            Value::Object(descriptor)
                if descriptor.get("type").and_then(Value::as_str).is_some()
                    && (descriptor.contains_key("value") || descriptor.contains_key("object")) =>
            {
                match descriptor.get("type").and_then(Value::as_str) {
                    Some("GeoProperty") => descriptor.get("value").cloned().unwrap_or(Value::Null),
                    Some("Relationship") => descriptor
                        .get("object")
                        .or_else(|| descriptor.get("value"))
                        .cloned()
                        .unwrap_or(Value::Null),
                    _ => descriptor.get("value").cloned().unwrap_or(Value::Null),
                }
            }
            other => other.clone(),
        };
        output.insert(key.clone(), mapped);
    }
    if let Some(entity_type) = source.get("type").and_then(Value::as_str) {
        output
            .entry("entity_type".to_string())
            .or_insert_with(|| Value::String(entity_type.to_string()));
    }
    Some(output)
}

pub async fn dependency_health(client: &Client, opts: &RequestOptions) -> Value {
    let started = std::time::Instant::now();
    let checked_at = now_iso();
    match client.health(opts).await {
        Ok(_) => {
            let mut checks = Vec::new();
            for spec in DATASETS {
                match client.datasets().get(spec.id, opts).await {
                    Ok(dataset) => checks.push(json!({
                        "id": spec.id,
                        "reachable": true,
                        "status": dataset.status,
                        "public": spec.public,
                        "checked_at": checked_at,
                    })),
                    Err(error) if error.is_not_found() => checks.push(json!({
                        "id": spec.id,
                        "reachable": true,
                        "status": "missing",
                        "public": spec.public,
                        "checked_at": checked_at,
                    })),
                    Err(_) => checks.push(json!({
                        "id": spec.id,
                        "reachable": false,
                        "status": "error",
                        "public": spec.public,
                        "checked_at": checked_at,
                    })),
                }
            }
            let degraded = checks
                .iter()
                .any(|check| check.get("reachable").and_then(Value::as_bool) != Some(true));
            json!({
                "name": "synapsedx",
                "reachable": true,
                "status": if degraded { "degraded" } else { "ok" },
                "checked_at": checked_at,
                "latency_ms": started.elapsed().as_millis() as u64,
                "datasets": checks,
            })
        }
        Err(error) => json!({
            "name": "synapsedx",
            "reachable": false,
            "status": "unreachable",
            "checked_at": checked_at,
            "latency_ms": started.elapsed().as_millis() as u64,
            "detail": if error.status() == Some(404) { "Tier-2 health endpoint is not published" } else { "Tier-2 capabilities API did not respond" },
            "datasets": [],
        }),
    }
}

pub fn limit_of(query: &std::collections::HashMap<String, String>, fallback: i64) -> i64 {
    query
        .get("limit")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| (value.floor() as i64).clamp(1, 500))
        .unwrap_or(fallback)
}

pub fn offset_of(query: &std::collections::HashMap<String, String>) -> i64 {
    query
        .get("skip")
        .or_else(|| query.get("offset"))
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| (value.floor() as i64).max(0))
        .unwrap_or(0)
}

pub fn requested_version(
    headers: &HeaderMap,
    body: Option<&Map<String, Value>>,
) -> Result<Option<i64>, ApiError> {
    let from_header = match headers.get("if-match").and_then(|value| value.to_str().ok()) {
        Some(raw) => {
            let raw = raw.trim();
            if raw == "*" {
                None
            } else {
                let cleaned = raw.trim_start_matches("W/").trim_matches('"');
                match cleaned.parse::<i64>() {
                    Ok(value) => Some(value),
                    Err(_) => {
                        return Err(ApiError::bad_request(
                            "invalid_if_match",
                            "If-Match must be a numeric record version",
                        ))
                    }
                }
            }
        }
        None => None,
    };
    let from_body = body
        .and_then(|value| value.get("if_version").or_else(|| value.get("ifVersion")))
        .and_then(|value| {
            if value.is_null() || value.as_str() == Some("") {
                None
            } else {
                value.as_i64()
            }
        });
    match (from_header, from_body) {
        (Some(a), Some(b)) if a != b => Err(ApiError::bad_request(
            "version_precondition_mismatch",
            "If-Match and if_version disagree",
        )),
        (Some(value), _) | (_, Some(value)) => Ok(Some(value)),
        _ => Ok(None),
    }
}

pub fn actor_of(session: Option<&Claims>) -> Option<String> {
    session.map(|claims| claims.username.clone())
}

pub fn session_of(headers: &HeaderMap, config: &Config) -> Option<Claims> {
    auth::session_from_headers(config, headers)
}


#[cfg(test)]
mod tests {
    use super::{request_options, request_options_from};
    use serde_json::json;
    use synapsedx::{Client, Credentials, RecordListQuery, RequestOptions};
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn credential_precedence_session_then_config_and_header_then_config() {
        let opts = request_options_from(
            Some("config-key"),
            Some("config-token"),
            Some("header-key"),
            Some("session-token"),
        );
        assert_eq!(opts.token.as_deref(), Some("session-token"));
        assert_eq!(opts.api_key.as_deref(), Some("header-key"));

        let opts = request_options_from(
            Some("config-key"),
            Some("config-token"),
            None,
            None,
        );
        assert_eq!(opts.token.as_deref(), Some("config-token"));
        assert_eq!(opts.api_key.as_deref(), Some("config-key"));

        let opts = request_options_from(Some("config-key"), None, Some("  "), None);
        assert_eq!(opts.api_key.as_deref(), Some("config-key"));
    }

    #[tokio::test]
    async fn sdk_records_request_uses_expected_path_and_override_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/sos-emergency-events/records"))
            .and(query_param("limit", "10"))
            .and(query_param("offset", "0"))
            .and(header("x-api-key", "override-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [],
                "total": 0,
                "limit": 10,
                "offset": 0,
                "nextCursor": null
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = Client::new(server.uri(), Credentials::none()).unwrap();
        let opts = RequestOptions::new().api_key("override-key");
        let page = client
            .records()
            .list(
                "sos-emergency-events",
                RecordListQuery::new().limit(10).offset(0),
                &opts,
            )
            .await
            .unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
    }

    /// Read-only diagnostic. Run only with explicit dev credentials:
    /// `cargo test -j1 live_tier2_records_trace -- --ignored --nocapture`
    /// It prints status/path/message only, never request headers or secrets.
    #[tokio::test]
    #[ignore]
    async fn live_tier2_records_trace() {
        let config = crate::config::Config::from_env().expect("valid Tier-2 config");
        let client = config.tier2_client().expect("Tier-2 client");
        let opts = request_options(&config, &axum::http::HeaderMap::new(), None);
        match client.datasets().get("sos-emergency-events", &opts).await {
            Ok(dataset) => eprintln!("dataset status={} id={}", dataset.status, dataset.id),
            Err(error) => eprintln!("dataset error={error}"),
        }
        match client
            .records()
            .list(
                "sos-emergency-events",
                RecordListQuery::new().limit(1).offset(0),
                &opts,
            )
            .await
        {
            Ok(page) => eprintln!("records total={} status=ok", page.total),
            Err(error) => panic!("records error={error}"),
        }
    }
}
