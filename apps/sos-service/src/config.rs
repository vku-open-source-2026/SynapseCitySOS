// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Environment and production fail-closed checks for the SOS service.

use std::collections::HashSet;
use std::time::Duration;

use url::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub tier2_url: String,
    pub tier2_api_key: Option<String>,
    pub tier2_token: Option<String>,
    pub tier2_timeout: Duration,
    pub allow_local_dependencies: bool,
    pub auth_secret: String,
    pub auth_secret_ephemeral: bool,
    pub is_production: bool,
    pub auth_mode: String,
    pub allow_demo_auth: bool,
    pub bootstrap_admins: HashSet<String>,
    pub default_role: String,
    pub cors_origin: String,
    pub stream_poll_ms: u64,
    pub max_scan_records: usize,
    pub hitl_required: bool,
    pub approval_sla_minutes: u64,
    pub required_approvals: u32,
    pub dispatch_approver_roles: Vec<String>,
    pub eop_approver_roles: Vec<String>,
    pub resource_approver_roles: Vec<String>,
    pub rate_limit_disabled: bool,
    pub auth_rate_max: u32,
    pub stream_rate_max: u32,
    pub geo_rate_max: u32,
    pub ai_rate_max: u32,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_string())
}

fn env_bool(name: &str) -> bool {
    matches!(
        env(name).unwrap_or_default().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env(name)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_u32(name: &str, fallback: u32) -> u32 {
    env(name)
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_list(name: &str, fallback: &str) -> Vec<String> {
    env(name)
        .unwrap_or_else(|| fallback.to_string())
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                || v6
                    .to_ipv4_mapped()
                    .map(|mapped| {
                        mapped.is_private()
                            || mapped.is_loopback()
                            || mapped.is_link_local()
                            || mapped.is_unspecified()
                            || mapped.is_broadcast()
                            || mapped.is_multicast()
                    })
                    .unwrap_or(false)
        }
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| match ip {
                std::net::IpAddr::V4(v4) => v4.is_loopback(),
                std::net::IpAddr::V6(v6) => {
                    v6.is_loopback()
                        || v6.to_ipv4_mapped().map(|mapped| mapped.is_loopback()).unwrap_or(false)
                }
            })
            .unwrap_or(false)
}

fn is_private_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host == "host.docker.internal"
        || host == "gateway.docker.internal"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".docker")
        || host.ends_with(".svc")
        || host.ends_with(".cluster.local")
        || !host.contains('.')
}

/// Accept a public Tier-2 endpoint. RFC1918/link-local/private Docker names and
/// URLs with embedded credentials are always rejected; loopback is accepted
/// only when `ALLOW_LOCAL_DEPENDENCIES=true` outside production.
fn public_dependency(raw: &str, allow_local: bool, is_production: bool) -> Result<String, String> {
    if is_production && allow_local {
        return Err(
            "ALLOW_LOCAL_DEPENDENCIES=true is refused in production".into(),
        );
    }
    let url = Url::parse(raw)
        .map_err(|error| format!("SYNAPSEDX_BASE_URL is not an absolute URL: {raw} ({error})"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("SYNAPSEDX_BASE_URL must not contain credentials".into());
    }
    let host = url.host_str().unwrap_or("");
    if host.is_empty() {
        return Err("SYNAPSEDX_BASE_URL must include a host".into());
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = is_loopback_host(host);
    let parsed_ip = host.parse::<std::net::IpAddr>().ok();
    let private_ip = parsed_ip.map(is_private_ip).unwrap_or(false);
    let private_name = parsed_ip.is_none() && is_private_hostname(host);
    if private_ip && !loopback {
        return Err("SYNAPSEDX_BASE_URL must not use a private or link-local address".into());
    }
    if private_name && !loopback {
        return Err("SYNAPSEDX_BASE_URL must not use a private Docker or internal hostname".into());
    }
    if loopback && !allow_local {
        return Err("SYNAPSEDX_BASE_URL must be a public HTTPS endpoint".into());
    }
    if url.scheme() != "https" && !(allow_local && loopback) {
        return Err("SYNAPSEDX_BASE_URL must use HTTPS".into());
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err("SYNAPSEDX_BASE_URL must use HTTP(S)".into());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let is_production = env("NODE_ENV").as_deref() == Some("production");
        let allow_local = env_bool("ALLOW_LOCAL_DEPENDENCIES");
        let tier2_url = public_dependency(
            &env("SYNAPSEDX_BASE_URL").unwrap_or_else(|| "https://synapsedx.sbs".into()),
            allow_local,
            is_production,
        )?;

        let auth_mode = env("SOS_AUTH_MODE")
            .or_else(|| env("AUTH_MODE"))
            .unwrap_or_else(|| "tier2".into())
            .to_ascii_lowercase();
        if is_production && env_bool("ALLOW_DEMO_AUTH") {
            return Err(
                "ALLOW_DEMO_AUTH=true is refused in NODE_ENV=production; obtain identity from the Tier-2 auth capability"
                    .into(),
            );
        }
        if is_production && auth_mode == "demo" {
            return Err(
                "SOS_AUTH_MODE=demo is refused in NODE_ENV=production; use SOS_AUTH_MODE=tier2"
                    .into(),
            );
        }

        let configured_secret = env("AUTH_SECRET").unwrap_or_default();
        let (auth_secret, auth_secret_ephemeral) = if configured_secret.is_empty() {
            if is_production {
                return Err(
                    "AUTH_SECRET must be set in production (an ephemeral secret would invalidate every session on restart)"
                        .into(),
                );
            }
            let secret = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            tracing::warn!(
                "[synapsecity-sos] AUTH_SECRET is not set. Using an ephemeral session secret; sessions are invalidated on restart."
            );
            (secret, true)
        } else {
            if configured_secret.len() < 32 {
                tracing::warn!(
                    "[synapsecity-sos] AUTH_SECRET is shorter than 32 characters; use a strong secret in production."
                );
            }
            (configured_secret, false)
        };

        let bootstrap_admins = env("SOS_BOOTSTRAP_ADMIN_EMAILS")
            .unwrap_or_default()
            .split(',')
            .map(|entry| entry.trim().to_ascii_lowercase())
            .filter(|entry| !entry.is_empty())
            .collect();

        let demo_allowed = auth_mode == "demo" && env_bool("ALLOW_DEMO_AUTH") && !is_production;

        Ok(Self {
            port: env("PORT")
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(8084),
            tier2_url,
            tier2_api_key: env("SYNAPSEDX_API_KEY").filter(|value| !value.is_empty()),
            tier2_token: env("SYNAPSEDX_TOKEN").filter(|value| !value.is_empty()),
            tier2_timeout: Duration::from_millis(env_u64("SYNAPSEDX_TIMEOUT_MS", 20_000).clamp(1_000, 120_000)),
            allow_local_dependencies: allow_local,
            auth_secret,
            auth_secret_ephemeral,
            is_production,
            auth_mode,
            allow_demo_auth: demo_allowed,
            bootstrap_admins,
            default_role: env("SOS_AUTH_DEFAULT_ROLE")
                .unwrap_or_else(|| "responder".into())
                .to_ascii_lowercase(),
            cors_origin: env("CORS_ORIGIN")
                .unwrap_or_else(|| "https://sos.synapsecity.sbs".into()),
            stream_poll_ms: env_u64("SOS_STREAM_EVENT_POLL_MS", 2_000).clamp(500, 30_000),
            max_scan_records: env_u64("SOS_MAX_SCAN_RECORDS", 5_000) as usize,
            hitl_required: env_bool("SOS_HITL_REQUIRED"),
            approval_sla_minutes: env_u64("SOS_APPROVAL_SLA_MINUTES", 15).clamp(1, 7 * 24 * 60),
            required_approvals: env_u32("SOS_REQUIRED_APPROVALS", 1).clamp(1, 5),
            dispatch_approver_roles: env_list(
                "SOS_DISPATCH_APPROVER_ROLES",
                "incident-commander,duty-manager",
            ),
            eop_approver_roles: env_list(
                "SOS_EOP_APPROVER_ROLES",
                "incident-commander,duty-manager",
            ),
            resource_approver_roles: env_list(
                "SOS_RESOURCE_APPROVER_ROLES",
                "incident-commander,duty-manager",
            ),
            rate_limit_disabled: env_bool("RATE_LIMIT_DISABLED"),
            auth_rate_max: env_u32("RATE_LIMIT_AUTH_MAX", 60),
            stream_rate_max: env_u32("RATE_LIMIT_STREAM_MAX", 30),
            geo_rate_max: env_u32("RATE_LIMIT_GEO_MAX", 120),
            ai_rate_max: env_u32("RATE_LIMIT_AI_MAX", 30),
        })
    }

    pub fn demo_auth_allowed(&self) -> bool {
        self.auth_mode == "demo" && self.allow_demo_auth && !self.is_production
    }

    pub fn tier2_client(&self) -> Result<synapsedx::Client, String> {
        let mut credentials = synapsedx::Credentials::none();
        if let Some(token) = &self.tier2_token {
            credentials = credentials.with_token(token.clone());
        }
        if let Some(key) = &self.tier2_api_key {
            credentials = credentials.with_api_key(key.clone());
        }
        synapsedx::Client::builder(self.tier2_url.clone())
            .credentials(credentials)
            .timeout(self.tier2_timeout)
            .retries(1)
            .build()
            .map_err(|error| error.to_string())
    }
}


#[cfg(test)]
impl Config {
    pub fn for_test(tier2_url: impl Into<String>) -> Self {
        Self {
            port: 0,
            tier2_url: tier2_url.into(),
            tier2_api_key: Some("test-key".into()),
            tier2_token: None,
            tier2_timeout: Duration::from_secs(5),
            allow_local_dependencies: true,
            auth_secret: "0123456789012345678901234567890123456789012345678901234567890123".into(),
            auth_secret_ephemeral: false,
            is_production: false,
            auth_mode: "demo".into(),
            allow_demo_auth: true,
            bootstrap_admins: HashSet::new(),
            default_role: "responder".into(),
            cors_origin: "http://localhost".into(),
            stream_poll_ms: 1_000,
            max_scan_records: 5_000,
            hitl_required: false,
            approval_sla_minutes: 15,
            required_approvals: 1,
            dispatch_approver_roles: vec!["duty-manager".into()],
            eop_approver_roles: vec!["duty-manager".into()],
            resource_approver_roles: vec!["duty-manager".into()],
            rate_limit_disabled: true,
            auth_rate_max: 1_000,
            stream_rate_max: 1_000,
            geo_rate_max: 1_000,
            ai_rate_max: 1_000,
        }
    }
}


#[cfg(test)]
mod tests {
    use super::public_dependency;

    #[test]
    fn accepts_public_https_endpoint() {
        assert_eq!(
            public_dependency("https://synapsedx.sbs", false, true).unwrap(),
            "https://synapsedx.sbs"
        );
        assert_eq!(
            public_dependency("https://[2606:4700:4700::1111]/api", false, true).unwrap(),
            "https://[2606:4700:4700::1111]/api"
        );
    }

    #[test]
    fn rejects_non_https_public_endpoint() {
        assert!(public_dependency("http://synapsedx.sbs", false, true).is_err());
        assert!(public_dependency("http://example.com:8080", false, false).is_err());
    }

    #[test]
    fn rejects_credentials_in_url() {
        assert!(public_dependency("https://user:pass@synapsedx.sbs", false, true).is_err());
        assert!(public_dependency("https://user@synapsedx.sbs", false, true).is_err());
    }

    #[test]
    fn rejects_private_ipv4_and_ipv6() {
        for raw in [
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://192.168.1.1",
            "http://169.254.1.1",
            "http://100.64.0.1",
            "http://0.0.0.0",
            "http://[fe80::1]",
            "http://[fc00::1]",
            "http://[::ffff:10.0.0.1]",
        ] {
            assert!(
                public_dependency(raw, false, false).is_err(),
                "expected rejection for {raw}"
            );
            assert!(
                public_dependency(raw, true, false).is_err(),
                "private address must stay rejected even with allow_local: {raw}"
            );
        }
    }

    #[test]
    fn rejects_private_docker_and_single_label_hosts() {
        for raw in [
            "http://redis:6379",
            "http://city-service:8083",
            "http://host.docker.internal:8082",
            "http://gateway.docker.internal:8082",
            "http://service.local",
            "http://service.internal",
            "http://service.svc",
            "http://service.cluster.local",
        ] {
            assert!(
                public_dependency(raw, false, false).is_err(),
                "expected rejection for {raw}"
            );
            assert!(
                public_dependency(raw, true, false).is_err(),
                "private Docker host must stay rejected with allow_local: {raw}"
            );
        }
    }

    #[test]
    fn loopback_only_with_explicit_dev_opt_in() {
        assert!(public_dependency("http://127.0.0.1:8082", false, false).is_err());
        assert!(public_dependency("http://localhost:8082", false, false).is_err());
        assert!(public_dependency("http://[::1]:8082", false, false).is_err());
        assert_eq!(
            public_dependency("http://127.0.0.1:8082", true, false).unwrap(),
            "http://127.0.0.1:8082"
        );
        assert_eq!(
            public_dependency("http://localhost:8082", true, false).unwrap(),
            "http://localhost:8082"
        );
        assert_eq!(
            public_dependency("http://[::1]:8082", true, false).unwrap(),
            "http://[::1]:8082"
        );
        assert_eq!(
            public_dependency("http://[::ffff:127.0.0.1]:8082", true, false).unwrap(),
            "http://[::ffff:127.0.0.1]:8082"
        );
    }

    #[test]
    fn refuses_local_dependencies_in_production() {
        assert!(public_dependency("http://127.0.0.1:8082", true, true).is_err());
    }
}
