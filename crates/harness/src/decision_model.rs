//! Shared decision-role resolution for local chat and durable execution consumers.
use super::{HarnessRuntimeFactory, HarnessRuntimeInstance, HarnessRuntimeOptions};
use vertebrae_core::{AgentConfig, DecisionModelConfig, ProviderId, StepHarness};
use vertebrae_harness_core::{HarnessError, RequestConfig};

/// Validated identity only: secrets remain in the existing factory/provider profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDecisionModel {
    pub provider: ProviderId,
    pub harness: StepHarness,
    pub model: String,
}

impl HarnessRuntimeFactory {
    /// Resolve against this request's provider snapshot, without spawning a process
    /// or requiring credentials. Disabled roles return None, including stale selections.
    pub fn resolve_decision_model(
        &self,
        selection: &DecisionModelConfig,
    ) -> Result<Option<ResolvedDecisionModel>, HarnessError> {
        if !selection.enabled {
            return Ok(None);
        }
        let provider = selection.provider.clone().ok_or_else(|| {
            HarnessError::InvalidRequest("Select a decision model provider.".into())
        })?;
        let model = selection
            .model
            .as_deref()
            .filter(|m| !m.trim().is_empty())
            .ok_or_else(|| HarnessError::InvalidRequest("Select a decision model.".into()))?;
        if model != model.trim() {
            return Err(HarnessError::InvalidRequest(
                "Decision model IDs must not have surrounding whitespace.".into(),
            ));
        }
        let agent = AgentConfig::new().with_provider(provider.clone());
        let resolved = self.resolve_provider(None, &agent)?;
        if let Some(profile) = &resolved.profile {
            profile
                .resolve_model(&provider, Some(model))
                .map_err(HarnessError::InvalidRequest)?;
        } else if let Some(builtin) = provider.builtin() {
            vertebrae_core::validate_provider_model(builtin, Some(model))
                .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        }
        Ok(Some(ResolvedDecisionModel {
            provider,
            harness: resolved.harness,
            model: model.into(),
        }))
    }

    /// Build through the normal harness path. Availability and credentials are
    /// checked there; failure never falls back to the conversational model.
    /// This does not send a request or execute classification.
    pub fn create_decision_runtime(
        &self,
        selection: &DecisionModelConfig,
        mut request_config: RequestConfig,
    ) -> Result<Option<HarnessRuntimeInstance>, HarnessError> {
        let Some(resolved) = self.resolve_decision_model(selection)? else {
            return Ok(None);
        };
        request_config.model = Some(resolved.model.clone());
        let options = HarnessRuntimeOptions {
            agent_config: AgentConfig::new()
                .with_provider(resolved.provider)
                .with_model(resolved.model),
            request_config,
        };
        self.create_for_harness(Some(resolved.harness), options)
            .map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HarnessFactoryConfig;
    use vertebrae_core::ProviderProfile;

    fn selection(provider: &str, model: &str) -> DecisionModelConfig {
        DecisionModelConfig {
            enabled: true,
            provider: Some(ProviderId::new(provider).unwrap()),
            model: Some(model.into()),
        }
    }

    #[test]
    fn disabled_decisions_ignore_stale_configuration() {
        let factory = HarnessRuntimeFactory::default();
        let mut config = selection("removed", "unknown");
        config.enabled = false;
        assert_eq!(factory.resolve_decision_model(&config).unwrap(), None);
        assert!(
            factory
                .create_decision_runtime(&config, RequestConfig::default())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn builtins_resolve_without_credentials_or_processes() {
        let factory = HarnessRuntimeFactory::default();
        for (provider, model, harness) in [
            ("anthropic", "haiku", StepHarness::Claude),
            ("openai", "gpt-5", StepHarness::Codex),
            ("typesafe", "jev-latest", StepHarness::Typesafe),
        ] {
            let resolved = factory
                .resolve_decision_model(&selection(provider, model))
                .unwrap()
                .unwrap();
            assert_eq!(resolved.harness, harness);
            assert_eq!(resolved.model, model);
        }
        assert!(
            factory
                .resolve_decision_model(&selection("openai", "haiku"))
                .is_err()
        );
        assert!(
            factory
                .resolve_decision_model(&selection("removed", "model-a"))
                .is_err()
        );
        assert!(
            factory
                .resolve_decision_model(&selection("openai", " "))
                .is_err()
        );
    }

    #[test]
    fn custom_decisions_use_profile_harness_and_exact_models() {
        let mut config = HarnessFactoryConfig::default();
        let mut profile = ProviderProfile::new(StepHarness::Codex);
        profile.models = vec!["model-a".into()];
        profile.default_model = Some("model-a".into());
        config
            .provider_profiles
            .insert(ProviderId::new("custom").unwrap(), profile);
        let factory = HarnessRuntimeFactory::new(config);
        let resolved = factory
            .resolve_decision_model(&selection("custom", "model-a"))
            .unwrap()
            .unwrap();
        assert_eq!(resolved.harness, StepHarness::Codex);
        assert!(
            factory
                .resolve_decision_model(&selection("custom", "model-b"))
                .is_err()
        );
    }

    #[test]
    fn unavailable_harness_does_not_fall_back() {
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            provider_resolution_cached: true,
            openai_executable_diagnostic: Some("Codex is not installed".into()),
            ..Default::default()
        });
        assert!(
            factory
                .create_decision_runtime(&selection("openai", "gpt-5"), RequestConfig::default())
                .is_err()
        );
    }
}
