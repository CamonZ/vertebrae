use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vertebrae_harness_core::{HarnessCapabilities, HarnessError, RequestConfig};

use crate::CodexAppServerLauncher;

/// Codex-only permission and sandbox parameters. The provider adapter owns
/// their wire representation; surfaces choose the policy without adding it to
/// the provider-neutral request contract.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CodexPermissionConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_rules: Option<Value>,
}

impl CodexPermissionConfig {
    pub fn apply_to_params(&self, params: &mut Value) {
        if let Some(value) = &self.approval_policy {
            params["approvalPolicy"] = json!(value);
        }
        if let Some(value) = &self.approvals_reviewer {
            params["approvalsReviewer"] = json!(value);
        }
        if let Some(value) = &self.permissions {
            params["permissions"] = json!(value);
        }
        if let Some(value) = &self.sandbox_policy {
            params["sandboxPolicy"] = value.clone();
        }
        if let Some(value) = &self.prefix_rules {
            params["prefixRules"] = value.clone();
        }
    }
}

/// Environment variable the adapter exports a custom provider's resolved
/// credential under; the generated `model_providers.<id>.env_key` names it.
pub const CODEX_CUSTOM_PROVIDER_API_KEY_ENV: &str = "VERTEBRAE_MODEL_PROVIDER_API_KEY";

/// A custom Codex model provider declared outside `~/.codex/config.toml`.
/// The adapter translates it into `-c model_providers.<id>.*` launch
/// overrides plus `modelProvider=<id>` on thread start.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct CodexCustomModelProvider {
    /// Provider ID used as the `model_providers` key and `modelProvider`.
    pub id: String,
    pub base_url: Option<String>,
    /// Resolved credential, exported under
    /// [`CODEX_CUSTOM_PROVIDER_API_KEY_ENV`]. `None` sends no credential.
    pub api_key: Option<String>,
    /// Codex wire API (`chat` or `responses`).
    pub wire_api: Option<String>,
    /// Additional launch environment for the App Server process.
    pub environment: BTreeMap<String, String>,
}

impl CodexCustomModelProvider {
    /// `-c` overrides defining this provider for one App Server launch.
    pub fn config_overrides(&self) -> Vec<String> {
        let key = format!("model_providers.{}", self.id);
        let mut entries = vec![("name", self.id.clone())];
        if let Some(base_url) = &self.base_url {
            entries.push(("base_url", base_url.clone()));
        }
        if self.api_key.is_some() {
            entries.push(("env_key", CODEX_CUSTOM_PROVIDER_API_KEY_ENV.to_string()));
        }
        if let Some(wire_api) = &self.wire_api {
            entries.push(("wire_api", wire_api.clone()));
        }
        entries
            .into_iter()
            .flat_map(|(field, value)| {
                // A JSON string literal is a valid TOML basic string, so the
                // value is never reinterpreted by Codex's TOML override parser.
                let value = Value::String(value).to_string();
                ["-c".to_string(), format!("{key}.{field}={value}")]
            })
            .collect()
    }

    pub fn launch_environment(&self) -> BTreeMap<String, String> {
        let mut environment = self.environment.clone();
        if let Some(api_key) = &self.api_key {
            environment.insert(CODEX_CUSTOM_PROVIDER_API_KEY_ENV.into(), api_key.clone());
        }
        environment
    }
}

impl std::fmt::Debug for CodexCustomModelProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodexCustomModelProvider")
            .field("id", &self.id)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("wire_api", &self.wire_api)
            .field("environment", &self.environment.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// Construction policy for the Codex App Server adapter.
#[derive(Clone)]
pub struct CodexProviderConfig {
    pub executable: Option<PathBuf>,
    pub executable_environment_key: String,
    pub search_path: Option<OsString>,
    pub environment: BTreeMap<String, String>,
    pub extra_args: Vec<String>,
    pub client_name: String,
    pub client_title: String,
    pub client_version: String,
    pub model_provider: Option<String>,
    /// Custom provider defined for this launch; takes precedence over
    /// `model_provider` for thread start.
    pub custom_model_provider: Option<CodexCustomModelProvider>,
    pub permission: CodexPermissionConfig,
    pub installed_skills_roots: Vec<PathBuf>,
    pub cleanup_timeout: Duration,
    pub readiness_timeout: Duration,
    /// Maximum wait for an App Server request/response round trip once the
    /// connection is ready.
    pub request_timeout: Duration,
    pub terminal_exit_timeout: Duration,
    pub launch_attempts: usize,
    pub launcher: Option<Arc<dyn CodexAppServerLauncher>>,
}

impl std::fmt::Debug for CodexProviderConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodexProviderConfig")
            .field("executable", &self.executable)
            .field(
                "executable_environment_key",
                &self.executable_environment_key,
            )
            .field("search_path", &self.search_path)
            .field("environment", &self.environment)
            .field("extra_args", &self.extra_args)
            .field("client_name", &self.client_name)
            .field("client_title", &self.client_title)
            .field("client_version", &self.client_version)
            .field("model_provider", &self.model_provider)
            .field("custom_model_provider", &self.custom_model_provider)
            .field("permission", &self.permission)
            .field("installed_skills_roots", &self.installed_skills_roots)
            .field("cleanup_timeout", &self.cleanup_timeout)
            .field("readiness_timeout", &self.readiness_timeout)
            .field("request_timeout", &self.request_timeout)
            .field("terminal_exit_timeout", &self.terminal_exit_timeout)
            .field("launch_attempts", &self.launch_attempts)
            .field("launcher", &self.launcher.as_ref().map(|_| "configured"))
            .finish()
    }
}

impl Default for CodexProviderConfig {
    fn default() -> Self {
        Self {
            executable: None,
            executable_environment_key: "CODEX_PATH".into(),
            search_path: env::var_os("PATH"),
            environment: BTreeMap::new(),
            extra_args: Vec::new(),
            client_name: "vertebrae".into(),
            client_title: "Vertebrae".into(),
            client_version: env!("CARGO_PKG_VERSION").into(),
            model_provider: None,
            custom_model_provider: None,
            permission: CodexPermissionConfig::default(),
            installed_skills_roots: Vec::new(),
            cleanup_timeout: Duration::from_secs(3),
            readiness_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(30),
            terminal_exit_timeout: Duration::from_millis(250),
            launch_attempts: 3,
            launcher: None,
        }
    }
}

impl CodexProviderConfig {
    /// The `modelProvider` sent on thread start.
    pub fn effective_model_provider(&self) -> Option<&str> {
        self.custom_model_provider
            .as_ref()
            .map(|provider| provider.id.as_str())
            .or(self.model_provider.as_deref())
    }

    pub async fn discover_capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        crate::models::discover_capabilities(self).await
    }

    pub fn resolve_executable(&self) -> Result<PathBuf, HarnessError> {
        if let Some(path) = &self.executable {
            return validate_executable(path);
        }
        if let Some(path) = self
            .environment
            .get(&self.executable_environment_key)
            .map(PathBuf::from)
            .or_else(|| env::var_os(&self.executable_environment_key).map(PathBuf::from))
        {
            return validate_executable(&path);
        }
        for directory in env::split_paths(self.search_path.as_deref().unwrap_or_default()) {
            let candidate = directory.join(executable_name());
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(HarnessError::Unavailable(format!(
            "Codex executable was not found; set {} or install codex in PATH",
            self.executable_environment_key
        )))
    }

    pub fn validate_request(&self, request: &RequestConfig) -> Result<(), HarnessError> {
        if let Some(directory) = &request.working_directory
            && !directory.is_dir()
        {
            return Err(HarnessError::InvalidRequest(format!(
                "working directory is not a directory: {}",
                directory.display()
            )));
        }
        if let Some(personality) = request.personality.as_deref()
            && !matches!(personality, "none" | "friendly" | "pragmatic")
        {
            return Err(HarnessError::InvalidRequest(format!(
                "personality '{}' is not supported by Codex; supported values are none, friendly, and pragmatic",
                personality
            )));
        }
        Ok(())
    }
}

fn validate_executable(path: &Path) -> Result<PathBuf, HarnessError> {
    if path.is_file() {
        Ok(path.to_path_buf())
    } else {
        Err(HarnessError::Unavailable(format!(
            "Codex executable does not exist: {}",
            path.display()
        )))
    }
}

#[cfg(windows)]
fn executable_name() -> &'static str {
    "codex.exe"
}

#[cfg(not(windows))]
fn executable_name() -> &'static str {
    "codex"
}
