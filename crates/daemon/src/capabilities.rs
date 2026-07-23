//! Immutable capabilities discovered once while the daemon is booting.
//!
//! Discovery is descriptive only. A missing provider is retained as a
//! diagnostic and does not remove that provider from the map or prevent the
//! daemon from starting. The requested step still receives the same provider
//! resolution error when it attempts to use the missing binary.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use vertebrae_core::Provider;
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

/// Immutable daemon-wide discovery results shared by every project and step.
///
/// This snapshot is intentionally not a capability gate. It records what was
/// found at startup; provider selection and per-step error behavior remain
/// unchanged. Installing or updating Claude Code, providers, or skills while
/// the daemon is running takes effect after the next daemon restart.
#[derive(Debug, Clone)]
pub struct DaemonCapabilities {
    /// Provider-keyed harness discovery, including failed discoveries.
    pub harnesses: HashMap<Provider, HarnessCapability>,
    /// The legacy provider map consumed by the shared harness factory.
    pub provider_binaries: ProviderBinaries,
    /// The login-shell PATH captured at startup.
    pub shell_path: String,
    /// Resolved managed skill roots. This remains empty when path resolution
    /// failed; the failure is retained in [`installed_skills_diagnostic`].
    pub installed_skills_roots: Vec<PathBuf>,
    /// Failure resolving the managed skill root, if any.
    pub installed_skills_diagnostic: Option<String>,
    /// The one startup-time Claude compatibility result.
    pub claude_plugin_dir: ClaudePluginDirResolution,
}

impl DaemonCapabilities {
    /// Build the process-lifetime snapshot after shell PATH and provider
    /// discovery have completed.
    pub fn new(
        shell_path: String,
        provider_binaries: ProviderBinaries,
        provider_diagnostics: ProviderDiscoveryDiagnostics,
        working_dir: &Path,
    ) -> Self {
        let installed_skills = vertebrae_installer::installed_skills_dir();
        let (installed_skills_roots, installed_skills_diagnostic) = match installed_skills {
            Ok(path) => (vec![path], None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };

        let harnesses = [
            (
                Provider::Anthropic,
                HarnessCapability {
                    executable: provider_binaries.anthropic.clone(),
                    discovery_diagnostic: provider_diagnostics.anthropic.clone(),
                },
            ),
            (
                Provider::Openai,
                HarnessCapability {
                    executable: provider_binaries.openai.clone(),
                    discovery_diagnostic: provider_diagnostics.openai.clone(),
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
        }
    }

    /// Log the cached compatibility result once during daemon startup.
    pub fn log_startup_diagnostics(&self) {
        for (provider, capability) in &self.harnesses {
            if let Some(diagnostic) = &capability.discovery_diagnostic {
                tracing::warn!(
                    provider = %provider,
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
        );

        assert_eq!(capabilities.harnesses.len(), 2);
        assert_eq!(
            capabilities
                .harnesses
                .get(&Provider::Anthropic)
                .and_then(|capability| capability.discovery_diagnostic.as_deref()),
            Some("Claude Code CLI not found")
        );
        assert!(
            capabilities
                .harnesses
                .get(&Provider::Openai)
                .is_some_and(|capability| capability.executable.is_none())
        );
    }
}
