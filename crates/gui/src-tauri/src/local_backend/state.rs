use serde::{Deserialize, Serialize};
use std::fmt;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroize;

const COMPOSE_ASSET: &str = include_str!("assets/compose.yaml");
const SEED_ASSET: &str = include_str!("assets/seed.exs");
pub(crate) const LEGACY_PROJECT: &str = "vertebrae-dev";
pub(crate) const LEGACY_VOLUME: &str = "vertebrae-dev_pgdata";
pub(crate) const FRESH_POSTGRES_IMAGE: &str = "postgres:18-alpine";
pub(crate) const LEGACY_POSTGRES_IMAGE: &str = "postgres:17-alpine";
pub(crate) const LOCAL_SACRUM_IMAGE_REF: &str =
    "ghcr.io/camonz/sacrum@sha256:9a028d0d22543762644149ef1f3042706af7f5ab38f6b3df287f1a82bd495f6f";
const LEGACY_POSTGRES_PASSWORD: &str = "postgres";
const LEGACY_SECRET_KEY_BASE: &str =
    "dev-secret-key-base-that-is-at-least-64-bytes-long-for-phoenix-app";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalBackendDiagnostic {
    pub code: String,
    pub retryable: bool,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum LocalBackendError {
    #[error("Could not determine the Vertebrae application-data directory: {0}")]
    DataDirectory(String),
    #[error("Could not {action} {path}: {source}")]
    FileSystem {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Managed local backend state is invalid: {0}")]
    InvalidState(String),
    #[error("Could not generate local backend secrets: {0}")]
    SecretGeneration(String),
    #[error("Docker CLI was not found; searched {searched}")]
    DockerCliNotFound { searched: String },
    #[error("Docker daemon is unreachable: {0}")]
    DockerDaemonUnreachable(String),
    #[error("Permission to access the Docker daemon was denied: {0}")]
    DockerDaemonPermissionDenied(String),
    #[error("Docker context '{name}' uses unsupported endpoint '{endpoint}'")]
    UnsupportedDockerContext { name: String, endpoint: String },
    #[error("Docker context changed from '{expected_name}' ({expected_endpoint}) to '{actual_name}' ({actual_endpoint})")]
    DockerContextChanged {
        expected_name: String,
        expected_endpoint: String,
        actual_name: String,
        actual_endpoint: String,
    },
    #[error("Docker Compose is unavailable: {0}")]
    ComposeUnavailable(String),
    #[error("Docker Engine {found} cannot safely publish a loopback-only port; version {minimum}+ is required")]
    UnsupportedEngineVersion { found: String, minimum: u64 },
    #[error("Persistent database volume '{volume}' is unavailable: {reason}")]
    PersistentVolumeUnavailable { volume: String, reason: String },
    #[error("Local backend port {port} is unavailable: {output}")]
    PortUnavailable { port: u16, output: String },
    #[error("Docker command '{action}' failed with status {status}: {output}")]
    CommandFailed {
        action: String,
        status: String,
        output: String,
    },
    #[error("Docker command '{action}' timed out after {timeout_seconds} seconds: {output}")]
    CommandTimedOut {
        action: String,
        timeout_seconds: u64,
        output: String,
    },
    #[error("Sacrum did not become healthy at {url} within {timeout_seconds} seconds: {logs}")]
    HealthTimedOut {
        url: String,
        timeout_seconds: u64,
        logs: String,
    },
    #[error("The vertebrae-dev stack cannot be adopted safely: {0}")]
    UnsafeLegacyStack(String),
    #[error("Adopting the vertebrae-dev stack requires explicit confirmation")]
    AdoptionNotConfirmed,
    #[error("The preserved vertebrae-dev volume requires its prior host port")]
    LegacyHostPortRequired,
}

impl LocalBackendError {
    /// Build a stable, redacted diagnostic for GUI display.
    pub fn diagnostic(&self) -> LocalBackendDiagnostic {
        let detail = redact_diagnostic_detail(&self.to_string());
        let (code, retryable, hint) = match self {
            Self::DataDirectory(_) | Self::FileSystem { .. } => (
                "local_setup_persistence",
                true,
                "Vertebrae could not persist local setup data. Check the application-data directory permissions and available disk space, then retry.",
            ),
            Self::SecretGeneration(_) => (
                "secure_randomness",
                true,
                "The operating system did not provide secure randomness. Retry local setup after checking the system entropy source.",
            ),
            Self::DockerCliNotFound { .. } => (
                "docker_unavailable",
                false,
                "Docker was not found. Install Docker Desktop or Docker Engine, start it, and retry local setup.",
            ),
            Self::DockerDaemonUnreachable(_) => (
                "docker_daemon_unreachable",
                true,
                "Docker is not reachable. Start Docker and verify that the selected local context is running, then retry.",
            ),
            Self::DockerDaemonPermissionDenied(_) => (
                "docker_permission_denied",
                false,
                "The current user cannot access Docker. Fix Docker socket permissions or membership, then retry local setup.",
            ),
            Self::UnsupportedDockerContext { .. } | Self::DockerContextChanged { .. } => (
                "docker_context_invalid",
                true,
                "The selected Docker context is not a supported local endpoint. Select a running local Docker context and retry.",
            ),
            Self::ComposeUnavailable(_) => (
                "docker_compose_unavailable",
                false,
                "Docker Compose is unavailable. Install or enable the Docker Compose plugin, then retry local setup.",
            ),
            Self::UnsupportedEngineVersion { .. } => (
                "docker_engine_unsupported",
                false,
                "The Docker Engine is too old for safe loopback publishing. Upgrade Docker and retry local setup.",
            ),
            Self::PersistentVolumeUnavailable { .. } => (
                "persistent_volume_unavailable",
                false,
                "The existing database volume is unavailable or has unexpected metadata. Restore the named volume or correct the Docker context; Vertebrae will not delete or recreate it automatically.",
            ),
            Self::PortUnavailable { .. } => (
                "local_port_unavailable",
                true,
                "The local Sacrum port is already in use. Stop the conflicting process or choose another local port, then retry.",
            ),
            Self::HealthTimedOut { logs, .. } => {
                let hint = if logs.to_ascii_lowercase().contains("postgres") {
                    "PostgreSQL or Sacrum did not become ready. Review the redacted service details, confirm Docker has enough resources, and retry; existing data is preserved."
                } else {
                    "Sacrum did not become healthy. Review the redacted service details, confirm Docker has enough resources, and retry; existing data is preserved."
                };
                ("sacrum_health_timeout", true, hint)
            }
            Self::CommandFailed { action, output, .. }
            | Self::CommandTimedOut { action, output, .. } => {
                classify_command_failure(action, output)
            }
            Self::InvalidState(_) => (
                "local_setup_state_invalid",
                false,
                "Local backend setup state is invalid. Do not remove the database volume; inspect the redacted setup error and repair the reported file or context before retrying.",
            ),
            Self::UnsafeLegacyStack(_) => (
                "legacy_stack_unsafe",
                false,
                "The existing vertebrae-dev stack does not match the supported development layout. It was left untouched; inspect it before choosing adoption.",
            ),
            Self::AdoptionNotConfirmed => (
                "legacy_adoption_not_confirmed",
                false,
                "Adopting the existing development stack requires explicit confirmation.",
            ),
            Self::LegacyHostPortRequired => (
                "legacy_host_port_required",
                false,
                "The preserved development volume requires its existing host port. Provide that port to adopt the stack without changing its data.",
            ),
        };

        LocalBackendDiagnostic {
            code: code.to_string(),
            retryable,
            message: format!("{hint} Details: {detail}"),
        }
    }

    pub fn actionable_message(&self) -> String {
        self.diagnostic().message
    }
}

fn classify_command_failure(action: &str, output: &str) -> (&'static str, bool, &'static str) {
    let normalized = format!("{action} {output}").to_ascii_lowercase();
    if normalized.contains("seed") {
        return (
            "seeder_failed",
            true,
            "The local account seeder failed. The stack and database were preserved; correct the reported account or backend issue and retry with the same account details.",
        );
    }
    if port_conflict(output) {
        return (
            "local_port_unavailable",
            true,
            "The local Sacrum port is already in use. Stop the conflicting process or choose another local port, then retry.",
        );
    }
    if normalized.contains("pull")
        || normalized.contains("manifest unknown")
        || normalized.contains("unauthorized")
    {
        return (
            "sacrum_image_unavailable",
            true,
            "Docker could not pull the pinned Sacrum image. Check network access and registry authentication, then retry without deleting the database volume.",
        );
    }
    if normalized.contains("migrat") {
        return (
            "sacrum_migration_failed",
            true,
            "Sacrum migrations did not complete. Review the redacted migration output, fix the backend issue, and retry; the database volume is preserved.",
        );
    }
    if normalized.contains("pg_isready") || normalized.contains("postgres") {
        return (
            "postgres_readiness_failed",
            true,
            "PostgreSQL did not become ready for Sacrum. Check Docker resources and the redacted database output, then retry without recreating the volume.",
        );
    }
    if normalized.contains("compose") || action.contains("Docker") {
        return (
            "docker_operation_failed",
            true,
            "Docker could not complete the local backend operation. Review the redacted command details, fix the Docker issue, and retry.",
        );
    }
    (
        "local_backend_operation_failed",
        true,
        "Local backend setup failed. Review the redacted command details, fix the reported issue, and retry; persisted secrets and data are preserved.",
    )
}

fn port_conflict(output: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    normalized.contains("port is already allocated")
        || normalized.contains("address already in use")
        || (normalized.contains("bind for") && normalized.contains("port"))
}

fn redact_diagnostic_detail(detail: &str) -> String {
    let mut redacted = detail.to_string();
    for marker in [
        "POSTGRES_PASSWORD=",
        "SECRET_KEY_BASE=",
        "DATABASE_URL=",
        "SEED_PASSWORD=",
        "SEED_TOKEN=",
    ] {
        let mut search_from = 0;
        while let Some(relative_start) = redacted[search_from..].find(marker) {
            let start = search_from + relative_start;
            let value_start = start + marker.len();
            let value_end = redacted[value_start..]
                .find(char::is_whitespace)
                .map_or(redacted.len(), |relative_end| value_start + relative_end);
            redacted.replace_range(value_start..value_end, "[redacted]");
            search_from = value_start + "[redacted]".len();
        }
    }
    redacted
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StackKind {
    Managed,
    AdoptedLegacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendImageChannel {
    BackendMaster,
    BackendRelease,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisioningState {
    Pending,
    InProgress,
    Ready,
    Failed,
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvisioningStage {
    Pulling,
    Migrating,
    Health,
    Seeding,
}

/// API token whose debug representation is redacted.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiToken(String);

impl ApiToken {
    pub fn generate() -> Result<Self, LocalBackendError> {
        let mut entropy = [0_u8; 32];
        getrandom::getrandom(&mut entropy)
            .map_err(|error| LocalBackendError::SecretGeneration(error.to_string()))?;
        Self::new(format!("sac_{}", to_hex(&entropy)))
    }

    pub fn new(value: impl Into<String>) -> Result<Self, LocalBackendError> {
        let token = Self(value.into());
        if !token.0.strip_prefix("sac_").is_some_and(|suffix| {
            suffix.len() == 64 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            return Err(LocalBackendError::InvalidState(
                "local API token must use the sac_ prefix and contain 32 bytes of hex entropy"
                    .to_string(),
            ));
        }
        Ok(token)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        text.replace(self.as_str(), "[redacted]")
    }
}

impl fmt::Debug for ApiToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ApiToken")
            .field(&"[redacted]")
            .finish()
    }
}

impl Drop for ApiToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Seeder account data; the password is redacted and zeroized on drop.
pub struct SeedAccount {
    email: String,
    username: String,
    password: String,
}

impl SeedAccount {
    pub fn new(
        email: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Result<Self, LocalBackendError> {
        let account = Self {
            email: email.into(),
            username: username.into(),
            password: password.into(),
        };
        account.validate()?;
        Ok(account)
    }

    pub fn generated_for_installation(installation_id: Uuid) -> Result<Self, LocalBackendError> {
        let mut entropy = [0_u8; 32];
        getrandom::getrandom(&mut entropy)
            .map_err(|error| LocalBackendError::SecretGeneration(error.to_string()))?;
        let suffix = installation_id.simple();
        Self::new(
            format!("local-{suffix}@vertebrae.local"),
            format!("local-{suffix}"),
            to_hex(&entropy),
        )
    }

    pub fn email(&self) -> &str {
        &self.email
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub(crate) fn password(&self) -> &str {
        &self.password
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        text.replace(self.password(), "[redacted]")
    }

    fn validate(&self) -> Result<(), LocalBackendError> {
        if self.email.trim().is_empty() || self.username.trim().is_empty() {
            return Err(LocalBackendError::InvalidState(
                "local account email and username are required".to_string(),
            ));
        }
        if self.password.is_empty() {
            return Err(LocalBackendError::InvalidState(
                "local account password is required".to_string(),
            ));
        }
        if [&self.email, &self.username, &self.password]
            .iter()
            .any(|value| {
                value
                    .bytes()
                    .any(|byte| byte == b'\0' || byte == b'\n' || byte == b'\r')
            })
        {
            return Err(LocalBackendError::InvalidState(
                "local account values must not contain NUL or line-break characters".to_string(),
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for SeedAccount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SeedAccount")
            .field("email", &self.email)
            .field("username", &self.username)
            .field("password", &"[redacted]")
            .finish()
    }
}

impl Drop for SeedAccount {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DockerTarget {
    pub name: String,
    pub endpoint: String,
}

impl DockerTarget {
    pub fn new(
        name: impl Into<String>,
        endpoint: impl Into<String>,
    ) -> Result<Self, LocalBackendError> {
        let target = Self {
            name: name.into(),
            endpoint: endpoint.into(),
        };
        target.validate()?;
        Ok(target)
    }

    pub fn validate(&self) -> Result<(), LocalBackendError> {
        if self.name.trim().is_empty() || self.endpoint.trim().is_empty() {
            return Err(LocalBackendError::InvalidState(
                "Docker context name and endpoint must not be empty".to_string(),
            ));
        }
        if !approved_local_endpoint(&self.endpoint) {
            return Err(LocalBackendError::UnsupportedDockerContext {
                name: self.name.clone(),
                endpoint: self.endpoint.clone(),
            });
        }
        Ok(())
    }
}

#[cfg(unix)]
fn approved_local_endpoint(endpoint: &str) -> bool {
    endpoint.starts_with("unix://")
}

#[cfg(windows)]
fn approved_local_endpoint(endpoint: &str) -> bool {
    endpoint.starts_with("npipe://")
}

#[cfg(not(any(unix, windows)))]
fn approved_local_endpoint(_endpoint: &str) -> bool {
    false
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedStackState {
    pub schema_version: u32,
    pub kind: StackKind,
    pub installation_id: Uuid,
    pub docker_target: DockerTarget,
    pub sacrum_image_ref: String,
    pub image_channel: BackendImageChannel,
    pub provisioning_state: ProvisioningState,
    pub postgres_volume_initialized: bool,
    pub host_port: u16,
    pub sacrum_bind_host: String,
}

impl ManagedStackState {
    pub fn fresh(
        sacrum_image_ref: impl Into<String>,
        host_port: u16,
        image_channel: BackendImageChannel,
        docker_target: DockerTarget,
    ) -> Result<Self, LocalBackendError> {
        Self::validated(Self {
            schema_version: 1,
            kind: StackKind::Managed,
            installation_id: Uuid::new_v4(),
            docker_target,
            sacrum_image_ref: sacrum_image_ref.into(),
            image_channel,
            provisioning_state: ProvisioningState::Pending,
            postgres_volume_initialized: false,
            host_port,
            sacrum_bind_host: "127.0.0.1".to_string(),
        })
    }

    pub(crate) fn adopted_legacy(
        sacrum_image_ref: impl Into<String>,
        host_port: u16,
        sacrum_bind_host: impl Into<String>,
        image_channel: BackendImageChannel,
        docker_target: DockerTarget,
    ) -> Result<Self, LocalBackendError> {
        Self::validated(Self {
            schema_version: 1,
            kind: StackKind::AdoptedLegacy,
            installation_id: Uuid::new_v4(),
            docker_target,
            sacrum_image_ref: sacrum_image_ref.into(),
            image_channel,
            provisioning_state: ProvisioningState::Unverified,
            postgres_volume_initialized: true,
            host_port,
            sacrum_bind_host: sacrum_bind_host.into(),
        })
    }

    fn validated(state: Self) -> Result<Self, LocalBackendError> {
        state.validate()?;
        Ok(state)
    }

    pub fn backend_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.host_port)
    }

    pub fn postgres_data_path(&self) -> &'static str {
        match self.kind {
            StackKind::Managed => "/var/lib/postgresql",
            StackKind::AdoptedLegacy => "/var/lib/postgresql/data",
        }
    }

    pub fn project_name(&self) -> String {
        match self.kind {
            StackKind::Managed => format!("vertebrae-local-{}", self.installation_id.simple()),
            StackKind::AdoptedLegacy => LEGACY_PROJECT.to_string(),
        }
    }

    pub fn postgres_volume(&self) -> String {
        match self.kind {
            StackKind::Managed => format!("{}_pgdata", self.project_name()),
            StackKind::AdoptedLegacy => LEGACY_VOLUME.to_string(),
        }
    }

    pub fn postgres_image_ref(&self) -> &'static str {
        match self.kind {
            StackKind::Managed => FRESH_POSTGRES_IMAGE,
            StackKind::AdoptedLegacy => LEGACY_POSTGRES_IMAGE,
        }
    }

    pub fn postgres_volume_is_external(&self) -> bool {
        self.postgres_volume_initialized
    }

    pub fn sacrum_bind_prefix(&self) -> String {
        if self.sacrum_bind_host.is_empty() {
            String::new()
        } else {
            format!("{}:", self.sacrum_bind_host)
        }
    }

    pub fn validate(&self) -> Result<(), LocalBackendError> {
        if self.schema_version != 1 {
            return Err(LocalBackendError::InvalidState(format!(
                "unsupported schema version {}",
                self.schema_version
            )));
        }
        if self.installation_id.is_nil() {
            return Err(LocalBackendError::InvalidState(
                "installation ID must not be nil".to_string(),
            ));
        }
        if self.kind == StackKind::AdoptedLegacy && !self.postgres_volume_initialized {
            return Err(LocalBackendError::InvalidState(
                "adopted legacy database volume must be initialized".to_string(),
            ));
        }
        self.docker_target.validate()?;
        if self.host_port == 0 {
            return Err(LocalBackendError::InvalidState(
                "host port must be between 1 and 65535".to_string(),
            ));
        }
        let bind_host_valid = match self.kind {
            StackKind::Managed => self.sacrum_bind_host == "127.0.0.1",
            StackKind::AdoptedLegacy => {
                matches!(self.sacrum_bind_host.as_str(), "" | "0.0.0.0" | "127.0.0.1")
            }
        };
        if !bind_host_valid {
            return Err(LocalBackendError::InvalidState(
                "Sacrum bind host does not match the stack kind".to_string(),
            ));
        }
        let digest = self
            .sacrum_image_ref
            .strip_prefix("ghcr.io/camonz/sacrum@sha256:")
            .ok_or_else(|| {
                LocalBackendError::InvalidState(
                    "Sacrum image must be the official digest-pinned image".to_string(),
                )
            })?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(LocalBackendError::InvalidState(
                "Sacrum image digest must contain 64 hexadecimal characters".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeSecrets {
    postgres_password: String,
    secret_key_base: String,
}

impl RuntimeSecrets {
    pub fn generate() -> Result<Self, LocalBackendError> {
        let mut entropy = [0_u8; 96];
        getrandom::getrandom(&mut entropy)
            .map_err(|error| LocalBackendError::SecretGeneration(error.to_string()))?;
        Self::new(to_hex(&entropy[..32]), to_hex(&entropy[32..]))
    }

    pub fn new(
        postgres_password: impl Into<String>,
        secret_key_base: impl Into<String>,
    ) -> Result<Self, LocalBackendError> {
        let secrets = Self {
            postgres_password: postgres_password.into(),
            secret_key_base: secret_key_base.into(),
        };
        secrets.validate()?;
        Ok(secrets)
    }

    pub(crate) fn legacy_development() -> Self {
        Self {
            postgres_password: LEGACY_POSTGRES_PASSWORD.to_string(),
            secret_key_base: LEGACY_SECRET_KEY_BASE.to_string(),
        }
    }

    pub fn postgres_password(&self) -> &str {
        &self.postgres_password
    }

    pub fn secret_key_base(&self) -> &str {
        &self.secret_key_base
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        let (first, second) = if self.postgres_password.len() > self.secret_key_base.len() {
            (&self.postgres_password, &self.secret_key_base)
        } else {
            (&self.secret_key_base, &self.postgres_password)
        };
        text.replace(first, "[redacted]")
            .replace(second, "[redacted]")
    }

    fn validate(&self) -> Result<(), LocalBackendError> {
        self.validate_environment_values()?;
        if self.postgres_password.len() < 32
            || !self
                .postgres_password
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte))
        {
            return Err(LocalBackendError::InvalidState(
                "PostgreSQL password must be at least 32 URI-unreserved characters".to_string(),
            ));
        }
        if self.secret_key_base.len() < 64 {
            return Err(LocalBackendError::InvalidState(
                "SECRET_KEY_BASE must be at least 64 characters".to_string(),
            ));
        }
        Ok(())
    }

    fn validate_environment_values(&self) -> Result<(), LocalBackendError> {
        for (name, value) in [
            ("PostgreSQL password", self.postgres_password.as_str()),
            ("SECRET_KEY_BASE", self.secret_key_base.as_str()),
        ] {
            if value.is_empty()
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.+/=".contains(&byte))
            {
                return Err(LocalBackendError::InvalidState(format!(
                    "{name} is not safe for an environment file"
                )));
            }
        }
        Ok(())
    }

    fn to_env_file(&self) -> String {
        format!(
            "POSTGRES_PASSWORD={}\nSECRET_KEY_BASE={}\n",
            self.postgres_password, self.secret_key_base
        )
    }

    fn from_env_file(content: &str, kind: StackKind) -> Result<Self, LocalBackendError> {
        let mut postgres_password = None;
        let mut secret_key_base = None;
        for line in content.lines() {
            let (name, value) = line.split_once('=').ok_or_else(|| {
                LocalBackendError::InvalidState("runtime.env contains an invalid line".to_string())
            })?;
            match name {
                "POSTGRES_PASSWORD" if postgres_password.is_none() => {
                    postgres_password = Some(value.to_string())
                }
                "SECRET_KEY_BASE" if secret_key_base.is_none() => {
                    secret_key_base = Some(value.to_string())
                }
                _ => {
                    return Err(LocalBackendError::InvalidState(
                        "runtime.env contains an unexpected or duplicate key".to_string(),
                    ));
                }
            }
        }
        let postgres_password = postgres_password.ok_or_else(|| {
            LocalBackendError::InvalidState("runtime.env is missing POSTGRES_PASSWORD".to_string())
        })?;
        let secret_key_base = secret_key_base.ok_or_else(|| {
            LocalBackendError::InvalidState("runtime.env is missing SECRET_KEY_BASE".to_string())
        })?;
        match kind {
            StackKind::Managed => Self::new(postgres_password, secret_key_base),
            StackKind::AdoptedLegacy => {
                let secrets = Self {
                    postgres_password,
                    secret_key_base,
                };
                if secrets != Self::legacy_development() {
                    return Err(LocalBackendError::InvalidState(
                        "adopted runtime.env does not match the development stack credentials"
                            .to_string(),
                    ));
                }
                Ok(secrets)
            }
        }
    }
}

impl fmt::Debug for RuntimeSecrets {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeSecrets")
            .field("postgres_password", &"[redacted]")
            .field("secret_key_base", &"[redacted]")
            .finish()
    }
}

impl Drop for RuntimeSecrets {
    fn drop(&mut self) {
        self.postgres_password.zeroize();
        self.secret_key_base.zeroize();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedStackPaths {
    pub root: PathBuf,
    pub compose_file: PathBuf,
    pub seed_file: PathBuf,
    pub secrets_file: PathBuf,
    pub api_token_file: PathBuf,
    pub state_file: PathBuf,
}

impl ManagedStackPaths {
    pub fn new() -> Result<Self, LocalBackendError> {
        let data_dir = vertebrae_installer::data_dir()
            .map_err(|error| LocalBackendError::DataDirectory(error.to_string()))?;
        Ok(Self::from_data_dir(&data_dir))
    }

    pub fn from_data_dir(data_dir: &Path) -> Self {
        let root = data_dir.join("local-backend");
        Self {
            compose_file: root.join("compose.yaml"),
            seed_file: root.join("seed.exs"),
            secrets_file: root.join("runtime.env"),
            api_token_file: root.join("api-token"),
            state_file: root.join("state.json"),
            root,
        }
    }

    pub fn install_assets(&self) -> Result<(), LocalBackendError> {
        ensure_private_directory(&self.root)?;
        write_if_changed(&self.compose_file, COMPOSE_ASSET.as_bytes())?;
        write_if_changed(&self.seed_file, SEED_ASSET.as_bytes())
    }

    pub fn ensure_runtime_secrets(
        &self,
        proposed: &RuntimeSecrets,
        kind: StackKind,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        ensure_private_directory(&self.root)?;
        match kind {
            StackKind::Managed => proposed.validate()?,
            StackKind::AdoptedLegacy => proposed.validate_environment_values()?,
        }
        if self.secrets_file.exists() {
            return self.load_runtime_secrets(kind);
        }

        let temp = write_temp_file(&self.secrets_file, proposed.to_env_file().as_bytes(), 0o600)?;
        match fs::hard_link(&temp, &self.secrets_file) {
            Ok(()) => {
                remove_temp(&temp);
                sync_parent(&self.secrets_file)?;
                Ok(proposed.clone())
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                remove_temp(&temp);
                self.load_runtime_secrets(kind)
            }
            Err(source) => {
                remove_temp(&temp);
                Err(file_error(
                    "persist runtime secrets",
                    &self.secrets_file,
                    source,
                ))
            }
        }
    }

    pub fn load_runtime_secrets(
        &self,
        kind: StackKind,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        set_mode(&self.secrets_file, 0o600)?;
        let content = fs::read_to_string(&self.secrets_file)
            .map_err(|source| file_error("read", &self.secrets_file, source))?;
        RuntimeSecrets::from_env_file(&content, kind)
    }

    pub fn ensure_api_token(&self, proposed: &ApiToken) -> Result<ApiToken, LocalBackendError> {
        ensure_private_directory(&self.root)?;
        if self.api_token_file.exists() {
            return self.load_api_token();
        }

        let temp = write_temp_file(&self.api_token_file, proposed.as_str().as_bytes(), 0o600)?;
        match fs::hard_link(&temp, &self.api_token_file) {
            Ok(()) => {
                remove_temp(&temp);
                sync_parent(&self.api_token_file)?;
                Ok(proposed.clone())
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                remove_temp(&temp);
                self.load_api_token()
            }
            Err(source) => {
                remove_temp(&temp);
                Err(file_error(
                    "persist local API token",
                    &self.api_token_file,
                    source,
                ))
            }
        }
    }

    pub fn load_api_token(&self) -> Result<ApiToken, LocalBackendError> {
        set_mode(&self.api_token_file, 0o600)?;
        let content = fs::read_to_string(&self.api_token_file)
            .map_err(|source| file_error("read", &self.api_token_file, source))?;
        ApiToken::new(content.trim_end_matches(['\r', '\n']))
    }

    pub fn save_state(&self, state: &ManagedStackState) -> Result<(), LocalBackendError> {
        state.validate()?;
        ensure_private_directory(&self.root)?;
        let content = serde_json::to_vec_pretty(state).map_err(|error| {
            LocalBackendError::InvalidState(format!("could not serialize state: {error}"))
        })?;
        atomic_replace(&self.state_file, &content, 0o600)
    }

    pub fn load_state(&self) -> Result<Option<ManagedStackState>, LocalBackendError> {
        if !self.state_file.exists() {
            return Ok(None);
        }
        let content = fs::read(&self.state_file)
            .map_err(|source| file_error("read", &self.state_file, source))?;
        let state: ManagedStackState = serde_json::from_slice(&content).map_err(|error| {
            LocalBackendError::InvalidState(format!("could not parse state.json: {error}"))
        })?;
        state.validate()?;
        Ok(Some(state))
    }
}

pub fn select_host_port(preferred: u16) -> Result<u16, LocalBackendError> {
    if preferred != 0 && TcpListener::bind((Ipv4Addr::LOCALHOST, preferred)).is_ok() {
        return Ok(preferred);
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|source| {
        LocalBackendError::InvalidState(format!("could not select a local port: {source}"))
    })?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|source| {
            LocalBackendError::InvalidState(format!("could not read selected port: {source}"))
        })
}

fn ensure_private_directory(path: &Path) -> Result<(), LocalBackendError> {
    fs::create_dir_all(path).map_err(|source| file_error("create directory", path, source))?;
    set_mode(path, 0o700)
}

fn write_if_changed(path: &Path, content: &[u8]) -> Result<(), LocalBackendError> {
    if fs::read(path).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    atomic_replace(path, content, 0o600)
}

fn atomic_replace(path: &Path, content: &[u8], mode: u32) -> Result<(), LocalBackendError> {
    let temp = write_temp_file(path, content, mode)?;
    fs::rename(&temp, path).map_err(|source| {
        remove_temp(&temp);
        file_error("replace", path, source)
    })?;
    sync_parent(path)
}

fn write_temp_file(path: &Path, content: &[u8], mode: u32) -> Result<PathBuf, LocalBackendError> {
    let parent = path.parent().ok_or_else(|| {
        LocalBackendError::InvalidState(format!("{} has no parent directory", path.display()))
    })?;
    let name = path
        .file_name()
        .ok_or_else(|| {
            LocalBackendError::InvalidState(format!("{} has no file name", path.display()))
        })?
        .to_string_lossy();
    let temp = parent.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    let mut file = options
        .open(&temp)
        .map_err(|source| file_error("create temporary file for", path, source))?;
    if let Err(source) = file.write_all(content).and_then(|()| file.sync_all()) {
        remove_temp(&temp);
        return Err(file_error("write", path, source));
    }
    if let Err(error) = set_mode(&temp, mode) {
        remove_temp(&temp);
        return Err(error);
    }
    Ok(temp)
}

fn set_mode(path: &Path, mode: u32) -> Result<(), LocalBackendError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|source| file_error("set permissions on", path, source))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

fn remove_temp(path: &Path) {
    let _ = fs::remove_file(path);
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), LocalBackendError> {
    let parent = path.parent().ok_or_else(|| {
        LocalBackendError::InvalidState(format!("{} has no parent directory", path.display()))
    })?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| file_error("sync directory containing", path, source))
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> Result<(), LocalBackendError> {
    Ok(())
}

fn to_hex(bytes: &[u8]) -> String {
    use fmt::Write as _;

    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn file_error(action: &'static str, path: &Path, source: io::Error) -> LocalBackendError {
    LocalBackendError::FileSystem {
        action,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST_IMAGE: &str =
        "ghcr.io/camonz/sacrum@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn secrets(suffix: &str) -> RuntimeSecrets {
        RuntimeSecrets::new(
            format!("postgres-password-{suffix}-0123456789abcdef0123456789abcdef"),
            format!(
                "secret-key-base-{suffix}-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            ),
        )
        .expect("valid secrets")
    }

    fn docker_target() -> DockerTarget {
        DockerTarget::new("desktop-linux", "unix:///tmp/docker.sock").expect("local target")
    }

    fn fresh(channel: BackendImageChannel) -> ManagedStackState {
        ManagedStackState::fresh(DIGEST_IMAGE, 4400, channel, docker_target()).expect("fresh state")
    }

    #[test]
    fn managed_assets_define_the_required_stack() {
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        paths.install_assets().expect("install assets");

        let compose = fs::read_to_string(paths.compose_file).expect("read compose");
        let seed = fs::read_to_string(paths.seed_file).expect("read seed");

        for required in [
            "postgres:18-alpine",
            "wal_level=logical",
            "max_replication_slots=10",
            "max_wal_senders=10",
            "${SACRUM_IMAGE_REF:?}",
            "${SACRUM_BIND_PREFIX}",
            "/app/bin/migrate",
            "http://127.0.0.1:4000/healthz",
            "${POSTGRES_VOLUME:?}",
            "external: ${POSTGRES_VOLUME_EXTERNAL:?}",
            "${POSTGRES_DATA_PATH:?}",
        ] {
            assert!(compose.contains(required), "compose is missing {required}");
        }
        assert_eq!(
            compose.matches("image: \"${SACRUM_IMAGE_REF:?}\"").count(),
            2
        );
        assert!(!compose.starts_with("name:"));
        assert!(seed.contains("System.fetch_env!(\"SEED_TOKEN\")"));
        assert!(!seed.contains("dev_password_123"));
        assert!(!seed.contains("sac_dev-local-token"));
    }

    #[test]
    fn managed_state_requires_an_official_digest_pinned_image() {
        let state = fresh(BackendImageChannel::BackendRelease);
        let project_name = format!("vertebrae-local-{}", state.installation_id.simple());
        assert_eq!(state.project_name(), project_name);
        assert_eq!(state.postgres_volume(), format!("{project_name}_pgdata"));
        assert_eq!(state.postgres_image_ref(), "postgres:18-alpine");
        assert_eq!(state.postgres_data_path(), "/var/lib/postgresql");
        assert_eq!(state.backend_url(), "http://127.0.0.1:4400");
        assert_eq!(state.sacrum_bind_host, "127.0.0.1");
        assert_eq!(state.sacrum_bind_prefix(), "127.0.0.1:");
        assert_eq!(state.provisioning_state, ProvisioningState::Pending);
        assert_eq!(state.image_channel, BackendImageChannel::BackendRelease);
        assert!(!state.installation_id.is_nil());
        assert!(!state.postgres_volume_initialized);
        assert!(!state.postgres_volume_is_external());

        for provisioning_state in [
            ProvisioningState::InProgress,
            ProvisioningState::Ready,
            ProvisioningState::Failed,
        ] {
            let mut not_created = state.clone();
            not_created.provisioning_state = provisioning_state;
            assert!(!not_created.postgres_volume_is_external());
        }

        let mut previously_created = state.clone();
        previously_created.postgres_volume_initialized = true;
        assert!(previously_created.postgres_volume_is_external());

        let second = fresh(BackendImageChannel::BackendRelease);
        assert_ne!(state.installation_id, second.installation_id);
        assert_ne!(state.project_name(), second.project_name());
        assert_ne!(state.postgres_volume(), second.postgres_volume());
        assert!(matches!(
            DockerTarget::new("remote", "tcp://docker.example:2376"),
            Err(LocalBackendError::UnsupportedDockerContext { .. })
        ));

        let error = ManagedStackState::fresh(
            "ghcr.io/camonz/sacrum:latest",
            4400,
            BackendImageChannel::BackendMaster,
            docker_target(),
        )
        .expect_err("mutable image must be rejected");
        assert!(error.to_string().contains("digest-pinned"));
    }

    #[test]
    fn adopted_v17_volume_cannot_be_attached_to_postgres_18() {
        let adopted = ManagedStackState::adopted_legacy(
            DIGEST_IMAGE,
            4400,
            "",
            BackendImageChannel::BackendRelease,
            docker_target(),
        )
        .expect("valid adopted state");
        assert_eq!(adopted.postgres_image_ref(), "postgres:17-alpine");
        assert_eq!(adopted.postgres_volume(), "vertebrae-dev_pgdata");
        assert_eq!(adopted.postgres_data_path(), "/var/lib/postgresql/data");
        assert_eq!(adopted.backend_url(), "http://127.0.0.1:4400");
        assert_eq!(adopted.provisioning_state, ProvisioningState::Unverified);
        assert!(adopted.postgres_volume_initialized);
        assert!(adopted.postgres_volume_is_external());
    }

    #[test]
    fn runtime_secrets_are_written_once_and_reused() {
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let first = secrets("first");
        let second = secrets("second");

        assert_eq!(
            paths
                .ensure_runtime_secrets(&first, StackKind::Managed)
                .expect("write secrets"),
            first
        );
        assert_eq!(
            paths
                .ensure_runtime_secrets(&second, StackKind::Managed)
                .expect("reuse secrets"),
            first
        );
        assert_eq!(
            paths
                .load_runtime_secrets(StackKind::Managed)
                .expect("load secrets"),
            first
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = fs::metadata(&paths.secrets_file)
                .expect("secrets metadata")
                .permissions()
                .mode()
                & 0o777;
            let directory_mode = fs::metadata(&paths.root)
                .expect("directory metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file_mode, 0o600);
            assert_eq!(directory_mode, 0o700);
        }
    }

    #[test]
    fn generated_runtime_secrets_are_long_uri_safe_and_distinct() {
        let first = RuntimeSecrets::generate().expect("generate first secrets");
        let second = RuntimeSecrets::generate().expect("generate second secrets");

        for (value, length) in [
            (first.postgres_password(), 64),
            (first.secret_key_base(), 128),
        ] {
            assert_eq!(value.len(), length);
            assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
        assert_ne!(first, second);
        assert!(first
            .to_env_file()
            .chars()
            .all(|character| !matches!(character, '/' | '+')));
    }

    #[test]
    fn generated_api_tokens_are_sac_prefixed_and_distinct() {
        let first = ApiToken::generate().expect("generate first API token");
        let second = ApiToken::generate().expect("generate second API token");

        assert!(first.as_str().starts_with("sac_"));
        assert_eq!(first.as_str().len(), 68);
        assert!(first.as_str()[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
        assert_eq!(format!("{first:?}"), "ApiToken(\"[redacted]\")");
    }

    #[test]
    fn api_token_is_persisted_once_with_owner_only_permissions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let first = ApiToken::new(format!("sac_{}", "a".repeat(64))).expect("valid token");
        let second = ApiToken::new(format!("sac_{}", "b".repeat(64))).expect("valid token");

        assert_eq!(
            paths.ensure_api_token(&first).expect("persist token"),
            first
        );
        assert_eq!(paths.ensure_api_token(&second).expect("reuse token"), first);
        assert_eq!(paths.load_api_token().expect("load token"), first);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&paths.api_token_file)
                    .expect("token metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn seed_account_rejects_unsafe_values_and_redacts_password() {
        let account = SeedAccount::new("user@example.test", "user", "correct horse battery staple")
            .expect("valid account");
        assert_eq!(account.email(), "user@example.test");
        assert_eq!(account.username(), "user");
        assert!(!format!("{account:?}").contains("correct horse"));
        assert!(!account
            .redact("password=correct horse battery staple")
            .contains("correct horse"));
        assert!(SeedAccount::new("user\n@example.test", "user", "password").is_err());
    }

    #[test]
    fn generated_account_is_unique_and_valid() {
        let first = SeedAccount::generated_for_installation(Uuid::new_v4())
            .expect("generate first account");
        let second = SeedAccount::generated_for_installation(Uuid::new_v4())
            .expect("generate second account");

        assert_ne!(first.email(), second.email());
        assert_ne!(first.username(), second.username());
        assert_ne!(first.password(), second.password());
        assert!(first.email().ends_with("@vertebrae.local"));
        assert!(first.username().starts_with("local-"));
        assert_eq!(first.password().len(), 64);
    }

    #[test]
    fn diagnostics_classify_retryable_setup_failures_with_remediation() {
        let cases = [
            (
                LocalBackendError::CommandFailed {
                    action: "start local Sacrum".to_string(),
                    status: "1".to_string(),
                    output: "pull access denied for ghcr.io/camonz/sacrum".to_string(),
                },
                "sacrum_image_unavailable",
                "registry authentication",
            ),
            (
                LocalBackendError::CommandFailed {
                    action: "start local Sacrum".to_string(),
                    status: "1".to_string(),
                    output: "migration failed: column already exists".to_string(),
                },
                "sacrum_migration_failed",
                "migrations",
            ),
            (
                LocalBackendError::CommandFailed {
                    action: "seed local Sacrum account".to_string(),
                    status: "1".to_string(),
                    output: "seed exited with status 1".to_string(),
                },
                "seeder_failed",
                "same account details",
            ),
            (
                LocalBackendError::PortUnavailable {
                    port: 4400,
                    output: "address already in use".to_string(),
                },
                "local_port_unavailable",
                "conflicting process",
            ),
        ];

        for (error, expected_code, expected_hint) in cases {
            let diagnostic = error.diagnostic();
            assert_eq!(diagnostic.code, expected_code);
            assert!(diagnostic.retryable, "{diagnostic:?}");
            assert!(diagnostic.message.contains(expected_hint), "{diagnostic:?}");
        }
    }

    #[test]
    fn diagnostics_keep_command_details_bounded_and_redacted() {
        let error = LocalBackendError::CommandFailed {
            action: "seed local Sacrum account".to_string(),
            status: "1".to_string(),
            output: "SEED_PASSWORD=raw-password SEED_TOKEN=raw-token".to_string(),
        };
        let diagnostic = error.diagnostic();

        assert_eq!(diagnostic.code, "seeder_failed");
        assert!(!diagnostic.message.contains("raw-password"));
        assert!(!diagnostic.message.contains("raw-token"));
        assert_eq!(diagnostic.message.matches("[redacted]").count(), 2);
    }

    #[test]
    fn redaction_replaces_overlapping_secrets_longest_first() {
        let shorter = "a".repeat(32);
        let longer = format!("{}{}", shorter, "b".repeat(32));
        let secrets = RuntimeSecrets::new(&shorter, &longer).expect("valid overlapping secrets");

        let redacted = secrets.redact(&format!("{longer} {shorter}"));

        assert_eq!(redacted, "[redacted] [redacted]");
        assert!(!redacted.contains(&shorter));
        assert!(!redacted.contains(&longer));
    }

    #[test]
    fn state_round_trips_without_secrets() {
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let state = fresh(BackendImageChannel::BackendMaster);

        paths.install_assets().expect("install assets");
        paths
            .ensure_runtime_secrets(&secrets("durable"), state.kind)
            .expect("persist secrets");
        paths.save_state(&state).expect("save state");

        assert_eq!(paths.load_state().expect("load state"), Some(state));
        let json = fs::read_to_string(paths.state_file).expect("read state");
        assert!(!json.contains("POSTGRES_PASSWORD"));
        assert!(!json.contains("SECRET_KEY_BASE"));
        for expected in [
            r#""image_channel": "backend-master""#,
            r#""provisioning_state": "pending""#,
            r#""postgres_volume_initialized": false"#,
            r#""name": "desktop-linux""#,
            r#""endpoint": "unix:///tmp/docker.sock""#,
        ] {
            assert!(json.contains(expected), "missing {expected}");
        }

        let mut names: Vec<_> = fs::read_dir(&paths.root)
            .expect("read managed directory")
            .map(|entry| {
                entry
                    .expect("directory entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["compose.yaml", "runtime.env", "seed.exs", "state.json"]
        );
    }

    #[test]
    fn persisted_secrets_must_match_their_stack_contract() {
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        ensure_private_directory(&paths.root).expect("create root");
        fs::write(
            &paths.secrets_file,
            "POSTGRES_PASSWORD=legacy/password+with=padding\nSECRET_KEY_BASE=legacy-secret-key-base-that-is-at-least-64-bytes-long-for-phoenix-app\n",
        )
        .expect("write runtime.env");

        let error = paths
            .load_runtime_secrets(StackKind::Managed)
            .expect_err("fresh secrets must stay URI safe");
        assert!(error.to_string().contains("URI-unreserved"));
        let error = paths
            .load_runtime_secrets(StackKind::AdoptedLegacy)
            .expect_err("arbitrary adopted secrets must be rejected");
        assert!(error.to_string().contains("development stack credentials"));

        let development = RuntimeSecrets::legacy_development();
        fs::write(&paths.secrets_file, development.to_env_file()).expect("write fixed runtime.env");
        assert_eq!(
            paths
                .load_runtime_secrets(StackKind::AdoptedLegacy)
                .expect("load fixed development secrets"),
            development
        );
    }

    #[test]
    fn occupied_preferred_port_selects_an_available_alternative() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind occupied port");
        let occupied_port = occupied.local_addr().expect("local address").port();

        let selected = select_host_port(occupied_port).expect("select port");

        assert_ne!(selected, occupied_port);
        TcpListener::bind((Ipv4Addr::LOCALHOST, selected)).expect("selected port is available");
    }
}
