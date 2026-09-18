//! Sanitized daemon telemetry sent to Sacrum over the daemon channel.
//!
//! This module deliberately exposes only stable, user-visible metadata. In
//! particular, reports never contain credentials, executable paths, startup
//! diagnostics, project identifiers, or capacity information.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use vertebrae_core::Provider;

use crate::capabilities::DaemonCapabilities;

pub const REPORT_VERSION: u8 = 1;

/// Application heartbeat interval. Phoenix protocol heartbeats are separate
/// and do not update Sacrum's daemon liveness metrics.
pub const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CapabilityReport {
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub providers: BTreeMap<String, bool>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub harnesses: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DaemonReport {
    pub version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<CapabilityReport>,
}

impl DaemonReport {
    /// Build a report from the startup snapshot, omitting any data that was
    /// not discovered. The snapshot is reused on reconnect so a report never
    /// exposes transient paths or diagnostics gathered by the daemon.
    pub fn from_capabilities(
        daemon_id: &str,
        capabilities: &DaemonCapabilities,
        started_at: DateTime<Utc>,
    ) -> Self {
        let capability_report = capability_report(capabilities);

        Self {
            version: REPORT_VERSION,
            daemon_id: non_empty(daemon_id).map(str::to_owned),
            daemon_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            os: Some(std::env::consts::OS.to_owned()),
            architecture: Some(std::env::consts::ARCH.to_owned()),
            host: host_name(),
            started_at: Some(started_at.to_rfc3339()),
            capabilities: (!capability_report.providers.is_empty()
                || !capability_report.harnesses.is_empty())
            .then_some(capability_report),
        }
    }

    pub fn payload(&self) -> Result<Value, serde_json::Error> {
        serde_json::to_value(self)
    }

    /// Sacrum accepts an empty heartbeat as a liveness-only update.
    pub fn heartbeat_payload() -> Value {
        serde_json::json!({})
    }
}

fn capability_report(capabilities: &DaemonCapabilities) -> CapabilityReport {
    let mut providers = BTreeMap::new();
    let mut harnesses = BTreeMap::new();

    for (provider, provider_name, harness_name) in [
        (Provider::Anthropic, "anthropic", "claude_code"),
        (Provider::Openai, "openai", "codex"),
    ] {
        if let Some(capability) = capabilities.harnesses.get(&provider) {
            providers.insert(provider_name.to_owned(), capability.executable.is_some());
            harnesses.insert(harness_name.to_owned(), capability.executable.is_some());
        } else if capabilities.provider_binaries.get(provider).is_some() {
            providers.insert(provider_name.to_owned(), true);
            harnesses.insert(harness_name.to_owned(), true);
        }
    }

    CapabilityReport {
        providers,
        harnesses,
    }
}

fn host_name() -> Option<String> {
    ["HOSTNAME", "COMPUTERNAME"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok())
        .and_then(|value| sanitize_string(&value))
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn sanitize_string(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.chars().take(256).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::{DaemonCapabilities, HarnessCapability};
    use crate::helpers::{ProviderBinaries, ProviderDiscoveryDiagnostics};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn capabilities(anthropic: Option<&str>, openai: Option<&str>) -> DaemonCapabilities {
        DaemonCapabilities {
            harnesses: HashMap::from([
                (
                    Provider::Anthropic,
                    HarnessCapability {
                        executable: anthropic.map(PathBuf::from),
                        discovery_diagnostic: None,
                    },
                ),
                (
                    Provider::Openai,
                    HarnessCapability {
                        executable: openai.map(PathBuf::from),
                        discovery_diagnostic: None,
                    },
                ),
            ]),
            provider_binaries: ProviderBinaries {
                anthropic: anthropic.map(PathBuf::from),
                openai: openai.map(PathBuf::from),
            },
            shell_path: "/secret/shell/path".into(),
            installed_skills_roots: vec![PathBuf::from("/secret/skills")],
            installed_skills_diagnostic: Some("secret diagnostic".into()),
            claude_plugin_dir: vertebrae_installer::ClaudePluginDirResolution {
                plugin_root: Some(PathBuf::from("/secret/plugin")),
                warning: Some("secret warning".into()),
            },
            typesafe_api_key: None,
            typesafe_base_url: None,
        }
    }

    #[test]
    fn report_contains_supported_version_and_discovered_capabilities() {
        let report = DaemonReport::from_capabilities(
            "33333333-3333-3333-3333-333333333333",
            &capabilities(Some("/usr/local/bin/claude"), None),
            DateTime::parse_from_rfc3339("2026-09-18T10:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        );

        let payload = report.payload().unwrap();
        assert_eq!(payload["version"], 1);
        assert_eq!(payload["capabilities"]["providers"]["anthropic"], true);
        assert_eq!(payload["capabilities"]["providers"]["openai"], false);
        assert_eq!(payload["capabilities"]["harnesses"]["claude_code"], true);
        assert_eq!(payload["capabilities"]["harnesses"]["codex"], false);
        assert!(!payload.to_string().contains("/usr/local/bin"));
        assert!(!payload.to_string().contains("secret"));
    }

    #[test]
    fn empty_capability_snapshot_is_not_fabricated() {
        let mut caps = capabilities(None, None);
        caps.harnesses.clear();
        let report = DaemonReport::from_capabilities("daemon", &caps, Utc::now());
        assert!(report.capabilities.is_none());
    }

    #[test]
    fn heartbeat_payload_is_empty() {
        assert_eq!(DaemonReport::heartbeat_payload(), serde_json::json!({}));
    }

    #[test]
    fn control_characters_are_not_published_as_hostnames() {
        assert_eq!(sanitize_string("host\nname"), None);
        assert_eq!(sanitize_string(" host "), Some("host".into()));
    }

    #[allow(dead_code)]
    fn _diagnostics_remain_unpublished(_: ProviderDiscoveryDiagnostics) {}
}
