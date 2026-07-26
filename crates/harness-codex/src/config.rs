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
