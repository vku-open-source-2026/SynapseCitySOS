// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 AI capability adapter for SOS.

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use synapsedx::RequestOptions;

use crate::error::ApiError;
use crate::state::AppState;

const STATUS_TTL: Duration = Duration::from_secs(10);
const BRIEF_TTL: Duration = Duration::from_secs(60);

pub fn ai_timeout() -> Duration {
    let millis = std::env::var("SYNAPSEDX_AI_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1_000)
        .unwrap_or(45_000)
        .min(120_000);
    Duration::from_millis(millis)
}

pub fn ai_unavailable(detail: impl Into<String>, error: Option<&synapsedx::Error>) -> ApiError {
    let status = error.and_then(|error| error.status());
    let mut api = ApiError::unavailable("ai_capability_unavailable", detail);
    api.details = Some(json!({
        "dependency": "synapsedx",
        "capability": "ai",
        "retryable": status.is_none() || status.unwrap_or(500) >= 500,
        "upstream_status": status,
    }));
    api
}

fn collect_content(value: &Value, depth: usize) -> Option<String> {
    if depth > 4 || value.is_null() {
        return None;
    }
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(array) = value.as_array() {
        let parts: Vec<String> = array
            .iter()
            .filter_map(|item| collect_content(item, depth + 1))
            .collect();
        return (!parts.is_empty()).then(|| parts.join(""));
    }
    if let Some(object) = value.as_object() {
        for key in ["content", "text", "output_text", "message"] {
            if let Some(found) = object.get(key).and_then(|item| collect_content(item, depth + 1)) {
                return Some(found);
            }
        }
    }
    None
}

pub fn ai_content_of(response: &Value) -> Option<String> {
    let object = response.as_object()?;
    if let Some(choices) = object.get("choices").and_then(Value::as_array) {
        if let Some(choice) = choices.first().and_then(Value::as_object) {
            if let Some(message) = choice.get("message").and_then(Value::as_object) {
                if let Some(content) = message.get("content").and_then(|value| collect_content(value, 0)) {
                    if !content.trim().is_empty() {
                        return Some(content);
                    }
                }
            }
            if let Some(delta) = choice.get("delta").and_then(Value::as_object) {
                if let Some(content) = delta.get("content").and_then(|value| collect_content(value, 0)) {
                    if !content.trim().is_empty() {
                        return Some(content);
                    }
                }
            }
            if let Some(content) = choice.get("text").and_then(|value| collect_content(value, 0)) {
                if !content.trim().is_empty() {
                    return Some(content);
                }
            }
        }
    }
    for key in ["output_text", "content", "output", "data", "result"] {
        if let Some(found) = object.get(key).and_then(|value| collect_content(value, 0)) {
            if !found.trim().is_empty() {
                return Some(found);
            }
        }
    }
    None
}

fn model_of(response: &Value) -> Option<String> {
    response
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            response
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("model"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn usage_of(response: &Value) -> Option<Value> {
    response.get("usage").filter(|value| value.is_object()).cloned()
}

pub async fn ai_status(state: &AppState, opts: &RequestOptions) -> Value {
    {
        let cache = state.ai_status_cache.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < STATUS_TTL {
                return value.clone();
            }
        }
    }
    let checked_at = crate::now_iso();
    let mut status = json!({
        "capability": "ai",
        "provider": "tier-2-ai",
        "configured": false,
        "reachable": false,
        "status": "unavailable",
        "model": null,
        "dependency": null,
        "detail": "The Tier-2 AI capability did not respond.",
        "checked_at": checked_at,
        "base_url": state.config.tier2_url,
    });
    match state.tier2.ai().status(opts).await {
        Ok(raw) => {
            let upstream = raw.get("upstream").and_then(Value::as_object);
            let raw_status = raw
                .get("status")
                .and_then(Value::as_str)
                .or_else(|| upstream.and_then(|value| value.get("status")).and_then(Value::as_str))
                .unwrap_or("")
                .to_ascii_lowercase();
            let ok = matches!(raw_status.as_str(), "ok" | "ready" | "healthy");
            let degraded = raw_status == "degraded";
            status["configured"] = json!(ok || degraded);
            status["reachable"] = json!(true);
            status["status"] = json!(if ok {
                "ok"
            } else if degraded {
                "degraded"
            } else {
                "unavailable"
            });
            status["model"] = json!(raw
                .get("model")
                .and_then(Value::as_str)
                .or_else(|| upstream.and_then(|value| value.get("model")).and_then(Value::as_str)));
            status["dependency"] = json!(raw.get("dependency").and_then(Value::as_str));
            status["detail"] = json!(if ok {
                "Tier-2 AI capability is ready; EOP drafts are generated by the model."
            } else if degraded {
                "Tier-2 AI capability is degraded; drafts may fail and return a typed 503."
            } else {
                "Tier-2 AI capability reported that no model is configured."
            });
        }
        Err(error) => {
            let http_status = error.status();
            status["configured"] = json!(false);
            status["reachable"] = json!(matches!(http_status, Some(404 | 501)));
            status["detail"] = json!(match http_status {
                Some(404 | 501) => "The Tier-2 capabilities API does not expose an AI capability yet.",
                Some(401 | 403) => "The Tier-2 service credential is missing or lacks the AI scope.",
                _ => "The Tier-2 AI capability did not respond.",
            });
            status["dependency"] = json!("synapseone-inference");
        }
    }
    let mut cache = state.ai_status_cache.lock().unwrap_or_else(|poison| poison.into_inner());
    *cache = Some((Instant::now(), status.clone()));
    status
}

pub struct AiCompletion {
    pub content: String,
    pub model: Option<String>,
    pub usage: Option<Value>,
    pub provider: String,
}

pub async fn ai_chat(
    state: &AppState,
    opts: &RequestOptions,
    messages: Value,
    model: Option<&str>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<AiCompletion, ApiError> {
    let mut chat_opts = opts.clone().timeout(ai_timeout());
    let response = state
        .tier2
        .ai()
        .chat(messages, model, temperature, max_tokens, &chat_opts)
        .await
        .map_err(|error| {
            ai_unavailable(
                "The Tier-2 AI capability did not return a response.",
                Some(&error),
            )
        })?;
    let content = ai_content_of(&response).ok_or_else(|| {
        ai_unavailable(
            "The Tier-2 AI capability returned an empty completion.",
            None,
        )
    })?;
    Ok(AiCompletion {
        content: content.trim().to_string(),
        model: model_of(&response),
        usage: usage_of(&response),
        provider: "synapsedx".into(),
    })
}

pub fn json_object_from(text: &str) -> Option<Map<String, Value>> {
    let trimmed = text.trim();
    let mut candidates = vec![trimmed.to_string()];
    if let Some(start) = trimmed.find("```") {
        if let Some(end) = trimmed[start + 3..].find("```") {
            let inner = &trimmed[start + 3..start + 3 + end];
            candidates.push(inner.trim_start_matches("json").trim().to_string());
        }
    }
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if end > start {
            candidates.push(trimmed[start..=end].to_string());
        }
    }
    for candidate in candidates {
        if let Ok(value) = serde_json::from_str::<Value>(&candidate) {
            if let Value::Object(map) = value {
                return Some(map);
            }
        }
    }
    None
}

pub async fn hazard_brief(
    state: &AppState,
    opts: &RequestOptions,
    hours: i64,
    limit: i64,
    focus: Option<String>,
) -> Result<Value, ApiError> {
    let hours = hours.clamp(1, 168);
    let limit = limit.clamp(1, 40);
    let focus = focus.unwrap_or_default().trim().to_string();
    let key = format!("{hours}:{limit}:{focus}");
    {
        let cache = state.brief_cache.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some((at, cached_key, value)) = cache.as_ref() {
            if cached_key == &key && at.elapsed() < BRIEF_TTL {
                return Ok(value.clone());
            }
        }
    }
    let mut body = json!({ "hours": hours, "limit": limit });
    if !focus.is_empty() {
        body["focus"] = json!(focus);
    }
    let raw = state
        .tier2
        .hazards()
        .brief(body, &opts.clone().timeout(ai_timeout()))
        .await
        .map_err(|error| {
            ai_unavailable(
                "The Tier-2 hazard brief capability did not return a response.",
                Some(&error),
            )
        })?;
    let brief = raw.get("brief").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if brief.is_empty() {
        return Err(ai_unavailable(
            "The Tier-2 hazard brief capability returned an empty brief.",
            None,
        ));
    }
    let mut value = raw;
    value["provider"] = json!("synapsedx");
    value["brief"] = json!(brief);
    let mut cache = state.brief_cache.lock().unwrap_or_else(|poison| poison.into_inner());
    *cache = Some((Instant::now(), key, value.clone()));
    Ok(value)
}

pub async fn knowledge_ask(
    state: &AppState,
    opts: &RequestOptions,
    question: &str,
    top_k: i64,
    context: Option<String>,
) -> Result<Value, ApiError> {
    let text = question.trim();
    if text.is_empty() {
        return Err(ApiError::bad_request("question_required", "question is required"));
    }
    let mut body = json!({
        "question": text.chars().take(2000).collect::<String>(),
        "topK": top_k.clamp(1, 12),
    });
    if let Some(context) = context.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        body["context"] = json!(context.chars().take(4000).collect::<String>());
    }
    let raw = state
        .tier2
        .knowledge()
        .query(body, &opts.clone().timeout(ai_timeout()))
        .await
        .map_err(|error| {
            ai_unavailable(
                "The Tier-2 knowledge capability did not return a response.",
                Some(&error),
            )
        })?;
    let answer = raw.get("answer").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if answer.is_empty() {
        return Err(ai_unavailable(
            "The Tier-2 knowledge capability returned an empty answer.",
            None,
        ));
    }
    let mut value = raw;
    value["provider"] = json!("synapsedx");
    value["answer"] = json!(answer);
    Ok(value)
}
