use serde::{Deserialize, Serialize};
use std::fmt;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const COMPOSE_ASSET: &str = include_str!("assets/compose.yaml");
const SEED_ASSET: &str = include_str!("assets/seed.exs");
pub(crate) const LEGACY_PROJECT: &str = "vertebrae-dev";
pub(crate) const LEGACY_VOLUME: &str = "vertebrae-dev_pgdata";
pub(crate) const FRESH_POSTGRES_IMAGE: &str = "postgres:18-alpine";
pub(crate) const LEGACY_POSTGRES_IMAGE: &str = "postgres:17-alpine";
const LEGACY_POSTGRES_PASSWORD: &str = "postgres";
const LEGACY_SECRET_KEY_BASE: &str =
    "dev-secret-key-base-that-is-at-least-64-bytes-long-for-phoenix-app";

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
        let mut values = [
            self.postgres_password.as_str(),
            self.secret_key_base.as_str(),
        ];
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        values
            .into_iter()
            .fold(text.to_string(), |redacted, value| {
                redacted.replace(value, "[redacted]")
            })
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedStackPaths {
    pub root: PathBuf,
    pub compose_file: PathBuf,
    pub seed_file: PathBuf,
    pub secrets_file: PathBuf,
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
        let state = ManagedStackState::fresh(
            DIGEST_IMAGE,
            4400,
            BackendImageChannel::BackendRelease,
            docker_target(),
        )
        .expect("valid managed state");
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
    fn fresh_states_have_distinct_installation_ids_and_reject_remote_contexts() {
        let first = ManagedStackState::fresh(
            DIGEST_IMAGE,
            4400,
            BackendImageChannel::BackendRelease,
            docker_target(),
        )
        .expect("first state");
        let second = ManagedStackState::fresh(
            DIGEST_IMAGE,
            4400,
            BackendImageChannel::BackendRelease,
            docker_target(),
        )
        .expect("second state");

        assert_ne!(first.installation_id, second.installation_id);
        assert_ne!(first.project_name(), second.project_name());
        assert_ne!(first.postgres_volume(), second.postgres_volume());
        assert!(matches!(
            DockerTarget::new("remote", "tcp://docker.example:2376"),
            Err(LocalBackendError::UnsupportedDockerContext { .. })
        ));
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

        assert_ne!(adopted.postgres_image_ref(), FRESH_POSTGRES_IMAGE);
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

        assert_eq!(first.postgres_password().len(), 64);
        assert_eq!(first.secret_key_base().len(), 128);
        assert!(first
            .postgres_password()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert!(first
            .secret_key_base()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
        assert!(first
            .to_env_file()
            .chars()
            .all(|character| !matches!(character, '/' | '+')));
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
        let state = ManagedStackState::fresh(
            DIGEST_IMAGE,
            4400,
            BackendImageChannel::BackendMaster,
            docker_target(),
        )
        .expect("valid state");

        paths.save_state(&state).expect("save state");

        assert_eq!(paths.load_state().expect("load state"), Some(state));
        let json = fs::read_to_string(paths.state_file).expect("read state");
        assert!(!json.contains("POSTGRES_PASSWORD"));
        assert!(!json.contains("SECRET_KEY_BASE"));
        assert!(json.contains(r#""image_channel": "backend-master""#));
        assert!(json.contains(r#""provisioning_state": "pending""#));
        assert!(json.contains(r#""postgres_volume_initialized": false"#));
        assert!(json.contains(r#""name": "desktop-linux""#));
        assert!(json.contains(r#""endpoint": "unix:///tmp/docker.sock""#));
    }

    #[test]
    fn atomic_persistence_leaves_only_complete_directory_entries() {
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let state = ManagedStackState::fresh(
            DIGEST_IMAGE,
            4400,
            BackendImageChannel::BackendRelease,
            docker_target(),
        )
        .expect("valid state");

        paths.install_assets().expect("install assets");
        paths
            .ensure_runtime_secrets(&secrets("durable"), state.kind)
            .expect("persist secrets");
        paths.save_state(&state).expect("persist state");

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
