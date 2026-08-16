//! Configuration for Sacrum client
//!
//! Loads configuration from ~/.config/vertebrae/config.toml (global config).
//!
//! Configuration resolution:
//! - `[sacrum].token` in config file for API token
//! - `[sacrum].url` in config file for base URL (default: https://vertebrae.dev)
//! - `[projects.<name>]` entries matched by CWD longest-prefix (CLI) or by name (GUI)

use crate::error::{SacrumClientError, SacrumClientResult};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Configuration for Sacrum client
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SacrumConfig {
    /// Base URL for Sacrum API (e.g., https://vertebrae.dev)
    pub base_url: String,
    /// API authentication token
    pub api_token: String,
    /// Project ID in Sacrum
    pub project_id: String,
}

/// URL and token after caller-selected configuration precedence has been applied.
///
/// Backend ownership is intentionally absent: environment overrides may change
/// connection values, but never the persisted local/remote mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveSacrumConnection {
    /// Effective Sacrum base URL.
    pub url: String,
    /// Effective API token, when available.
    pub token: Option<String>,
}

impl EffectiveSacrumConnection {
    /// Construct explicitly resolved connection values.
    pub fn new(url: impl Into<String>, token: Option<String>) -> Self {
        Self {
            url: url.into(),
            token,
        }
    }

    /// Use persisted URL/token values without reading the process environment.
    pub fn from_persisted(sacrum: &GlobalSacrumSection) -> Self {
        Self::new(sacrum.url.clone(), sacrum.token.clone())
    }
}

/// Top-level config file structure for ~/.config/vertebrae/config.toml
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct VertebraeConfigFile {
    /// Global sacrum defaults
    #[serde(default)]
    pub sacrum: GlobalSacrumSection,
    /// Per-project configuration keyed by slug
    #[serde(default)]
    pub projects: BTreeMap<String, ProjectSection>,
}

/// Global sacrum settings
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlobalSacrumSection {
    /// Whether Vertebrae connects to a user-managed backend or manages a local stack.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<BackendMode>,
    /// Default Sacrum API URL
    #[serde(default = "default_url")]
    pub url: String,
    /// API token for authentication
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Docker metadata required when `mode = "local"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<LocalBackendSection>,
}

impl Default for GlobalSacrumSection {
    fn default() -> Self {
        Self {
            mode: None,
            url: default_url(),
            token: None,
            local: None,
        }
    }
}

/// Ownership mode for the configured Sacrum backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendMode {
    /// Connect to an existing backend without invoking Docker.
    Remote,
    /// Ensure a Docker stack owned by the local Docker daemon.
    Local,
    /// A future mode retained so older clients can preserve the configuration.
    Unsupported(String),
}

/// Persisted metadata identifying a GUI-managed local backend.
///
/// Fields use defaults so a partially written configuration can be loaded and
/// diagnosed by the startup policy instead of failing TOML deserialization.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalBackendSection {
    /// Docker Compose project name.
    #[serde(default)]
    pub compose_project: String,
    /// Docker volume that owns the PostgreSQL data.
    #[serde(default)]
    pub database_volume: String,
    /// Selected backend image channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<BackendReleaseChannel>,
    /// Current image reference pinned by SHA-256 digest.
    #[serde(default)]
    pub image_ref: String,
    /// Progress of first-run provisioning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisioning_state: Option<LocalProvisioningState>,
    /// Identity of the separately persisted runtime secrets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_secrets: Option<RuntimeSecretsSource>,
}

/// First-run state for a local Sacrum installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalProvisioningState {
    /// The stack has not yet been seeded with the selected local account.
    Pending,
    /// Provisioning is currently being attempted and may be resumed.
    InProgress,
    /// The local account and API token have been created successfully.
    Ready,
    /// Provisioning failed and can be retried with the same persisted secrets.
    Failed,
    /// A future state retained for forward-compatible configuration loading.
    Unsupported(String),
}

/// Valid local backend image channels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendReleaseChannel {
    /// Development builds published through the `backend-master` metadata channel.
    Master,
    /// Stable builds published through the `backend-release` metadata channel.
    Release,
    /// A future channel retained for forward-compatible configuration loading.
    Unsupported(String),
}

impl BackendReleaseChannel {
    /// Component metadata name used to resolve this channel.
    pub fn metadata_name(&self) -> Option<&'static str> {
        match self {
            Self::Master => Some("backend-master"),
            Self::Release => Some("backend-release"),
            Self::Unsupported(_) => None,
        }
    }
}

/// Where Docker runtime secrets are stored.
#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeSecretsSource {
    /// GUI-managed secrets stored outside `config.toml` with owner-only permissions.
    ManagedFile { path: PathBuf },
    /// Secrets embedded in the existing development Compose definition.
    LegacyDevCompose,
    /// A future kind and all of its fields, retained verbatim.
    Unsupported {
        kind: Option<String>,
        fields: BTreeMap<String, toml::Value>,
    },
}

macro_rules! impl_string_lifecycle_serde {
    ($type:ty, $( $variant:path => $value:literal ),+ $(,)?) => {
        impl Serialize for $type {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                match self {
                    $( $variant => serializer.serialize_str($value), )+
                    Self::Unsupported(value) => serializer.serialize_str(value),
                }
            }
        }

        impl<'de> Deserialize<'de> for $type {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Ok(match value.as_str() {
                    $( $value => $variant, )+
                    _ => Self::Unsupported(value),
                })
            }
        }
    };
}

impl_string_lifecycle_serde!(
    BackendMode,
    BackendMode::Remote => "remote",
    BackendMode::Local => "local",
);
impl_string_lifecycle_serde!(
    LocalProvisioningState,
    LocalProvisioningState::Pending => "pending",
    LocalProvisioningState::InProgress => "in_progress",
    LocalProvisioningState::Ready => "ready",
    LocalProvisioningState::Failed => "failed",
);
impl_string_lifecycle_serde!(
    BackendReleaseChannel,
    BackendReleaseChannel::Master => "master",
    BackendReleaseChannel::Release => "release",
);

impl Serialize for RuntimeSecretsSource {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        match self {
            Self::ManagedFile { path } => {
                map.serialize_entry("kind", "managed_file")?;
                map.serialize_entry("path", path)?;
            }
            Self::LegacyDevCompose => {
                map.serialize_entry("kind", "legacy_dev_compose")?;
            }
            Self::Unsupported { kind, fields } => {
                if let Some(kind) = kind {
                    map.serialize_entry("kind", kind)?;
                }
                for (key, value) in fields {
                    map.serialize_entry(key, value)?;
                }
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for RuntimeSecretsSource {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut fields = BTreeMap::<String, toml::Value>::deserialize(deserializer)?;
        let kind = match fields.remove("kind") {
            Some(toml::Value::String(kind)) => Some(kind),
            Some(value) => {
                fields.insert("kind".to_string(), value);
                None
            }
            None => None,
        };

        match kind.as_deref() {
            Some("managed_file") if fields.len() == 1 => {
                let Some(toml::Value::String(path)) = fields.get("path") else {
                    return Ok(Self::Unsupported { kind, fields });
                };
                Ok(Self::ManagedFile {
                    path: PathBuf::from(path.clone()),
                })
            }
            Some("legacy_dev_compose") if fields.is_empty() => Ok(Self::LegacyDevCompose),
            _ => Ok(Self::Unsupported { kind, fields }),
        }
    }
}

/// Per-project configuration
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSection {
    /// Sacrum project ID (UUID)
    #[serde(alias = "project_id")]
    pub id: String,
    /// Git root path for the project
    #[serde(default)]
    pub path: String,
}

fn default_url() -> String {
    "https://vertebrae.dev".to_string()
}

impl SacrumConfig {
    /// Load configuration by matching CWD against project paths in the global config.
    ///
    /// 1. Reads ~/.config/vertebrae/config.toml
    /// 2. Applies env var overrides (`VTB_URL`, `VTB_TOKEN`, `VTB_PROJECT_ID`)
    /// 3. Extracts token from env or config (error if neither is set)
    /// 4. If `VTB_PROJECT_ID` is set, uses it directly; otherwise resolves via CWD
    /// 5. Returns `SacrumConfig { base_url, api_token, project_id }`
    pub fn load() -> SacrumClientResult<Self> {
        let config = load_config_file()?;
        Self::load_from_config(config)
    }

    /// Build a SacrumConfig from a parsed config file, applying env var overrides.
    ///
    /// Env var precedence (highest wins):
    /// - `VTB_URL` overrides `[sacrum].url`
    /// - `VTB_TOKEN` overrides `[sacrum].token`
    /// - `VTB_PROJECT_ID` overrides CWD-based project resolution entirely
    fn load_from_config(config: VertebraeConfigFile) -> SacrumClientResult<Self> {
        let effective = resolve_effective_connection(&config.sacrum);
        let base_url = effective.url;

        let api_token = effective.token.ok_or_else(|| {
                SacrumClientError::ConfigError(
                    "No API token found. Set VTB_TOKEN env var or [sacrum].token in ~/.config/vertebrae/config.toml"
                        .to_string(),
                )
            })?;

        let project_id = match std::env::var("VTB_PROJECT_ID")
            .ok()
            .filter(|v| !v.is_empty())
        {
            Some(id) => id,
            None => {
                let cwd = resolve_project_root()?;
                let (_name, section) = find_project_by_path(&config, &cwd)?;
                section.id.clone()
            }
        };

        Ok(SacrumConfig {
            base_url,
            api_token,
            project_id,
        })
    }

    /// Load configuration for a specific project by name.
    ///
    /// Used by the GUI which doesn't have a meaningful CWD.
    pub fn load_for_project(name: &str) -> SacrumClientResult<Self> {
        let config = load_config_file()?;
        Self::load_for_project_from_config(config, name)
    }

    /// Build a SacrumConfig for a named project from a parsed config file.
    ///
    /// Applies the same `VTB_URL` env var precedence as [`Self::load_from_config`]
    /// (env var, if set and non-empty, wins over `[sacrum].url`).
    fn load_for_project_from_config(
        config: VertebraeConfigFile,
        name: &str,
    ) -> SacrumClientResult<Self> {
        let base_url = resolve_base_url(&config.sacrum.url);

        let api_token = config.sacrum.token.clone().ok_or_else(|| {
            SacrumClientError::ConfigError(
                "No API token found. Set [sacrum].token in ~/.config/vertebrae/config.toml"
                    .to_string(),
            )
        })?;

        let section = config.projects.get(name).ok_or_else(|| {
            SacrumClientError::ConfigError(format!(
                "Project '{}' not found in ~/.config/vertebrae/config.toml",
                name
            ))
        })?;

        Ok(SacrumConfig {
            base_url,
            api_token,
            project_id: section.id.clone(),
        })
    }

    /// Create a new SacrumConfig with explicit values (useful for testing)
    pub fn new(base_url: String, api_token: String, project_id: String) -> Self {
        SacrumConfig {
            base_url,
            api_token,
            project_id,
        }
    }
}

/// Resolve the main repo root for the current working directory.
///
/// Worktree paths do not prefix the main repo path, so configured project paths
/// would never match. `git rev-parse --git-common-dir` returns the main repo's
/// `.git` directory even from a worktree; stripping `/.git` yields the main root.
/// Non-colocated JJ workspaces usually do not expose Git metadata to the working
/// copy, but they can still live under an unrelated ancestor Git repository.
/// In that case Git succeeds with the wrong root, so use JJ's `default`
/// workspace root when it identifies a workspace nested below the Git root.
/// Falls back to the input `cwd` when not in a repo or VCS tools are unavailable.
fn resolve_project_root_at(cwd: &Path) -> PathBuf {
    let git_root = resolve_git_project_root_at(cwd);
    let jj_root = resolve_jj_project_root_at(cwd);

    match (git_root, jj_root) {
        (Some(git_root), Some(jj_root)) if should_prefer_jj_root(&git_root, &jj_root) => jj_root,
        (Some(git_root), _) => git_root,
        (None, Some(jj_root)) => jj_root,
        (None, None) => cwd.to_path_buf(),
    }
}

fn should_prefer_jj_root(git_root: &Path, jj_root: &Path) -> bool {
    jj_root != git_root && jj_root.starts_with(git_root)
}

fn resolve_git_project_root_at(cwd: &Path) -> Option<PathBuf> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(cwd);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(key);
        }
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let git_dir = path_from_command_stdout(&out.stdout)?;
    let root = if git_dir.file_name() == Some(std::ffi::OsStr::new(".git")) {
        git_dir.parent().map(Path::to_path_buf).unwrap_or(git_dir)
    } else {
        git_dir
    };
    Some(root.canonicalize().unwrap_or(root))
}

fn resolve_jj_project_root_at(cwd: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("jj")
        .args([
            "workspace",
            "root",
            "--name",
            "default",
            "--ignore-working-copy",
        ])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    path_from_command_stdout(&out.stdout)
}

fn path_from_command_stdout(stdout: &[u8]) -> Option<PathBuf> {
    let raw = String::from_utf8_lossy(stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let root = PathBuf::from(raw);
    Some(root.canonicalize().unwrap_or(root))
}

/// Resolve the base URL using `VTB_URL` env var precedence.
///
/// When `VTB_URL` is set and non-empty it wins; otherwise the provided
/// config-file value is returned.
fn resolve_base_url(config_url: &str) -> String {
    std::env::var("VTB_URL")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| config_url.to_string())
}

/// Resolve URL/token client values using `VTB_URL` and `VTB_TOKEN` precedence.
///
/// `VTB_PROJECT_ID` remains part of project resolution and is deliberately not
/// represented here. This function never changes backend ownership mode.
pub fn resolve_effective_connection(sacrum: &GlobalSacrumSection) -> EffectiveSacrumConnection {
    EffectiveSacrumConnection {
        url: resolve_base_url(&sacrum.url),
        token: std::env::var("VTB_TOKEN")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| sacrum.token.clone()),
    }
}

fn resolve_project_root() -> SacrumClientResult<PathBuf> {
    let cwd = std::env::current_dir().map_err(|e| {
        SacrumClientError::ConfigError(format!("Failed to get current directory: {}", e))
    })?;
    Ok(resolve_project_root_at(&cwd))
}

/// Find the project whose path is the longest prefix of the given directory.
fn find_project_by_path<'a>(
    config: &'a VertebraeConfigFile,
    cwd: &std::path::Path,
) -> SacrumClientResult<(&'a str, &'a ProjectSection)> {
    let mut best_match: Option<(&str, &ProjectSection, usize)> = None;

    for (name, section) in &config.projects {
        let project_path = std::path::Path::new(&section.path);
        let project_path = project_path
            .canonicalize()
            .unwrap_or_else(|_| project_path.to_path_buf());

        if cwd.starts_with(&project_path) {
            let depth = project_path.components().count();
            if best_match.as_ref().is_none_or(|(_, _, d)| depth > *d) {
                best_match = Some((name, section, depth));
            }
        }
    }

    best_match
        .map(|(name, section, _)| (name, section))
        .ok_or_else(|| {
            SacrumClientError::ConfigError(
                "No vertebrae project found for the current directory.\n\
             Run `vtb init` to register this project, or check ~/.config/vertebrae/config.toml"
                    .to_string(),
            )
        })
}

/// Returns the path to ~/.config/vertebrae/config.toml
pub fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("vertebrae").join("config.toml"))
}

/// Load and parse the global config file. Returns Default if file is missing.
pub fn load_config_file() -> SacrumClientResult<VertebraeConfigFile> {
    let path = config_path().ok_or_else(|| {
        SacrumClientError::ConfigError("Could not determine config directory".to_string())
    })?;

    if !path.exists() {
        return Ok(VertebraeConfigFile::default());
    }

    let content = std::fs::read_to_string(&path).map_err(|e| {
        SacrumClientError::ConfigError(format!(
            "Failed to read config file at {}: {}",
            path.display(),
            e
        ))
    })?;

    let config: VertebraeConfigFile = toml::from_str(&content).map_err(|e| {
        SacrumClientError::ConfigError(format!("Failed to parse config file: {}", e))
    })?;

    Ok(config)
}

/// Serialize and write the global config file. Creates parent directories if needed.
pub fn save_config_file(config: &VertebraeConfigFile) -> SacrumClientResult<()> {
    let path = config_path().ok_or_else(|| {
        SacrumClientError::ConfigError("Could not determine config directory".to_string())
    })?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            SacrumClientError::ConfigError(format!(
                "Failed to create config directory {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    let content = toml::to_string_pretty(config).map_err(|e| {
        SacrumClientError::ConfigError(format!("Failed to serialize config: {}", e))
    })?;

    std::fs::write(&path, content).map_err(|e| {
        SacrumClientError::ConfigError(format!(
            "Failed to write config file at {}: {}",
            path.display(),
            e
        ))
    })?;

    Ok(())
}

/// Register a project in the global config file.
///
/// Inserts or updates the project entry and saves.
pub fn register_project(name: &str, project_id: &str, path: &str) -> SacrumClientResult<()> {
    let mut config = load_config_file()?;
    config.projects.insert(
        name.to_string(),
        ProjectSection {
            id: project_id.to_string(),
            path: path.to_string(),
        },
    );
    save_config_file(&config)
}

/// Remove a project from the global config file.
///
/// Returns true if the project was found and removed, false if not found.
pub fn unregister_project(name: &str) -> SacrumClientResult<bool> {
    let mut config = load_config_file()?;
    let removed = config.projects.remove(name).is_some();
    if removed {
        save_config_file(&config)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{
        BackendConfigField, BackendConfigProblem, BackendSetupIssue, BackendStartupDecision,
        LEGACY_DEV_COMPOSE_PROJECT, LEGACY_DEV_DATABASE_VOLUME, VerifiedLegacyDevStack,
        adopt_legacy_dev_stack, backend_startup_decision,
    };
    use serial_test::serial;

    fn test_digest_image() -> String {
        format!("ghcr.io/camonz/sacrum@sha256:{}", "a".repeat(64))
    }

    #[test]
    fn test_config_creation() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );

        assert_eq!(config.base_url, "http://localhost:4000");
        assert_eq!(config.api_token, "test-token");
        assert_eq!(config.project_id, "test-project");
    }

    #[test]
    fn test_config_with_different_base_urls() {
        let config1 = SacrumConfig::new(
            "http://localhost:3000".to_string(),
            "token".to_string(),
            "proj1".to_string(),
        );
        assert_eq!(config1.base_url, "http://localhost:3000");

        let config2 = SacrumConfig::new(
            "https://api.example.com".to_string(),
            "token".to_string(),
            "proj2".to_string(),
        );
        assert_eq!(config2.base_url, "https://api.example.com");
    }

    #[test]
    fn test_config_with_different_tokens() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token1".to_string(),
            "proj".to_string(),
        );
        assert_eq!(config1.api_token, "token1");

        let config2 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "very-long-token-string-with-special-chars-123".to_string(),
            "proj".to_string(),
        );
        assert_eq!(
            config2.api_token,
            "very-long-token-string-with-special-chars-123"
        );
    }

    #[test]
    fn test_config_with_different_project_ids() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "my-project".to_string(),
        );
        assert_eq!(config1.project_id, "my-project");

        let config2 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "another-project-uuid".to_string(),
        );
        assert_eq!(config2.project_id, "another-project-uuid");
    }

    #[test]
    fn test_find_project_by_path_longest_prefix() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some("test".to_string()),
                ..Default::default()
            },
            projects: BTreeMap::from([
                (
                    "parent".to_string(),
                    ProjectSection {
                        id: "id-parent".to_string(),
                        path: "/home/user/code".to_string(),
                    },
                ),
                (
                    "child".to_string(),
                    ProjectSection {
                        id: "id-child".to_string(),
                        path: "/home/user/code/child-project".to_string(),
                    },
                ),
            ]),
        };

        // CWD inside child-project should match the child (longer prefix)
        let cwd = std::path::Path::new("/home/user/code/child-project/src");
        let (name, section) = find_project_by_path(&config, cwd).unwrap();
        assert_eq!(name, "child");
        assert_eq!(section.id, "id-child");

        // CWD inside parent but not child should match parent
        let cwd = std::path::Path::new("/home/user/code/other-stuff");
        let (name, section) = find_project_by_path(&config, cwd).unwrap();
        assert_eq!(name, "parent");
        assert_eq!(section.id, "id-parent");
    }

    #[test]
    fn test_find_project_by_path_no_match() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection::default(),
            projects: BTreeMap::from([(
                "myproject".to_string(),
                ProjectSection {
                    id: "id1".to_string(),
                    path: "/home/user/code/myproject".to_string(),
                },
            )]),
        };

        let cwd = std::path::Path::new("/tmp/unrelated");
        let result = find_project_by_path(&config, cwd);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("No vertebrae project found")
        );
    }

    #[test]
    fn test_find_project_by_path_exact_match() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection::default(),
            projects: BTreeMap::from([(
                "myproject".to_string(),
                ProjectSection {
                    id: "id1".to_string(),
                    path: "/home/user/code/myproject".to_string(),
                },
            )]),
        };

        let cwd = std::path::Path::new("/home/user/code/myproject");
        let (name, section) = find_project_by_path(&config, cwd).unwrap();
        assert_eq!(name, "myproject");
        assert_eq!(section.id, "id1");
    }

    #[test]
    fn test_load_for_project_missing_token() {
        // This will use the real config path; if no config exists, it defaults
        // and the token will be None, so we should get an error.
        // We can't easily mock the filesystem, so just test the error path.
        let result = SacrumConfig::load_for_project("nonexistent-project-xyz");
        assert!(result.is_err());
    }

    #[test]
    fn test_global_sacrum_section_default() {
        let section = GlobalSacrumSection::default();
        assert_eq!(section.url, "https://vertebrae.dev");
        assert!(section.token.is_none());
    }

    #[test]
    fn test_config_file_deserialize_without_url_uses_production_default() {
        let toml_str = r#"
[sacrum]
token = "sac_mytoken"

[projects.vertebrae]
id = "bb747fd8"
path = "/Users/test/vertebrae"
"#;

        let config: VertebraeConfigFile = toml::from_str(toml_str).unwrap();
        assert_eq!(config.sacrum.url, "https://vertebrae.dev");
        assert_eq!(config.sacrum.token.as_deref(), Some("sac_mytoken"));
    }

    #[test]
    fn test_vertebrae_config_file_roundtrip() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some("sac_test123".to_string()),
                ..Default::default()
            },
            projects: BTreeMap::from([(
                "vertebrae".to_string(),
                ProjectSection {
                    id: "bb747fd8-5395-486f-bc8b-24ccd1615e18".to_string(),
                    path: "/Users/test/code/vertebrae".to_string(),
                },
            )]),
        };

        let serialized = toml::to_string_pretty(&config).unwrap();
        let deserialized: VertebraeConfigFile = toml::from_str(&serialized).unwrap();

        assert_eq!(deserialized.sacrum.url, "http://localhost:4000");
        assert_eq!(deserialized.sacrum.token.as_deref(), Some("sac_test123"));
        assert_eq!(deserialized.projects.len(), 1);
        let project = deserialized.projects.get("vertebrae").unwrap();
        assert_eq!(project.id, "bb747fd8-5395-486f-bc8b-24ccd1615e18");
        assert_eq!(project.path, "/Users/test/code/vertebrae");
    }

    #[test]
    fn explicit_remote_configuration_roundtrip_preserves_projects_and_decision() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                mode: Some(BackendMode::Remote),
                url: "https://sacrum.example.test".to_string(),
                token: Some("sac_remote-token".to_string()),
                local: None,
            },
            projects: BTreeMap::from([(
                "vertebrae".to_string(),
                ProjectSection {
                    id: "project-id".to_string(),
                    path: "/code/vertebrae".to_string(),
                },
            )]),
        };

        let serialized = toml::to_string_pretty(&config).unwrap();
        let reloaded: VertebraeConfigFile = toml::from_str(&serialized).unwrap();

        assert_eq!(reloaded, config);
        let effective = EffectiveSacrumConnection::from_persisted(&reloaded.sacrum);
        assert_eq!(
            backend_startup_decision(&reloaded.sacrum, &effective, None),
            BackendStartupDecision::ConnectRemote
        );
    }

    #[test]
    fn explicit_local_configuration_roundtrip_excludes_runtime_secret_values() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                mode: Some(BackendMode::Local),
                url: "http://localhost:4400".to_string(),
                token: Some("sac_generated-api-token".to_string()),
                local: Some(LocalBackendSection {
                    compose_project: "vertebrae-local".to_string(),
                    database_volume: "vertebrae-local_pgdata".to_string(),
                    channel: Some(BackendReleaseChannel::Release),
                    image_ref: test_digest_image(),
                    provisioning_state: Some(LocalProvisioningState::Ready),
                    runtime_secrets: Some(RuntimeSecretsSource::ManagedFile {
                        path: PathBuf::from("/config/vertebrae/local-backend.env"),
                    }),
                }),
            },
            projects: BTreeMap::from([(
                "existing".to_string(),
                ProjectSection {
                    id: "existing-project-id".to_string(),
                    path: "/code/existing".to_string(),
                },
            )]),
        };

        let serialized = toml::to_string_pretty(&config).unwrap();
        let reloaded: VertebraeConfigFile = toml::from_str(&serialized).unwrap();

        assert_eq!(reloaded, config);
        let effective = EffectiveSacrumConnection::from_persisted(&reloaded.sacrum);
        assert_eq!(
            backend_startup_decision(&reloaded.sacrum, &effective, None),
            BackendStartupDecision::EnsureLocal {
                provisioning_state: LocalProvisioningState::Ready
            }
        );
        let value: toml::Value = toml::from_str(&serialized).unwrap();
        let sacrum = value.get("sacrum").unwrap().as_table().unwrap();
        assert_eq!(
            sacrum.keys().map(String::as_str).collect::<Vec<_>>(),
            ["local", "mode", "token", "url"]
        );
        let local = sacrum.get("local").unwrap().as_table().unwrap();
        assert_eq!(
            local.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "channel",
                "compose_project",
                "database_volume",
                "image_ref",
                "provisioning_state",
                "runtime_secrets",
            ]
        );
        let runtime_secrets = local.get("runtime_secrets").unwrap().as_table().unwrap();
        assert_eq!(
            runtime_secrets
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["kind", "path"]
        );
    }

    #[test]
    fn partial_local_toml_loads_and_reports_missing_runtime_metadata() {
        let config: VertebraeConfigFile = toml::from_str(
            r#"
[sacrum]
mode = "local"
url = "http://localhost:4400"
token = "sac_token"

[sacrum.local]
compose_project = "vertebrae-local"
database_volume = "vertebrae-local_pgdata"
"#,
        )
        .unwrap();

        assert_eq!(
            backend_startup_decision(
                &config.sacrum,
                &EffectiveSacrumConnection::from_persisted(&config.sacrum),
                None
            ),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::InvalidConfiguration {
                mode: BackendMode::Local,
                problems: vec![
                    BackendConfigProblem::Missing(BackendConfigField::Channel),
                    BackendConfigProblem::Missing(BackendConfigField::ImageReference),
                    BackendConfigProblem::Missing(BackendConfigField::ProvisioningState),
                    BackendConfigProblem::Missing(BackendConfigField::RuntimeSecrets),
                ],
            })
        );
    }

    #[test]
    #[serial]
    fn future_lifecycle_values_roundtrip_without_blocking_client_connection_loading() {
        clear_vtb_env_vars();
        let source = format!(
            r#"
[sacrum]
mode = "federated"
url = "https://future.example.test"
token = "sac_future-token"

[sacrum.local]
compose_project = "future-project"
database_volume = "future-volume"
channel = "canary"
image_ref = "{}"
provisioning_state = "paused"

[sacrum.local.runtime_secrets]
kind = "keychain"
service = "vertebrae"
revision = 2

[projects.future]
id = "future-project-id"
path = "/code/future"
"#,
            test_digest_image()
        );
        let config: VertebraeConfigFile = toml::from_str(&source).unwrap();

        assert_eq!(
            config.sacrum.mode,
            Some(BackendMode::Unsupported("federated".to_string()))
        );
        let local = config.sacrum.local.as_ref().unwrap();
        assert_eq!(
            local.channel,
            Some(BackendReleaseChannel::Unsupported("canary".to_string()))
        );
        assert_eq!(
            local.provisioning_state,
            Some(LocalProvisioningState::Unsupported("paused".to_string()))
        );
        assert!(matches!(
            local.runtime_secrets,
            Some(RuntimeSecretsSource::Unsupported {
                kind: Some(ref kind),
                ref fields,
            }) if kind == "keychain"
                && fields.get("service") == Some(&toml::Value::String("vertebrae".to_string()))
                && fields.get("revision") == Some(&toml::Value::Integer(2))
        ));

        let serialized = toml::to_string_pretty(&config).unwrap();
        let reloaded: VertebraeConfigFile = toml::from_str(&serialized).unwrap();
        assert_eq!(reloaded, config);
        let client =
            SacrumConfig::load_for_project_from_config(reloaded.clone(), "future").unwrap();
        assert_eq!(client.base_url, "https://future.example.test");
        assert_eq!(client.api_token, "sac_future-token");
        assert_eq!(client.project_id, "future-project-id");
        assert!(matches!(
            backend_startup_decision(
                &reloaded.sacrum,
                &EffectiveSacrumConnection::from_persisted(&reloaded.sacrum),
                None
            ),
            BackendStartupDecision::SetupRequired(
                BackendSetupIssue::UnsupportedConfiguration { .. }
            )
        ));
        clear_vtb_env_vars();
    }

    #[test]
    fn env_only_legacy_adoption_rejection_survives_config_roundtrip() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                mode: None,
                url: "http://localhost:4400".to_string(),
                token: None,
                local: None,
            },
            projects: BTreeMap::new(),
        };
        let evidence = VerifiedLegacyDevStack::from_authenticated_probe(
            LEGACY_DEV_COMPOSE_PROJECT,
            LEGACY_DEV_DATABASE_VOLUME,
            "http://localhost:4400",
            &test_digest_image(),
            "sac_env-token",
        )
        .unwrap();
        let effective = EffectiveSacrumConnection::new(
            "http://localhost:4400",
            Some("sac_env-token".to_string()),
        );

        let serialized = toml::to_string_pretty(&config).unwrap();
        let reloaded: VertebraeConfigFile = toml::from_str(&serialized).unwrap();
        assert_eq!(reloaded, config);
        assert_eq!(
            backend_startup_decision(&reloaded.sacrum, &effective, Some(&evidence)),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::LegacyAdoptionUnavailable {
                problems: vec![BackendConfigProblem::Missing(BackendConfigField::Token)]
            })
        );
        assert_eq!(reloaded.sacrum.mode, None);
        assert_eq!(reloaded.sacrum.local, None);
    }

    #[test]
    fn confirmed_legacy_adoption_roundtrip_preserves_connection_stack_and_projects() {
        let mut config: VertebraeConfigFile = toml::from_str(
            r#"
[sacrum]
url = "http://localhost:4400"
token = "sac_existing-token"

[projects.existing]
id = "existing-project-id"
path = "/code/existing"
"#,
        )
        .unwrap();
        let evidence = VerifiedLegacyDevStack::from_authenticated_probe(
            LEGACY_DEV_COMPOSE_PROJECT,
            LEGACY_DEV_DATABASE_VOLUME,
            "http://localhost:4400",
            &test_digest_image(),
            "sac_existing-token",
        )
        .unwrap();

        let effective = EffectiveSacrumConnection::from_persisted(&config.sacrum);
        adopt_legacy_dev_stack(&mut config.sacrum, &effective, &evidence, true).unwrap();
        let serialized = toml::to_string_pretty(&config).unwrap();
        let reloaded: VertebraeConfigFile = toml::from_str(&serialized).unwrap();

        assert_eq!(reloaded, config);
        assert_eq!(reloaded.sacrum.url, "http://localhost:4400");
        assert_eq!(reloaded.sacrum.token.as_deref(), Some("sac_existing-token"));
        assert_eq!(
            reloaded.projects.get("existing"),
            Some(&ProjectSection {
                id: "existing-project-id".to_string(),
                path: "/code/existing".to_string(),
            })
        );
        let local = reloaded.sacrum.local.as_ref().unwrap();
        assert_eq!(local.compose_project, LEGACY_DEV_COMPOSE_PROJECT);
        assert_eq!(local.database_volume, LEGACY_DEV_DATABASE_VOLUME);
        let effective = EffectiveSacrumConnection::from_persisted(&reloaded.sacrum);
        assert_eq!(
            backend_startup_decision(&reloaded.sacrum, &effective, None),
            BackendStartupDecision::EnsureLocal {
                provisioning_state: LocalProvisioningState::Ready
            }
        );
    }

    #[test]
    fn test_config_file_deserialize_without_token() {
        let toml_str = r#"
[sacrum]
url = "http://localhost:4000"

[projects.myproject]
id = "abc123"
path = "/tmp/myproject"
"#;

        let config: VertebraeConfigFile = toml::from_str(toml_str).unwrap();
        assert!(config.sacrum.token.is_none());
        assert_eq!(config.sacrum.url, "http://localhost:4000");
        assert_eq!(config.projects.len(), 1);
    }

    #[test]
    fn test_config_file_deserialize_with_token() {
        let toml_str = r#"
[sacrum]
url = "http://localhost:4000"
token = "sac_mytoken"

[projects.vertebrae]
id = "bb747fd8"
path = "/Users/test/vertebrae"

[projects.other]
id = "other-id"
path = "/Users/test/other"
"#;

        let config: VertebraeConfigFile = toml::from_str(toml_str).unwrap();
        assert_eq!(config.sacrum.token.as_deref(), Some("sac_mytoken"));
        assert_eq!(config.projects.len(), 2);
    }

    /// Helper: build a VertebraeConfigFile with a token and a project whose path
    /// matches the resolved project root so CWD-based resolution succeeds.
    fn config_with_cwd_project() -> VertebraeConfigFile {
        let cwd = resolve_project_root()
            .unwrap()
            .to_string_lossy()
            .to_string();

        VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://file-url:4000".to_string(),
                token: Some("file-token".to_string()),
                ..Default::default()
            },
            projects: BTreeMap::from([(
                "testproject".to_string(),
                ProjectSection {
                    id: "file-project-id".to_string(),
                    path: cwd,
                },
            )]),
        }
    }

    /// Helper: clean up all VTB_ env vars to ensure a pristine state.
    fn clear_vtb_env_vars() {
        unsafe {
            std::env::remove_var("VTB_URL");
            std::env::remove_var("VTB_TOKEN");
            std::env::remove_var("VTB_PROJECT_ID");
        }
    }

    #[test]
    #[serial]
    fn test_load_from_config_without_env_vars_uses_file_values() {
        clear_vtb_env_vars();
        let config = config_with_cwd_project();
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.base_url, "http://file-url:4000");
        assert_eq!(result.api_token, "file-token");
        assert_eq!(result.project_id, "file-project-id");
    }

    #[test]
    #[serial]
    fn test_vtb_url_overrides_config_file_url() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_URL", "http://env-url:9999");
        }
        let config = config_with_cwd_project();
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.base_url, "http://env-url:9999");
        assert_eq!(result.api_token, "file-token");
        assert_eq!(result.project_id, "file-project-id");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn test_vtb_token_overrides_config_file_token() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_TOKEN", "env-token");
        }
        let config = config_with_cwd_project();
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.base_url, "http://file-url:4000");
        assert_eq!(result.api_token, "env-token");
        assert_eq!(result.project_id, "file-project-id");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn test_vtb_project_id_overrides_cwd_resolution() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_PROJECT_ID", "env-project-id");
        }
        let config = config_with_cwd_project();
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.base_url, "http://file-url:4000");
        assert_eq!(result.api_token, "file-token");
        assert_eq!(result.project_id, "env-project-id");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn test_vtb_project_id_skips_cwd_lookup_entirely() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_PROJECT_ID", "env-project-id");
        }
        // Config has no projects at all -- CWD lookup would fail without the env var
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some("some-token".to_string()),
                ..Default::default()
            },
            projects: BTreeMap::new(),
        };
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.project_id, "env-project-id");
        assert_eq!(result.api_token, "some-token");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn test_vtb_token_relaxes_config_file_token_requirement() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_TOKEN", "env-token");
            std::env::set_var("VTB_PROJECT_ID", "env-project-id");
        }
        // Config has no token -- would normally error
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: None,
                ..Default::default()
            },
            projects: BTreeMap::new(),
        };
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.api_token, "env-token");
        assert_eq!(result.project_id, "env-project-id");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn test_all_env_vars_override_all_config_values() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_URL", "http://env-url:8080");
            std::env::set_var("VTB_TOKEN", "env-token-all");
            std::env::set_var("VTB_PROJECT_ID", "env-project-all");
        }
        let config = config_with_cwd_project();
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.base_url, "http://env-url:8080");
        assert_eq!(result.api_token, "env-token-all");
        assert_eq!(result.project_id, "env-project-all");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn env_overrides_client_connection_without_changing_backend_ownership_policy() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_URL", "http://127.0.0.1:4400");
            std::env::set_var("VTB_TOKEN", "env-token");
            std::env::set_var("VTB_PROJECT_ID", "env-project-id");
        }
        let mut config = config_with_cwd_project();
        config.sacrum.mode = Some(BackendMode::Local);
        config.sacrum.token = None;
        config.sacrum.local = Some(LocalBackendSection {
            compose_project: "vertebrae-local".to_string(),
            database_volume: "vertebrae-local_pgdata".to_string(),
            channel: Some(BackendReleaseChannel::Release),
            image_ref: test_digest_image(),
            provisioning_state: Some(LocalProvisioningState::Ready),
            runtime_secrets: Some(RuntimeSecretsSource::ManagedFile {
                path: PathBuf::from("/config/vertebrae/local-backend.env"),
            }),
        });

        let effective = resolve_effective_connection(&config.sacrum);
        assert_eq!(effective.url, "http://127.0.0.1:4400");
        assert_eq!(effective.token.as_deref(), Some("env-token"));
        assert_eq!(
            backend_startup_decision(&config.sacrum, &effective, None),
            BackendStartupDecision::EnsureLocal {
                provisioning_state: LocalProvisioningState::Ready
            }
        );
        assert_eq!(config.sacrum.mode, Some(BackendMode::Local));
        assert!(config.sacrum.token.is_none());
        let client = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(client.base_url, "http://127.0.0.1:4400");
        assert_eq!(client.api_token, "env-token");
        assert_eq!(client.project_id, "env-project-id");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn test_empty_env_vars_are_ignored() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_URL", "");
            std::env::set_var("VTB_TOKEN", "");
            std::env::set_var("VTB_PROJECT_ID", "");
        }
        let config = config_with_cwd_project();
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.base_url, "http://file-url:4000");
        assert_eq!(result.api_token, "file-token");
        assert_eq!(result.project_id, "file-project-id");
        clear_vtb_env_vars();
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let mut cmd = std::process::Command::new("git");
        cmd.args(args).current_dir(repo);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                cmd.env_remove(key);
            }
        }
        let status = cmd.status().unwrap();
        assert!(status.success(), "git {:?} failed", args);
    }

    fn jj_available() -> bool {
        std::process::Command::new("jj")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    }

    fn run_jj(repo: &Path, args: &[&str]) {
        let output = std::process::Command::new("jj")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "jj {:?} failed in {:?}: stdout={} stderr={}",
            args,
            repo,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    struct CurrentDirGuard {
        original: PathBuf,
    }

    impl CurrentDirGuard {
        fn push(path: &Path) -> Self {
            let original = std::env::current_dir().unwrap();
            std::env::set_current_dir(path).unwrap();
            Self { original }
        }
    }

    impl Drop for CurrentDirGuard {
        fn drop(&mut self) {
            std::env::set_current_dir(&self.original).unwrap();
        }
    }

    #[test]
    fn test_resolve_project_root_in_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().canonicalize().unwrap();
        run_git(&repo, &["init", "-q"]);

        let subdir = repo.join("src");
        std::fs::create_dir_all(&subdir).unwrap();

        assert_eq!(resolve_project_root_at(&subdir), repo);
    }

    #[test]
    fn test_resolve_project_root_in_worktree_returns_main_repo_root() {
        let tmp = tempfile::tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        std::fs::create_dir_all(&main_repo).unwrap();
        let main_repo = main_repo.canonicalize().unwrap();

        run_git(&main_repo, &["init", "-q", "-b", "main"]);
        run_git(&main_repo, &["config", "user.email", "test@example.com"]);
        run_git(&main_repo, &["config", "user.name", "Test"]);
        std::fs::write(main_repo.join("README.md"), "init").unwrap();
        run_git(&main_repo, &["add", "."]);
        run_git(&main_repo, &["commit", "-q", "-m", "init"]);

        let worktree_path = tmp.path().join("wt");
        run_git(
            &main_repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                worktree_path.to_str().unwrap(),
            ],
        );
        let worktree_path = worktree_path.canonicalize().unwrap();

        assert_eq!(resolve_project_root_at(&worktree_path), main_repo);
    }

    #[test]
    fn test_resolve_project_root_in_colocated_jj_workspace_uses_git_root() {
        if !jj_available() {
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();

        run_jj(&repo, &["git", "init", "--colocate"]);

        let subdir = repo.join("src");
        std::fs::create_dir_all(&subdir).unwrap();

        assert_eq!(resolve_git_project_root_at(&subdir), Some(repo.clone()));
        assert_eq!(resolve_project_root_at(&subdir), repo);
    }

    #[test]
    fn test_resolve_project_root_in_non_colocated_jj_workspace_uses_jj_root() {
        if !jj_available() {
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();

        run_jj(&repo, &["git", "init", "--no-colocate"]);

        let subdir = repo.join("src");
        std::fs::create_dir_all(&subdir).unwrap();

        assert_eq!(resolve_git_project_root_at(&subdir), None);
        assert_eq!(resolve_project_root_at(&subdir), repo);
    }

    #[test]
    fn test_resolve_project_root_in_non_colocated_jj_workspace_under_ancestor_git_uses_default_jj_root()
     {
        if !jj_available() {
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let outer_repo = tmp.path().join("outer");
        std::fs::create_dir_all(&outer_repo).unwrap();
        let outer_repo = outer_repo.canonicalize().unwrap();
        run_git(&outer_repo, &["init", "-q"]);

        let workspace = outer_repo.join("jj-workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        run_jj(&workspace, &["git", "init", "--no-colocate"]);

        let subdir = workspace.join("nested");
        std::fs::create_dir_all(&subdir).unwrap();

        assert_eq!(resolve_git_project_root_at(&subdir), Some(outer_repo));
        assert_eq!(resolve_jj_project_root_at(&subdir), Some(workspace.clone()));
        assert_eq!(resolve_project_root_at(&subdir), workspace);
    }

    #[test]
    fn test_resolve_project_root_in_secondary_jj_workspace_under_ancestor_git_uses_default_workspace_root()
     {
        if !jj_available() {
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let outer_repo = tmp.path().join("outer");
        std::fs::create_dir_all(&outer_repo).unwrap();
        let outer_repo = outer_repo.canonicalize().unwrap();
        run_git(&outer_repo, &["init", "-q"]);

        let default_workspace = outer_repo.join("repo");
        std::fs::create_dir_all(&default_workspace).unwrap();
        let default_workspace = default_workspace.canonicalize().unwrap();

        run_jj(&default_workspace, &["git", "init", "--no-colocate"]);

        let secondary_workspace = outer_repo.join("repo-984cd381");
        run_jj(
            &default_workspace,
            &[
                "workspace",
                "add",
                "--name",
                "task-984cd381",
                secondary_workspace.to_str().unwrap(),
            ],
        );
        let secondary_workspace = secondary_workspace.canonicalize().unwrap();

        let subdir = secondary_workspace.join("nested");
        std::fs::create_dir_all(&subdir).unwrap();

        assert_eq!(resolve_git_project_root_at(&subdir), Some(outer_repo));
        assert_eq!(
            resolve_jj_project_root_at(&subdir),
            Some(default_workspace.clone())
        );
        assert_eq!(resolve_project_root_at(&subdir), default_workspace);
    }

    #[test]
    fn test_resolve_project_root_outside_repo_falls_back_to_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().canonicalize().unwrap();

        assert_eq!(resolve_project_root_at(&dir), dir);
    }

    #[test]
    #[serial]
    fn test_load_from_config_resolves_non_colocated_jj_workspace_without_project_env() {
        if !jj_available() {
            return;
        }
        clear_vtb_env_vars();

        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();

        run_jj(&repo, &["git", "init", "--no-colocate"]);

        let subdir = repo.join("nested");
        std::fs::create_dir_all(&subdir).unwrap();

        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://file-url:4000".to_string(),
                token: Some("file-token".to_string()),
                ..Default::default()
            },
            projects: BTreeMap::from([(
                "jj-project".to_string(),
                ProjectSection {
                    id: "jj-project-id".to_string(),
                    path: repo.to_string_lossy().to_string(),
                },
            )]),
        };

        let _cwd = CurrentDirGuard::push(&subdir);
        let result = SacrumConfig::load_from_config(config).unwrap();

        assert_eq!(result.base_url, "http://file-url:4000");
        assert_eq!(result.api_token, "file-token");
        assert_eq!(result.project_id, "jj-project-id");
        clear_vtb_env_vars();
    }

    /// Helper: build a VertebraeConfigFile for `load_for_project` tests with a
    /// named project entry. The project path is not used by `load_for_project`,
    /// so we can hardcode it.
    fn config_for_named_project() -> VertebraeConfigFile {
        VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://file-url:4000".to_string(),
                token: Some("file-token".to_string()),
                ..Default::default()
            },
            projects: BTreeMap::from([(
                "myproject".to_string(),
                ProjectSection {
                    id: "named-project-id".to_string(),
                    path: "/some/path".to_string(),
                },
            )]),
        }
    }

    #[test]
    #[serial]
    fn test_load_for_project_uses_config_url_when_env_unset() {
        clear_vtb_env_vars();
        let config = config_for_named_project();
        let result = SacrumConfig::load_for_project_from_config(config, "myproject").unwrap();

        assert_eq!(result.base_url, "http://file-url:4000");
        assert_eq!(result.api_token, "file-token");
        assert_eq!(result.project_id, "named-project-id");
    }

    #[test]
    #[serial]
    fn test_load_for_project_vtb_url_env_var_overrides_config() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_URL", "http://env-override:7777");
        }
        let config = config_for_named_project();
        let result = SacrumConfig::load_for_project_from_config(config, "myproject").unwrap();

        assert_eq!(result.base_url, "http://env-override:7777");
        assert_eq!(result.api_token, "file-token");
        assert_eq!(result.project_id, "named-project-id");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn test_load_for_project_empty_vtb_url_falls_back_to_config() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_URL", "");
        }
        let config = config_for_named_project();
        let result = SacrumConfig::load_for_project_from_config(config, "myproject").unwrap();

        assert_eq!(result.base_url, "http://file-url:4000");
        assert_eq!(result.api_token, "file-token");
        assert_eq!(result.project_id, "named-project-id");
        clear_vtb_env_vars();
    }

    #[test]
    #[serial]
    fn test_missing_token_in_both_env_and_config_errors() {
        clear_vtb_env_vars();
        unsafe {
            std::env::set_var("VTB_PROJECT_ID", "env-project-id");
        }
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: None,
                ..Default::default()
            },
            projects: BTreeMap::new(),
        };
        let result = SacrumConfig::load_from_config(config);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("No API token found"),
            "Expected error about missing token, got: {}",
            err_msg
        );
        clear_vtb_env_vars();
    }
}
