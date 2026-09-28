//! Immutable capabilities discovered once while the daemon is booting.
//!
//! Discovery is descriptive only. A missing provider is retained as a
//! diagnostic and does not remove that provider from the map or prevent the
//! daemon from starting. The requested step still receives the same provider
//! resolution error when it attempts to use the missing binary.

use std::{
    collections::{BTreeMap, HashMap},
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
};

use vertebrae_core::{ProviderId, ProviderProfile, StepHarness};
use vertebrae_harness::HarnessFactoryConfig;
use vertebrae_installer::ClaudePluginDirResolution;

use crate::helpers::{ProviderBinaries, ProviderDiscoveryDiagnostics};

/// The startup-discovered state for one built-in provider harness.
#[derive(Debug, Clone)]
pub struct HarnessCapability {
    /// The executable selected during startup, when discovery succeeded.
    pub executable: Option<PathBuf>,
    /// Discovery failure or other diagnostic retained for startup logging.
    pub discovery_diagnostic: Option<String>,
}

#[derive(Clone)]
pub struct DaemonCapabilities {
    pub harnesses: HashMap<StepHarness, HarnessCapability>,
    pub provider_binaries: ProviderBinaries,
    pub shell_path: String,
    pub installed_skills_roots: Vec<PathBuf>,
    pub installed_skills_diagnostic: Option<String>,
    pub claude_plugin_dir: ClaudePluginDirResolution,
    pub typesafe_api_key: Option<String>,
    pub typesafe_base_url: Option<String>,
    pub typesafe_url: Option<String>,
    pub provider_profiles: BTreeMap<ProviderId, ProviderProfile>,
}

impl fmt::Debug for DaemonCapabilities {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonCapabilities")
            .field("harnesses", &self.harnesses)
            .field("provider_binaries", &self.provider_binaries)
            .field("shell_path", &self.shell_path)
            .field("installed_skills_roots", &self.installed_skills_roots)
            .field(
                "installed_skills_diagnostic",
                &self.installed_skills_diagnostic,
            )
            .field("claude_plugin_dir", &self.claude_plugin_dir)
            .field(
                "typesafe_api_key",
                &self.typesafe_api_key.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "typesafe_base_url",
                &redacted_base_url(&self.typesafe_base_url),
            )
            .field(
                "typesafe_url",
                &self.typesafe_url.as_ref().map(|_| "<redacted>"),
            )
            .field("provider_profiles", &self.provider_profiles)
            .finish()
    }
}

fn redacted_base_url(base_url: &Option<String>) -> Option<String> {
    base_url.as_ref().map(|value| {
        if value.contains('@') || value.contains('?') || value.contains('#') {
            "<redacted>".to_string()
        } else {
            value.clone()
        }
    })
}

impl DaemonCapabilities {
    /// Build the process-lifetime snapshot after shell PATH and provider
    /// discovery have completed.
    pub fn new(
        shell_path: String,
        provider_binaries: ProviderBinaries,
        provider_diagnostics: ProviderDiscoveryDiagnostics,
        working_dir: &Path,
        typesafe_api_key: Option<String>,
        typesafe_base_url: Option<String>,
        typesafe_url: Option<String>,
    ) -> Self {
        let installed_skills = vertebrae_installer::installed_skills_dir();
        let (installed_skills_roots, installed_skills_diagnostic) = match installed_skills {
            Ok(path) => (vec![path], None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };

        let harnesses = [
            (
                StepHarness::Claude,
                HarnessCapability {
                    executable: provider_binaries.anthropic.clone(),
                    discovery_diagnostic: provider_diagnostics.anthropic.clone(),
                },
            ),
            (
                StepHarness::Codex,
                HarnessCapability {
                    executable: provider_binaries.openai.clone(),
                    discovery_diagnostic: provider_diagnostics.openai.clone(),
                },
            ),
            (
                StepHarness::Typesafe,
                HarnessCapability {
                    executable: None,
                    discovery_diagnostic: (!typesafe_api_key
                        .as_deref()
                        .is_some_and(|key| !key.trim().is_empty()))
                    .then(|| {
                        "TypeSafe provider API key is not configured; set [typesafe].api_key in config.toml or TYPESAFE_API_KEY".to_string()
                    }),
                },
            ),
        ]
        .into_iter()
        .collect();

        let claude_plugin_dir = match provider_binaries.anthropic.as_deref() {
            Some(binary) => {
                vertebrae_installer::resolve_claude_plugin_dir(binary, working_dir, &shell_path)
            }
            None => ClaudePluginDirResolution {
                plugin_root: None,
                warning: provider_diagnostics.anthropic.as_ref().map(|diagnostic| {
                    format!(
                        "Vertebrae skipped automatic installed-skill loading because {diagnostic}."
                    )
                }),
            },
        };

        Self {
            harnesses,
            provider_binaries,
            shell_path,
            installed_skills_roots,
            installed_skills_diagnostic,
            claude_plugin_dir,
            typesafe_api_key,
            typesafe_base_url,
            typesafe_url,
            provider_profiles: BTreeMap::new(),
        }
    }

    pub fn with_provider_profiles(
        mut self,
        provider_profiles: BTreeMap<ProviderId, ProviderProfile>,
    ) -> Self {
        self.provider_profiles = provider_profiles;
        self
    }

    /// Copy server-owned provider settings (the `[typesafe]` section and
    /// custom provider profiles) into a harness factory configuration.
    pub(crate) fn configure_provider_harnesses(&self, config: &mut HarnessFactoryConfig) {
        config.typesafe_api_key = self.typesafe_api_key.clone();
        config.typesafe_base_url = self.typesafe_base_url.clone();
        config.typesafe_url = self.typesafe_url.clone();
        config.provider_profiles = self.provider_profiles.clone();
    }

    /// Whether a configured custom provider can currently run: its profile is
    /// valid and its harness executable was resolved at startup.
    pub fn custom_provider_available(&self, id: &ProviderId, profile: &ProviderProfile) -> bool {
        profile.validate(id).is_ok()
            && match profile.harness {
                StepHarness::Claude | StepHarness::Codex => {
                    self.provider_binaries.get(profile.harness).is_some()
                }
                StepHarness::Typesafe => true,
            }
    }

    /// Log the cached compatibility result once during daemon startup.
    pub fn log_startup_diagnostics(&self) {
        for (id, profile) in &self.provider_profiles {
            match profile.validate(id) {
                Ok(()) => tracing::info!(
                    provider = %id,
                    harness = %profile.harness,
                    models = profile.models.len(),
                    "Custom provider configured"
                ),
                Err(error) => tracing::warn!(
                    provider = %id,
                    error = %error,
                    "Custom provider profile is invalid; steps selecting it will fail"
                ),
            }
        }
        for (harness, capability) in &self.harnesses {
            if let Some(diagnostic) = &capability.discovery_diagnostic {
                tracing::warn!(
                    harness = %harness,
                    error = %diagnostic,
                    "Provider discovery diagnostic retained in startup capabilities"
                );
            }
        }
        if let Some(diagnostic) = &self.installed_skills_diagnostic {
            tracing::warn!(
                error = %diagnostic,
                "Installed-skills discovery diagnostic retained in startup capabilities"
            );
        }
        match (
            &self.claude_plugin_dir.plugin_root,
            &self.claude_plugin_dir.warning,
        ) {
            (Some(plugin_root), _) => tracing::info!(
                plugin_root = %plugin_root.display(),
                "Cached Claude installed-skill compatibility result: managed skills enabled"
            ),
            (None, Some(warning)) => tracing::warn!(
                warning = %warning,
                "Cached Claude installed-skill compatibility result: managed skills not injected"
            ),
            (None, None) => tracing::info!(
                "Cached Claude installed-skill compatibility result: no managed plugin root"
            ),
        }
        tracing::info!(
            "Startup capabilities are cached for the process lifetime; provider, Claude Code, or skill changes take effect after restart"
        );
    }
}

/// Shared pointer used by daemon, project, and step actor configurations.
pub type SharedDaemonCapabilities = Arc<DaemonCapabilities>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::helpers::{ProviderBinaries, ProviderDiscoveryDiagnostics};
    use async_trait::async_trait;
    use serde_json::json;
    use vertebrae_harness::{HarnessRuntimeFactory, HarnessRuntimeOptions};
    use vertebrae_harness_core::{
        CompletionStatus, EventSink, HarnessError, HarnessEventV1, RunId, StreamId,
        StructuredInferenceRequest,
    };
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

    struct DiscardEvents;

    #[async_trait]
    impl EventSink for DiscardEvents {
        async fn emit(&self, _event: HarnessEventV1) -> Result<(), HarnessError> {
            Ok(())
        }
    }

    #[test]
    fn missing_provider_discovery_is_retained_without_filtering_harnesses() {
        let capabilities = DaemonCapabilities::new(
            "/usr/bin:/bin".to_string(),
            ProviderBinaries::default(),
            ProviderDiscoveryDiagnostics {
                anthropic: Some("Claude Code CLI not found".to_string()),
                openai: Some("Codex CLI not found".to_string()),
            },
            Path::new("/tmp/project"),
            None,
            None,
            None,
        );

        assert_eq!(capabilities.harnesses.len(), 3);
        assert_eq!(
            capabilities
                .harnesses
                .get(&StepHarness::Claude)
                .and_then(|capability| capability.discovery_diagnostic.as_deref()),
            Some("Claude Code CLI not found")
        );
        assert!(
            capabilities
                .harnesses
                .get(&StepHarness::Codex)
                .is_some_and(|capability| capability.executable.is_none())
        );
        assert_eq!(
            capabilities
                .harnesses
                .get(&StepHarness::Typesafe)
                .and_then(|capability| capability.discovery_diagnostic.as_deref()),
            Some(
                "TypeSafe provider API key is not configured; set [typesafe].api_key in config.toml or TYPESAFE_API_KEY"
            )
        );
    }

    #[test]
    fn typesafe_startup_credentials_are_redacted_from_capability_debug() {
        let capabilities = DaemonCapabilities::new(
            "/usr/bin:/bin".to_string(),
            ProviderBinaries::default(),
            ProviderDiscoveryDiagnostics::default(),
            Path::new("/tmp/project"),
            Some("typesafe-secret".into()),
            Some("https://typesafe.example.test".into()),
            Some("https://user:typesafe-url-secret@example.test/v1/systemone".into()),
        );

        let debug = format!("{capabilities:?}");
        assert!(!debug.contains("typesafe-secret"));
        assert!(!debug.contains("typesafe-url-secret"));
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("TYPESAFE_API_KEY"));
    }

    #[tokio::test]
    async fn typesafe_url_from_config_reaches_the_exact_http_endpoint() {
        let server = MockServer::start().await;
        let endpoint = format!("{}/configured/system-one", server.uri());
        let config: vertebrae_sacrum_client::VertebraeConfigFile = toml::from_str(&format!(
            r#"
[sacrum]
token = "test-sacrum-token"

[typesafe]
api_key = "config-only-typesafe-key"
url = "{endpoint}"
"#
        ))
        .unwrap();
        let resolved = crate::config::ResolvedConfig::from_config_file(&config).unwrap();
        Mock::given(matchers::method("POST"))
            .and(matchers::path("/configured/system-one"))
            .and(matchers::header(
                "authorization",
                "Bearer config-only-typesafe-key",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model": "jev-custom",
                "answers": {
                    "is_urgent": {"type": "noul", "noul": 0.92}
                },
                "usage": {"input_tokens": 12, "output_tokens": 4}
            })))
            .expect(1)
            .mount(&server)
            .await;

        let capabilities = DaemonCapabilities::new(
            "/usr/bin:/bin".to_string(),
            ProviderBinaries::default(),
            ProviderDiscoveryDiagnostics::default(),
            Path::new("/tmp/project"),
            resolved.typesafe_api_key,
            None,
            resolved.typesafe_url,
        )
        .with_provider_profiles(resolved.provider_profiles);
        let mut factory_config = HarnessFactoryConfig::default();
        capabilities.configure_provider_harnesses(&mut factory_config);
        let instance = HarnessRuntimeFactory::new(factory_config)
            .create(HarnessRuntimeOptions {
                agent_config: vertebrae_core::AgentConfig::new()
                    .with_provider(ProviderId::typesafe())
                    .with_model("jev-custom"),
                request_config: Default::default(),
            })
            .expect("TypeSafe harness should use the daemon capability snapshot");
        assert!(instance.request_config.environment.is_empty());

        let run = instance
            .runtime
            .run_structured_inference(
                StructuredInferenceRequest {
                    run_id: RunId::from("run-config-typesafe"),
                    stream_id: StreamId::from("stream-config-typesafe"),
                    state: json!({"ticket": {"title": "Example"}}),
                    model: Some("jev-custom".into()),
                    questions: std::collections::BTreeMap::from([(
                        "is_urgent".into(),
                        json!({"type": "noul", "instructions": "Does this need urgent handling?"}),
                    )]),
                },
                Arc::new(DiscardEvents),
            )
            .await
            .expect("structured inference should be accepted");
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(2), run.await_outcome())
            .await
            .expect("stub response should complete promptly")
            .expect("TypeSafe run should complete");
        assert_eq!(outcome.status, CompletionStatus::Completed);
        assert_eq!(
            outcome.structured_output,
            Some(json!({"is_urgent": {"type": "noul", "noul": 0.92}}))
        );
        let received = server.received_requests().await.unwrap();
        assert_eq!(received.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&received[0].body).unwrap();
        assert_eq!(body["state"], json!({"ticket": {"title": "Example"}}));
        assert_eq!(body["model"], "jev-custom");
        assert_eq!(body["questions"]["is_urgent"]["type"], "noul");
        server.verify().await;
    }

    #[tokio::test]
    async fn custom_typesafe_provider_uses_its_own_url_and_key_while_builtin_keeps_section() {
        let server = MockServer::start().await;
        let config: vertebrae_sacrum_client::VertebraeConfigFile = toml::from_str(&format!(
            r#"
[sacrum]
token = "test-sacrum-token"

[typesafe]
api_key = "section-typesafe-key"
url = "{uri}/section/system-one"

[providers.staging]
harness = "typesafe"
url = "{uri}/staging/system-one"
api_key_env = "VTB_TEST_UNSET_STAGING_TYPESAFE_KEY_91C2"
api_key = "staging-typesafe-key"
models = ["jev-staging"]
"#,
            uri = server.uri()
        ))
        .unwrap();
        let resolved = crate::config::ResolvedConfig::from_config_file(&config).unwrap();
        for (path, key, model) in [
            ("/staging/system-one", "staging-typesafe-key", "jev-staging"),
            ("/section/system-one", "section-typesafe-key", "jev-latest"),
        ] {
            Mock::given(matchers::method("POST"))
                .and(matchers::path(path))
                .and(matchers::header("authorization", format!("Bearer {key}")))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "model": model,
                    "answers": {"is_urgent": {"type": "noul", "noul": 0.5}},
                    "usage": {"input_tokens": 3, "output_tokens": 1}
                })))
                .expect(1)
                .mount(&server)
                .await;
        }

        let capabilities = DaemonCapabilities::new(
            "/usr/bin:/bin".to_string(),
            ProviderBinaries::default(),
            ProviderDiscoveryDiagnostics::default(),
            Path::new("/tmp/project"),
            resolved.typesafe_api_key,
            None,
            resolved.typesafe_url,
        )
        .with_provider_profiles(resolved.provider_profiles);
        let debug = format!("{capabilities:?}");
        assert!(!debug.contains("staging-typesafe-key"), "{debug}");
        assert!(!debug.contains("/staging/system-one"), "{debug}");
        let mut factory_config = HarnessFactoryConfig::default();
        capabilities.configure_provider_harnesses(&mut factory_config);
        let factory = HarnessRuntimeFactory::new(factory_config);

        for provider in [ProviderId::new("staging").unwrap(), ProviderId::typesafe()] {
            let instance = factory
                .create_for_harness(
                    Some(StepHarness::Typesafe),
                    HarnessRuntimeOptions {
                        agent_config: vertebrae_core::AgentConfig::new()
                            .with_provider(provider.clone()),
                        request_config: Default::default(),
                    },
                )
                .unwrap_or_else(|error| panic!("{provider} should construct: {error}"));
            let run = instance
                .runtime
                .run_structured_inference(
                    StructuredInferenceRequest {
                        run_id: RunId::from(format!("run-{provider}")),
                        stream_id: StreamId::from(format!("stream-{provider}")),
                        state: json!({"ticket": {"title": "Example"}}),
                        model: instance.request_config.model.clone(),
                        questions: std::collections::BTreeMap::from([(
                            "is_urgent".into(),
                            json!({"type": "noul", "instructions": "Urgent?"}),
                        )]),
                    },
                    Arc::new(DiscardEvents),
                )
                .await
                .expect("structured inference should be accepted");
            let outcome =
                tokio::time::timeout(std::time::Duration::from_secs(2), run.await_outcome())
                    .await
                    .expect("stub response should complete promptly")
                    .expect("TypeSafe run should complete");
            assert_eq!(
                outcome.status,
                CompletionStatus::Completed,
                "{provider}: {outcome:?}"
            );
        }
        server.verify().await;
    }
}
