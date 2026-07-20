//! Provider selection and pre-launch validation for daemon harness runs.
//!
//! Provider-specific launch arguments and protocols live in the reusable
//! harness crates. The daemon only selects the requested provider and reports
//! configuration or startup-resolution errors to the workflow.

use vertebrae_core::Provider;
use vertebrae_core::models::AgentConfig;

use crate::actors::step_executor::StepExecutorConfig;

#[derive(Debug)]
pub enum ProviderResolutionError {
    InvalidProviderModel(String),
    InvalidReasoningEffort(String),
    MissingProviderBinary { provider: Provider, hint: String },
}

impl std::fmt::Display for ProviderResolutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidProviderModel(message) | Self::InvalidReasoningEffort(message) => {
                f.write_str(message)
            }
            Self::MissingProviderBinary { provider, hint } => write!(
                f,
                "{provider} provider requested but its CLI binary was not resolved at daemon startup. {hint}"
            ),
        }
    }
}

impl std::error::Error for ProviderResolutionError {}

/// Resolve which built-in provider should run this step. `None` preserves the
/// historical default of Anthropic.
pub fn resolve_provider(config: &StepExecutorConfig) -> Provider {
    resolve_provider_from_agent_config(&config.step_config.agent_config)
}

pub fn resolve_provider_from_agent_config(agent_config: &AgentConfig) -> Provider {
    agent_config.provider.unwrap_or(Provider::Anthropic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_provider_defaults_to_anthropic() {
        assert_eq!(
            resolve_provider_from_agent_config(&AgentConfig::default()),
            Provider::Anthropic
        );
    }

    #[test]
    fn explicit_openai_provider_is_preserved() {
        assert_eq!(
            resolve_provider_from_agent_config(&AgentConfig::new().with_provider(Provider::Openai)),
            Provider::Openai
        );
    }

    #[test]
    fn missing_binary_error_includes_provider_and_hint() {
        let error = ProviderResolutionError::MissingProviderBinary {
            provider: Provider::Openai,
            hint: "Set CODEX_PATH".into(),
        };
        let rendered = error.to_string();
        assert!(rendered.contains("openai"));
        assert!(rendered.contains("CODEX_PATH"));
    }
}
