//! Provider selection and pre-launch validation for daemon harness runs.
//!
//! Provider-specific launch arguments and protocols live in the reusable
//! harness crates. The daemon only selects the requested provider (built-in or
//! a custom `[providers.<id>]` profile from its startup config) and reports
//! configuration or startup-resolution errors to the workflow.

use vertebrae_core::models::AgentConfig;
use vertebrae_core::{ProviderId, StepHarness};
use vertebrae_harness::ResolvedProvider;
use vertebrae_harness_core::HarnessError;

use crate::actors::step_executor::StepExecutorConfig;
use crate::capabilities::DaemonCapabilities;

#[derive(Debug)]
pub enum ProviderResolutionError {
    InvalidProviderModel(String),
    InvalidReasoningEffort(String),
    MissingProviderBinary { harness: StepHarness, hint: String },
}

impl std::fmt::Display for ProviderResolutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidProviderModel(message) | Self::InvalidReasoningEffort(message) => {
                f.write_str(message)
            }
            Self::MissingProviderBinary { harness, hint } => write!(
                f,
                "{harness} harness requested but its CLI binary was not resolved at daemon startup. {hint}"
            ),
        }
    }
}

impl std::error::Error for ProviderResolutionError {}

/// Resolve which provider and harness should run this step, using the custom
/// provider profiles captured at daemon startup.
pub fn resolve_provider(config: &StepExecutorConfig) -> Result<ResolvedProvider, HarnessError> {
    resolve_provider_from_agent_config(
        config.step_config.harness,
        &config.step_config.agent_config,
        &config.capabilities,
    )
}

pub fn resolve_provider_from_agent_config(
    harness: Option<StepHarness>,
    agent_config: &AgentConfig,
    capabilities: &DaemonCapabilities,
) -> Result<ResolvedProvider, HarnessError> {
    vertebrae_harness::resolve_provider(harness, agent_config, &capabilities.provider_profiles)
}

/// The provider ID and harness the daemon reports on execution status
/// updates. When resolution fails (for example an unknown custom provider)
/// the requested provider ID is still reported, with the explicit step
/// harness if any, so the failed execution records what was asked for.
pub fn reported_provider_and_harness(
    harness: Option<StepHarness>,
    agent_config: &AgentConfig,
    capabilities: &DaemonCapabilities,
) -> (ProviderId, Option<StepHarness>) {
    match resolve_provider_from_agent_config(harness, agent_config, capabilities) {
        Ok(resolved) => (resolved.id, Some(resolved.harness)),
        Err(_) => (
            agent_config
                .provider
                .clone()
                .unwrap_or_else(ProviderId::anthropic),
            harness,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_binary_error_includes_harness_and_hint() {
        let error = ProviderResolutionError::MissingProviderBinary {
            harness: StepHarness::Codex,
            hint: "Set CODEX_PATH".into(),
        };
        let rendered = error.to_string();
        assert!(rendered.contains("codex"));
        assert!(rendered.contains("CODEX_PATH"));
    }
}
