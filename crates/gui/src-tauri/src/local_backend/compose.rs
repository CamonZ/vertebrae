use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;

use super::command::{CommandOutput, CommandRequest, ProcessRunner, SystemProcessRunner};
use super::state::{
    BackendImageChannel, LocalBackendError, ManagedStackPaths, ManagedStackState, RuntimeSecrets,
    StackKind, LEGACY_POSTGRES_IMAGE, LEGACY_PROJECT, LEGACY_VOLUME,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(2);
const LEGACY_INSPECT_CAPTURE_BYTES: usize = 256 * 1024;
const LEGACY_INSPECT_FORMAT: &str = r#"{"Image":{{json .Config.Image}},"Env":{{json .Config.Env}},"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"Service":{{json (index .Config.Labels "com.docker.compose.service")}},"PortBindings":{{json .HostConfig.PortBindings}},"Mounts":{{json .Mounts}}}"#;
const LEGACY_VOLUME_INSPECT_FORMAT: &str = r#"{"Name":{{json .Name}},"Project":{{json (index .Labels "com.docker.compose.project")}},"Volume":{{json (index .Labels "com.docker.compose.volume")}}}"#;

#[async_trait]
pub trait HealthProbe: Send + Sync {
    async fn is_healthy(&self, url: &str) -> bool;
}

#[derive(Clone)]
pub struct ReqwestHealthProbe {
    client: reqwest::Client,
}

impl Default for ReqwestHealthProbe {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("valid health probe client"),
        }
    }
}

#[async_trait]
impl HealthProbe for ReqwestHealthProbe {
    async fn is_healthy(&self, url: &str) -> bool {
        self.client
            .get(url)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceStatus {
    pub name: String,
    pub service: String,
    pub state: String,
    pub health: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Clone)]
pub struct LegacyStackCandidate {
    pub host_port: u16,
    bind_host: String,
    secrets: RuntimeSecrets,
}

impl fmt::Debug for LegacyStackCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LegacyStackCandidate")
            .field("host_port", &self.host_port)
            .field("bind_host", &self.bind_host)
            .field("secrets", &"[redacted]")
            .finish()
    }
}

#[derive(Clone)]
pub struct LegacyRuntimeDetails {
    host_port: u16,
    secrets: RuntimeSecrets,
}

impl LegacyRuntimeDetails {
    pub fn new(
        host_port: u16,
        postgres_password: impl Into<String>,
        secret_key_base: impl Into<String>,
    ) -> Result<Self, LocalBackendError> {
        if host_port == 0 {
            return Err(LocalBackendError::InvalidState(
                "legacy host port must be between 1 and 65535".to_string(),
            ));
        }
        Ok(Self {
            host_port,
            secrets: RuntimeSecrets::legacy(postgres_password, secret_key_base)?,
        })
    }
}

impl fmt::Debug for LegacyRuntimeDetails {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LegacyRuntimeDetails")
            .field("host_port", &self.host_port)
            .field("secrets", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone)]
pub enum LegacyStackDetection {
    Absent,
    Compatible(LegacyStackCandidate),
    RuntimeDetailsRequired,
    Unsafe(String),
}

enum LegacyVolumeStatus {
    Absent,
    Compatible,
    Unsafe(String),
}

pub struct DockerCompose<R, H> {
    runner: R,
    health_probe: H,
    command_timeout: Duration,
    health_timeout: Duration,
    health_poll_interval: Duration,
}

impl DockerCompose<SystemProcessRunner, ReqwestHealthProbe> {
    pub fn system() -> Self {
        Self::new(SystemProcessRunner, ReqwestHealthProbe::default())
    }
}

impl<R, H> DockerCompose<R, H>
where
    R: ProcessRunner,
    H: HealthProbe,
{
    pub fn new(runner: R, health_probe: H) -> Self {
        Self {
            runner,
            health_probe,
            command_timeout: COMMAND_TIMEOUT,
            health_timeout: HEALTH_TIMEOUT,
            health_poll_interval: HEALTH_POLL_INTERVAL,
        }
    }

    pub fn with_timeouts(
        mut self,
        command_timeout: Duration,
        health_timeout: Duration,
        health_poll_interval: Duration,
    ) -> Self {
        self.command_timeout = command_timeout;
        self.health_timeout = health_timeout;
        self.health_poll_interval = health_poll_interval;
        self
    }

    pub async fn check_prerequisites(&self) -> Result<(), LocalBackendError> {
        let docker = self
            .runner
            .run(CommandRequest::new(
                "check Docker",
                "docker",
                ["version", "--format", "{{.Server.Version}}"],
                self.command_timeout,
            ))
            .await
            .map_err(|error| LocalBackendError::DockerUnavailable(error.to_string()))?;
        if !docker.success {
            return Err(LocalBackendError::DockerUnavailable(docker.summary()));
        }

        let compose = self
            .runner
            .run(CommandRequest::new(
                "check Docker Compose",
                "docker",
                ["compose", "version", "--short"],
                self.command_timeout,
            ))
            .await
            .map_err(|error| LocalBackendError::ComposeUnavailable(error.to_string()))?;
        if !compose.success {
            return Err(LocalBackendError::ComposeUnavailable(compose.summary()));
        }
        Ok(())
    }

    pub async fn up_detached(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.check_prerequisites().await?;
        self.validate_stack_files(paths, state)?;
        self.checked_stack(
            self.compose_request(
                paths,
                state,
                "validate Compose configuration",
                ["config", "--quiet"],
            )?,
            paths,
            state,
        )
        .await?;
        self.checked_stack(
            self.compose_request(
                paths,
                state,
                "start local Sacrum",
                ["up", "--detach", "--pull", "missing", "postgres", "sacrum"],
            )?,
            paths,
            state,
        )
        .await?;
        self.status_without_prerequisite(paths, state).await
    }

    pub async fn status(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.check_prerequisites().await?;
        self.validate_stack_files(paths, state)?;
        self.status_without_prerequisite(paths, state).await
    }

    pub async fn wait_until_healthy(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        let url = format!("{}/healthz", state.backend_url());
        let started = tokio::time::Instant::now();
        loop {
            if self.health_probe.is_healthy(&url).await {
                return Ok(());
            }
            if started.elapsed() >= self.health_timeout {
                let logs = self
                    .checked_stack(
                        self.compose_request(
                            paths,
                            state,
                            "read local backend logs",
                            ["logs", "--no-color", "--tail", "80", "postgres", "sacrum"],
                        )?,
                        paths,
                        state,
                    )
                    .await
                    .map(|output| output.summary())
                    .unwrap_or_else(|error| format!("Could not read logs: {error}"));
                return Err(LocalBackendError::HealthTimedOut {
                    url,
                    timeout_seconds: self.health_timeout.as_secs(),
                    logs,
                });
            }
            tokio::time::sleep(self.health_poll_interval).await;
        }
    }

    pub async fn detect_legacy_stack(&self) -> Result<LegacyStackDetection, LocalBackendError> {
        self.check_prerequisites().await?;
        let containers = self
            .checked(CommandRequest::new(
                "find vertebrae-dev containers",
                "docker",
                [
                    "ps",
                    "--all",
                    "--filter",
                    "label=com.docker.compose.project=vertebrae-dev",
                    "--format",
                    "{{.ID}}",
                ],
                self.command_timeout,
            ))
            .await?;
        let ids: Vec<&str> = containers
            .stdout
            .lines()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .collect();
        if ids.is_empty() {
            return Ok(match self.legacy_volume_status().await? {
                LegacyVolumeStatus::Absent => LegacyStackDetection::Absent,
                LegacyVolumeStatus::Compatible => LegacyStackDetection::RuntimeDetailsRequired,
                LegacyVolumeStatus::Unsafe(reason) => LegacyStackDetection::Unsafe(reason),
            });
        }

        let mut inspect_args = vec![
            OsString::from("inspect"),
            OsString::from("--format"),
            OsString::from(LEGACY_INSPECT_FORMAT),
        ];
        inspect_args.extend(ids.iter().map(OsString::from));
        let inspected = self
            .runner
            .run(
                CommandRequest::new(
                    "inspect vertebrae-dev containers",
                    "docker",
                    inspect_args,
                    self.command_timeout,
                )
                .with_capture_limit(LEGACY_INSPECT_CAPTURE_BYTES),
            )
            .await?;
        if !inspected.success {
            return Err(LocalBackendError::CommandFailed {
                action: "inspect vertebrae-dev containers".to_string(),
                status: inspected
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "terminated".to_string()),
                output: if inspected.stderr.trim().is_empty() {
                    "Docker did not return container metadata".to_string()
                } else {
                    inspected.stderr.trim().to_string()
                },
            });
        }
        if inspected.truncated {
            return Ok(LegacyStackDetection::Unsafe(
                "Docker container metadata exceeded the inspection limit".to_string(),
            ));
        }
        let containers = match parse_legacy_inspection(&inspected.stdout) {
            Ok(containers) => containers,
            Err(error) => {
                return Ok(LegacyStackDetection::Unsafe(format!(
                    "Docker returned unreadable container metadata: {error}"
                )));
            }
        };
        let candidate = match validate_legacy_containers(&containers) {
            Ok(candidate) => candidate,
            Err(reason) => return Ok(LegacyStackDetection::Unsafe(reason)),
        };

        match self.legacy_volume_status().await? {
            LegacyVolumeStatus::Compatible => {}
            LegacyVolumeStatus::Absent => {
                return Ok(LegacyStackDetection::Unsafe(
                    "the vertebrae-dev_pgdata volume is missing".to_string(),
                ));
            }
            LegacyVolumeStatus::Unsafe(reason) => {
                return Ok(LegacyStackDetection::Unsafe(reason));
            }
        }
        Ok(LegacyStackDetection::Compatible(candidate))
    }

    pub fn adopt_legacy_stack(
        &self,
        paths: &ManagedStackPaths,
        detection: &LegacyStackDetection,
        runtime_details: Option<&LegacyRuntimeDetails>,
        sacrum_image_ref: impl Into<String>,
        image_channel: BackendImageChannel,
        confirmed: bool,
    ) -> Result<ManagedStackState, LocalBackendError> {
        if !confirmed {
            return Err(LocalBackendError::AdoptionNotConfirmed);
        }
        let candidate = match detection {
            LegacyStackDetection::Compatible(candidate) => candidate.clone(),
            LegacyStackDetection::RuntimeDetailsRequired => {
                let details =
                    runtime_details.ok_or(LocalBackendError::LegacyRuntimeDetailsRequired)?;
                LegacyStackCandidate {
                    host_port: details.host_port,
                    bind_host: String::new(),
                    secrets: details.secrets.clone(),
                }
            }
            LegacyStackDetection::Unsafe(reason) => {
                return Err(LocalBackendError::UnsafeLegacyStack(reason.clone()));
            }
            LegacyStackDetection::Absent => {
                return Err(LocalBackendError::UnsafeLegacyStack(
                    "the vertebrae-dev_pgdata volume is missing".to_string(),
                ));
            }
        };
        if let Some(existing) = paths.load_state()? {
            if existing.kind != StackKind::AdoptedLegacy {
                return Err(LocalBackendError::UnsafeLegacyStack(
                    "a different managed local stack already exists".to_string(),
                ));
            }
            if paths.load_runtime_secrets(StackKind::AdoptedLegacy)? != candidate.secrets {
                return Err(LocalBackendError::UnsafeLegacyStack(
                    "saved runtime secrets do not match the detected legacy containers".to_string(),
                ));
            }
            return Ok(existing);
        }

        if paths.secrets_file.exists()
            && paths.load_runtime_secrets(StackKind::AdoptedLegacy)? != candidate.secrets
        {
            return Err(LocalBackendError::UnsafeLegacyStack(
                "an unrelated runtime secrets file already exists".to_string(),
            ));
        }
        let state = ManagedStackState::adopted_legacy(
            sacrum_image_ref,
            candidate.host_port,
            candidate.bind_host,
            image_channel,
        )?;
        paths.install_assets()?;
        paths.ensure_runtime_secrets(&candidate.secrets, StackKind::AdoptedLegacy)?;
        paths.save_state(&state)?;
        Ok(state)
    }

    async fn legacy_volume_status(&self) -> Result<LegacyVolumeStatus, LocalBackendError> {
        let output = self
            .checked(CommandRequest::new(
                "find vertebrae-dev database volume",
                "docker",
                [
                    "volume",
                    "ls",
                    "--filter",
                    "name=vertebrae-dev_pgdata",
                    "--format",
                    "{{.Name}}",
                ],
                self.command_timeout,
            ))
            .await?;
        if !output
            .stdout
            .lines()
            .any(|name| name.trim() == LEGACY_VOLUME)
        {
            return Ok(LegacyVolumeStatus::Absent);
        }
        let inspected = self
            .checked(CommandRequest::new(
                "inspect vertebrae-dev database volume",
                "docker",
                [
                    "volume",
                    "inspect",
                    "--format",
                    LEGACY_VOLUME_INSPECT_FORMAT,
                    LEGACY_VOLUME,
                ],
                self.command_timeout,
            ))
            .await?;
        let volume: LegacyVolumeInspect =
            serde_json::from_str(inspected.stdout.trim()).map_err(|error| {
                LocalBackendError::InvalidState(format!(
                    "could not parse Docker volume metadata: {error}"
                ))
            })?;
        if volume.name != LEGACY_VOLUME
            || volume.project.as_deref() != Some(LEGACY_PROJECT)
            || volume.volume.as_deref() != Some("pgdata")
        {
            return Ok(LegacyVolumeStatus::Unsafe(
                "vertebrae-dev_pgdata does not have the expected Compose project and volume labels"
                    .to_string(),
            ));
        }
        Ok(LegacyVolumeStatus::Compatible)
    }

    async fn status_without_prerequisite(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        let output = self
            .checked_stack(
                self.compose_request(
                    paths,
                    state,
                    "read local backend status",
                    ["ps", "--format", "json"],
                )?,
                paths,
                state,
            )
            .await?;
        parse_service_statuses(&output.stdout)
    }

    fn compose_request(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        action: &str,
        operation: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Result<CommandRequest, LocalBackendError> {
        let secrets = paths.load_runtime_secrets(state.kind)?;
        let mut args = vec![
            "compose".into(),
            "--ansi".into(),
            "never".into(),
            "--project-directory".into(),
            paths.root.as_os_str().to_owned(),
            "--project-name".into(),
            state.project_name.clone().into(),
            "--file".into(),
            paths.compose_file.as_os_str().to_owned(),
            "--env-file".into(),
            paths.secrets_file.as_os_str().to_owned(),
        ];
        args.extend(operation.into_iter().map(Into::into));
        Ok(
            CommandRequest::new(action, "docker", args, self.command_timeout).with_env([
                (
                    OsString::from("COMPOSE_PROJECT_NAME"),
                    state.project_name.clone().into(),
                ),
                (
                    OsString::from("POSTGRES_VOLUME"),
                    state.postgres_volume.clone().into(),
                ),
                (
                    OsString::from("POSTGRES_IMAGE_REF"),
                    state.postgres_image_ref.clone().into(),
                ),
                (
                    OsString::from("POSTGRES_DATA_PATH"),
                    state.postgres_data_path().into(),
                ),
                (
                    OsString::from("SACRUM_IMAGE_REF"),
                    state.sacrum_image_ref.clone().into(),
                ),
                (
                    OsString::from("SACRUM_HOST_PORT"),
                    state.host_port.to_string().into(),
                ),
                (
                    OsString::from("SACRUM_BIND_PREFIX"),
                    state.sacrum_bind_prefix().into(),
                ),
                (
                    OsString::from("SEED_SCRIPT_PATH"),
                    paths.seed_file.as_os_str().to_owned(),
                ),
                (
                    OsString::from("POSTGRES_PASSWORD"),
                    secrets.postgres_password().into(),
                ),
                (
                    OsString::from("SECRET_KEY_BASE"),
                    secrets.secret_key_base().into(),
                ),
            ]),
        )
    }

    fn validate_stack_files(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        state.validate()?;
        for (name, path) in [
            ("Compose asset", paths.compose_file.as_path()),
            ("seeder asset", paths.seed_file.as_path()),
            ("runtime secrets", paths.secrets_file.as_path()),
        ] {
            if !path.is_file() {
                return Err(LocalBackendError::InvalidState(format!(
                    "{name} is missing at {}",
                    path.display()
                )));
            }
        }
        paths.load_runtime_secrets(state.kind)?;
        Ok(())
    }

    async fn checked(&self, request: CommandRequest) -> Result<CommandOutput, LocalBackendError> {
        let action = request.action.clone();
        let output = self.runner.run(request).await?;
        if output.success {
            Ok(output)
        } else {
            Err(LocalBackendError::CommandFailed {
                action,
                status: output
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "terminated".to_string()),
                output: output.summary(),
            })
        }
    }

    async fn checked_stack(
        &self,
        request: CommandRequest,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<CommandOutput, LocalBackendError> {
        match self.checked(request).await {
            Ok(mut output) => {
                let secrets = paths.load_runtime_secrets(state.kind)?;
                output.stdout = secrets.redact(&output.stdout);
                output.stderr = secrets.redact(&output.stderr);
                Ok(output)
            }
            Err(LocalBackendError::CommandFailed {
                action,
                status,
                output,
            }) => Err(LocalBackendError::CommandFailed {
                action,
                status,
                output: paths.load_runtime_secrets(state.kind)?.redact(&output),
            }),
            Err(LocalBackendError::CommandTimedOut {
                action,
                timeout_seconds,
                output,
            }) => Err(LocalBackendError::CommandTimedOut {
                action,
                timeout_seconds,
                output: paths.load_runtime_secrets(state.kind)?.redact(&output),
            }),
            Err(error) => Err(error),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawServiceStatus {
    name: String,
    service: String,
    state: String,
    #[serde(default)]
    health: String,
    #[serde(default)]
    exit_code: Option<i32>,
}

fn parse_service_statuses(output: &str) -> Result<Vec<ServiceStatus>, LocalBackendError> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<RawServiceStatus> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed)
    } else {
        trimmed.lines().map(serde_json::from_str).collect()
    }
    .map_err(|error| {
        LocalBackendError::InvalidState(format!("could not parse Docker Compose status: {error}"))
    })?;
    Ok(raw
        .into_iter()
        .map(|service| ServiceStatus {
            name: service.name,
            service: service.service,
            state: service.state,
            health: (!service.health.is_empty()).then_some(service.health),
            exit_code: service.exit_code,
        })
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct LegacyContainerInspect {
    image: String,
    #[serde(default)]
    env: Vec<String>,
    project: String,
    service: String,
    #[serde(default)]
    port_bindings: HashMap<String, Option<Vec<PortBinding>>>,
    mounts: Vec<ContainerMount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PortBinding {
    #[serde(default)]
    host_ip: String,
    host_port: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ContainerMount {
    #[serde(rename = "Type")]
    mount_type: String,
    name: Option<String>,
    destination: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct LegacyVolumeInspect {
    name: String,
    project: Option<String>,
    volume: Option<String>,
}

fn parse_legacy_inspection(output: &str) -> Result<Vec<LegacyContainerInspect>, serde_json::Error> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(serde_json::from_str)
        .collect()
}

fn validate_legacy_containers(
    containers: &[LegacyContainerInspect],
) -> Result<LegacyStackCandidate, String> {
    let mut by_service: HashMap<&str, &LegacyContainerInspect> = HashMap::new();
    for container in containers {
        if container.project != LEGACY_PROJECT {
            return Err("a container has a different Compose project label".to_string());
        }
        let service = container.service.as_str();
        if !matches!(service, "postgres" | "sacrum") {
            return Err(format!(
                "unexpected service '{service}' is attached to vertebrae-dev"
            ));
        }
        if by_service.insert(service, container).is_some() {
            return Err(format!("multiple '{service}' containers were found"));
        }
    }
    let postgres = by_service
        .get("postgres")
        .ok_or_else(|| "the postgres service is missing".to_string())?;
    let sacrum = by_service
        .get("sacrum")
        .ok_or_else(|| "the sacrum service is missing".to_string())?;

    if postgres.image != LEGACY_POSTGRES_IMAGE {
        return Err(format!(
            "postgres must keep {LEGACY_POSTGRES_IMAGE}; found {}",
            postgres.image
        ));
    }
    let volume_matches = postgres.mounts.iter().any(|mount| {
        mount.mount_type == "volume"
            && mount.name.as_deref() == Some(LEGACY_VOLUME)
            && mount.destination == "/var/lib/postgresql/data"
    });
    if !volume_matches {
        return Err(
            "postgres does not mount vertebrae-dev_pgdata at /var/lib/postgresql/data".to_string(),
        );
    }

    let postgres_env = environment_map(&postgres.env)?;
    if postgres_env.get("POSTGRES_USER").map(String::as_str) != Some("postgres")
        || postgres_env.get("POSTGRES_DB").map(String::as_str) != Some("sacrum_prod")
    {
        return Err("postgres user or database does not match the supported contract".to_string());
    }
    let postgres_password = postgres_env
        .get("POSTGRES_PASSWORD")
        .ok_or_else(|| "postgres has no POSTGRES_PASSWORD".to_string())?;
    let sacrum_env = environment_map(&sacrum.env)?;
    let secret_key_base = sacrum_env
        .get("SECRET_KEY_BASE")
        .ok_or_else(|| "sacrum has no SECRET_KEY_BASE".to_string())?;
    let expected_database_url = format!("ecto://postgres:{postgres_password}@postgres/sacrum_prod");
    if sacrum_env.get("DATABASE_URL") != Some(&expected_database_url) {
        return Err("sacrum DATABASE_URL does not match the legacy postgres service".to_string());
    }

    let bindings = sacrum
        .port_bindings
        .get("4000/tcp")
        .and_then(Option::as_ref)
        .ok_or_else(|| "sacrum does not publish container port 4000".to_string())?;
    if bindings.len() != 1 {
        return Err("sacrum must have exactly one host binding for port 4000".to_string());
    }
    let host_port = bindings[0]
        .host_port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| "sacrum has an invalid host port".to_string())?;
    let bind_host = bindings[0].host_ip.clone();
    if !matches!(bind_host.as_str(), "" | "0.0.0.0" | "127.0.0.1") {
        return Err(format!(
            "sacrum has an unsupported host binding address '{bind_host}'"
        ));
    }
    let secrets = RuntimeSecrets::legacy(postgres_password, secret_key_base)
        .map_err(|error| error.to_string())?;
    Ok(LegacyStackCandidate {
        host_port,
        bind_host,
        secrets,
    })
}

fn environment_map(values: &[String]) -> Result<HashMap<String, String>, String> {
    let mut environment = HashMap::new();
    for value in values {
        let (name, value) = value
            .split_once('=')
            .ok_or_else(|| "a container environment entry is malformed".to_string())?;
        if environment
            .insert(name.to_string(), value.to_string())
            .is_some()
        {
            return Err(format!(
                "container environment contains duplicate key '{name}'"
            ));
        }
    }
    Ok(environment)
}

#[cfg(test)]
mod tests {
    use super::super::state::select_host_port;
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    const DIGEST_IMAGE: &str =
        "ghcr.io/camonz/sacrum@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[derive(Clone, Default)]
    struct MockRunner {
        requests: Arc<Mutex<Vec<CommandRequest>>>,
        outputs: Arc<Mutex<VecDeque<CommandOutput>>>,
    }

    impl MockRunner {
        fn with_outputs(outputs: impl IntoIterator<Item = CommandOutput>) -> Self {
            Self {
                requests: Arc::default(),
                outputs: Arc::new(Mutex::new(outputs.into_iter().collect())),
            }
        }

        fn requests(&self) -> Vec<CommandRequest> {
            self.requests.lock().expect("requests lock").clone()
        }
    }

    #[async_trait]
    impl ProcessRunner for MockRunner {
        async fn run(&self, request: CommandRequest) -> Result<CommandOutput, LocalBackendError> {
            self.requests.lock().expect("requests lock").push(request);
            Ok(self
                .outputs
                .lock()
                .expect("outputs lock")
                .pop_front()
                .expect("mock output"))
        }
    }

    #[derive(Clone, Default)]
    struct MockHealth {
        results: Arc<Mutex<VecDeque<bool>>>,
    }

    impl MockHealth {
        fn with_results(results: impl IntoIterator<Item = bool>) -> Self {
            Self {
                results: Arc::new(Mutex::new(results.into_iter().collect())),
            }
        }
    }

    #[async_trait]
    impl HealthProbe for MockHealth {
        async fn is_healthy(&self, _url: &str) -> bool {
            self.results
                .lock()
                .expect("health lock")
                .pop_front()
                .unwrap_or(false)
        }
    }

    fn ready_stack() -> (tempfile::TempDir, ManagedStackPaths, ManagedStackState) {
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let state =
            ManagedStackState::fresh(DIGEST_IMAGE, 4400, BackendImageChannel::BackendRelease)
                .expect("valid state");
        paths.install_assets().expect("install assets");
        paths
            .ensure_runtime_secrets(
                &RuntimeSecrets::new(
                    "postgres-password-0123456789abcdef0123456789abcdef",
                    "secret-key-base-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                )
                .expect("valid secrets"),
                state.kind,
            )
            .expect("persist secrets");
        (temp, paths, state)
    }

    fn prerequisites() -> [CommandOutput; 2] {
        [
            CommandOutput::success("27.0.0"),
            CommandOutput::success("2.30.0"),
        ]
    }

    #[tokio::test]
    async fn detached_up_uses_app_assets_and_returns_structured_status() {
        let (_temp, paths, state) = ready_stack();
        let status_json = r#"[{"Name":"vertebrae-local-postgres-1","Service":"postgres","State":"running","Health":"healthy","ExitCode":0},{"Name":"vertebrae-local-sacrum-1","Service":"sacrum","State":"running","Health":"healthy","ExitCode":0}]"#;
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(status_json),
        ]));
        let controller = DockerCompose::new(runner.clone(), MockHealth::default());

        let status = controller
            .up_detached(&paths, &state)
            .await
            .expect("start stack");

        assert_eq!(status.len(), 2);
        assert_eq!(status[0].service, "postgres");
        assert_eq!(status[0].health.as_deref(), Some("healthy"));
        assert_eq!(status[1].service, "sacrum");
        let requests = runner.requests();
        let up = &requests[3];
        assert!(up.args_as_strings().ends_with(&[
            "up".to_string(),
            "--detach".to_string(),
            "--pull".to_string(),
            "missing".to_string(),
            "postgres".to_string(),
            "sacrum".to_string(),
        ]));
        assert_eq!(
            up.env_value("POSTGRES_IMAGE_REF"),
            Some(std::ffi::OsStr::new("postgres:18-alpine"))
        );
        assert_eq!(
            up.env_value("POSTGRES_VOLUME"),
            Some(std::ffi::OsStr::new("vertebrae-local_pgdata"))
        );
        assert_eq!(
            up.env_value("POSTGRES_DATA_PATH"),
            Some(std::ffi::OsStr::new("/var/lib/postgresql"))
        );
        assert_eq!(
            up.env_value("POSTGRES_PASSWORD"),
            Some(std::ffi::OsStr::new(
                "postgres-password-0123456789abcdef0123456789abcdef"
            ))
        );
        assert_eq!(
            up.env_value("SECRET_KEY_BASE"),
            Some(std::ffi::OsStr::new(
                "secret-key-base-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            ))
        );
        assert_eq!(
            up.env_value("SACRUM_BIND_PREFIX"),
            Some(std::ffi::OsStr::new("127.0.0.1:"))
        );
        assert!(requests.iter().all(|request| {
            !request
                .args_as_strings()
                .iter()
                .any(|argument| argument == "down")
        }));
    }

    #[tokio::test]
    async fn unavailable_compose_fails_before_stack_commands() {
        let runner = MockRunner::with_outputs([
            CommandOutput::success("27.0.0"),
            CommandOutput::failure(1, "compose is not a docker command"),
        ]);
        let controller = DockerCompose::new(runner.clone(), MockHealth::default());

        let error = controller
            .check_prerequisites()
            .await
            .expect_err("compose should be unavailable");

        assert!(matches!(error, LocalBackendError::ComposeUnavailable(_)));
        assert_eq!(runner.requests().len(), 2);
    }

    #[tokio::test]
    async fn health_timeout_returns_bounded_service_logs() {
        let (_temp, paths, state) = ready_stack();
        let runner = MockRunner::with_outputs([CommandOutput::success(
            "postgres-password-0123456789abcdef0123456789abcdef\nsecret-key-base-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )]);
        let controller = DockerCompose::new(runner, MockHealth::with_results([false, false]))
            .with_timeouts(
                Duration::from_secs(1),
                Duration::from_millis(1),
                Duration::from_millis(1),
            );

        let error = controller
            .wait_until_healthy(&paths, &state)
            .await
            .expect_err("health should time out");

        let LocalBackendError::HealthTimedOut { url, logs, .. } = error else {
            panic!("expected health timeout");
        };
        assert_eq!(url, "http://localhost:4400/healthz");
        assert_eq!(logs.matches("[redacted]").count(), 2, "{logs}");
        assert!(!logs.contains("postgres-password"), "{logs}");
        assert!(!logs.contains("secret-key-base"), "{logs}");
    }

    #[tokio::test]
    async fn health_polling_stops_after_success() {
        let (_temp, paths, state) = ready_stack();
        let controller = DockerCompose::new(
            MockRunner::default(),
            MockHealth::with_results([false, true]),
        )
        .with_timeouts(
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_millis(1),
        );

        controller
            .wait_until_healthy(&paths, &state)
            .await
            .expect("health should succeed");
    }

    #[tokio::test]
    async fn compose_failure_redacts_persisted_secrets() {
        let (_temp, paths, state) = ready_stack();
        let postgres_password = paths
            .load_runtime_secrets(state.kind)
            .expect("load secrets")
            .postgres_password()
            .to_string();
        let secret_key_base = paths
            .load_runtime_secrets(state.kind)
            .expect("load secrets")
            .secret_key_base()
            .to_string();
        let runner =
            MockRunner::with_outputs(prerequisites().into_iter().chain([CommandOutput::failure(
                1,
                format!("POSTGRES_PASSWORD={postgres_password} SECRET_KEY_BASE={secret_key_base}"),
            )]));
        let controller = DockerCompose::new(runner.clone(), MockHealth::default());

        let error = controller
            .up_detached(&paths, &state)
            .await
            .expect_err("config should fail");

        let message = error.to_string();
        assert_eq!(message.matches("[redacted]").count(), 2, "{message}");
        assert!(!message.contains(&postgres_password), "{message}");
        assert!(!message.contains(&secret_key_base), "{message}");
        let request = &runner.requests()[2];
        assert_eq!(
            request.env_value("POSTGRES_PASSWORD"),
            Some(std::ffi::OsStr::new(&postgres_password))
        );
        assert_eq!(
            request.env_value("SECRET_KEY_BASE"),
            Some(std::ffi::OsStr::new(&secret_key_base))
        );
    }

    #[tokio::test]
    async fn large_projected_legacy_metadata_is_not_limited_to_default_capture_size() {
        let inspect = legacy_inspect_json_with(
            LEGACY_POSTGRES_IMAGE,
            LEGACY_VOLUME,
            "127.0.0.1",
            Some(format!("IRRELEVANT={}", "x".repeat(32 * 1024))),
        );
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success("postgres-id\nsacrum-id\n"),
            CommandOutput::success(inspect),
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
        ]));
        let controller = DockerCompose::new(runner.clone(), MockHealth::default());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect legacy");

        let LegacyStackDetection::Compatible(candidate) = detection else {
            panic!("expected compatible legacy stack");
        };
        assert_eq!(candidate.bind_host, "127.0.0.1");
        let inspect_request = &runner.requests()[3];
        assert_eq!(
            inspect_request.max_capture_bytes,
            LEGACY_INSPECT_CAPTURE_BYTES
        );
        let args = inspect_request.args_as_strings();
        assert_eq!(args[0], "inspect");
        assert_eq!(args[1], "--format");
        assert_eq!(args[2], LEGACY_INSPECT_FORMAT);
    }

    #[tokio::test]
    async fn truncated_legacy_metadata_is_rejected() {
        let mut inspect =
            CommandOutput::success(legacy_inspect_json(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME));
        inspect.truncated = true;
        let runner = MockRunner::with_outputs(
            prerequisites()
                .into_iter()
                .chain([CommandOutput::success("postgres-id\nsacrum-id\n"), inspect]),
        );
        let controller = DockerCompose::new(runner, MockHealth::default());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect legacy");

        assert!(matches!(
            detection,
            LegacyStackDetection::Unsafe(reason) if reason.contains("inspection limit")
        ));
    }

    #[tokio::test]
    async fn preserved_labeled_volume_requires_explicit_runtime_details() {
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success(""),
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
        ]));
        let controller = DockerCompose::new(runner.clone(), MockHealth::default());
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect preserved volume");

        assert!(matches!(
            detection,
            LegacyStackDetection::RuntimeDetailsRequired
        ));
        let error = controller
            .adopt_legacy_stack(
                &paths,
                &detection,
                None,
                DIGEST_IMAGE,
                BackendImageChannel::BackendRelease,
                true,
            )
            .expect_err("runtime details are required");
        assert!(matches!(
            error,
            LocalBackendError::LegacyRuntimeDetailsRequired
        ));
        assert!(!paths.root.exists());
        assert!(runner.requests().iter().all(|request| {
            request
                .args_as_strings()
                .iter()
                .all(|argument| !matches!(argument.as_str(), "up" | "down" | "rm"))
        }));

        let details = LegacyRuntimeDetails::new(
            4400,
            "postgres",
            "dev-secret-key-base-that-is-at-least-64-bytes-long-for-phoenix-app",
        )
        .expect("valid legacy details");
        let state = controller
            .adopt_legacy_stack(
                &paths,
                &detection,
                Some(&details),
                DIGEST_IMAGE,
                BackendImageChannel::BackendRelease,
                true,
            )
            .expect("adopt preserved volume");
        assert_eq!(state.host_port, 4400);
        assert_eq!(
            state.provisioning_state,
            super::super::state::ProvisioningState::Unverified
        );
        assert_eq!(state.sacrum_bind_host, "");
        assert_eq!(state.postgres_image_ref, LEGACY_POSTGRES_IMAGE);
    }

    #[tokio::test]
    async fn unrelated_same_named_volume_is_unsafe() {
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success(""),
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("manual", "pgdata")),
        ]));
        let controller = DockerCompose::new(runner, MockHealth::default());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect unsafe volume");

        assert!(matches!(
            detection,
            LegacyStackDetection::Unsafe(reason) if reason.contains("expected Compose")
        ));
    }

    #[tokio::test]
    async fn unsupported_legacy_host_binding_is_rejected() {
        let inspect =
            legacy_inspect_json_with(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME, "192.168.1.10", None);
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success("postgres-id\nsacrum-id\n"),
            CommandOutput::success(inspect),
        ]));
        let controller = DockerCompose::new(runner, MockHealth::default());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect unsafe binding");

        assert!(matches!(
            detection,
            LegacyStackDetection::Unsafe(reason) if reason.contains("192.168.1.10")
        ));
    }

    #[tokio::test]
    async fn compatible_legacy_stack_is_adopted_without_changing_its_v17_volume() {
        let inspect = legacy_inspect_json(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME);
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success("postgres-id\nsacrum-id\n"),
            CommandOutput::success(inspect),
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
        ]));
        let controller = DockerCompose::new(runner, MockHealth::default());
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect legacy");
        let LegacyStackDetection::Compatible(_) = detection else {
            panic!("expected compatible legacy stack");
        };
        let unconfirmed = controller.adopt_legacy_stack(
            &paths,
            &detection,
            None,
            DIGEST_IMAGE,
            BackendImageChannel::BackendRelease,
            false,
        );
        assert!(matches!(
            unconfirmed,
            Err(LocalBackendError::AdoptionNotConfirmed)
        ));
        assert!(!paths.root.exists());

        let state = controller
            .adopt_legacy_stack(
                &paths,
                &detection,
                None,
                DIGEST_IMAGE,
                BackendImageChannel::BackendRelease,
                true,
            )
            .expect("adopt legacy");

        assert_eq!(state.kind, StackKind::AdoptedLegacy);
        assert_eq!(state.project_name, "vertebrae-dev");
        assert_eq!(state.postgres_volume, "vertebrae-dev_pgdata");
        assert_eq!(state.postgres_image_ref, "postgres:17-alpine");
        assert_eq!(state.host_port, 4400);
        assert_eq!(state.sacrum_bind_host, "");
        assert_eq!(
            state.provisioning_state,
            super::super::state::ProvisioningState::Unverified
        );
        assert_eq!(
            paths
                .load_runtime_secrets(StackKind::AdoptedLegacy)
                .expect("load adopted secrets")
                .postgres_password(),
            "postgres"
        );
    }

    #[tokio::test]
    async fn legacy_stack_with_a_postgres_image_mismatch_is_left_untouched() {
        let inspect = legacy_inspect_json("postgres:18-alpine", LEGACY_VOLUME);
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success("postgres-id\nsacrum-id\n"),
            CommandOutput::success(inspect),
        ]));
        let controller = DockerCompose::new(runner, MockHealth::default());
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect unsafe legacy");

        assert!(matches!(
            detection,
            LegacyStackDetection::Unsafe(reason) if reason.contains("postgres:17-alpine")
        ));
        assert!(!paths.root.exists());
    }

    #[tokio::test]
    #[ignore = "requires Docker and VERTEBRAE_TEST_SACRUM_IMAGE_REF"]
    async fn docker_smoke_stack_survives_controller_recreation_and_reuses_volume() {
        let image_ref = std::env::var("VERTEBRAE_TEST_SACRUM_IMAGE_REF")
            .expect("set VERTEBRAE_TEST_SACRUM_IMAGE_REF to an official digest-pinned image");
        let suffix = Uuid::new_v4().simple().to_string();
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let state = ManagedStackState::isolated_test_stack(
            image_ref,
            select_host_port(0).expect("select host port"),
            &suffix,
        )
        .expect("valid isolated stack");
        paths.install_assets().expect("install assets");
        paths
            .ensure_runtime_secrets(
                &RuntimeSecrets::generate().expect("generate secrets"),
                state.kind,
            )
            .expect("persist runtime secrets");

        let outcome = async {
            let first_controller = DockerCompose::system().with_timeouts(
                Duration::from_secs(180),
                Duration::from_secs(180),
                Duration::from_secs(2),
            );
            first_controller.up_detached(&paths, &state).await?;
            first_controller.wait_until_healthy(&paths, &state).await?;
            let first_status = first_controller.status(&paths, &state).await?;
            drop(first_controller);

            let second_controller = DockerCompose::system();
            let second_status = second_controller.status(&paths, &state).await?;
            let volume = SystemProcessRunner
                .run(CommandRequest::new(
                    "inspect smoke-test volume",
                    "docker",
                    ["volume", "inspect", state.postgres_volume.as_str()],
                    Duration::from_secs(30),
                ))
                .await?;
            Ok::<_, LocalBackendError>((first_status, second_status, volume.success))
        }
        .await;

        let cleanup = DockerCompose::system();
        if let Ok(request) = cleanup.compose_request(
            &paths,
            &state,
            "remove smoke-test stack",
            ["down", "--volumes", "--remove-orphans"],
        ) {
            let _ = cleanup.checked(request).await;
        }

        let (first_status, second_status, volume_exists) = outcome.expect("run Docker smoke test");
        let mut first_names: Vec<_> = first_status
            .iter()
            .filter(|service| matches!(service.service.as_str(), "postgres" | "sacrum"))
            .map(|service| service.name.clone())
            .collect();
        let mut second_names: Vec<_> = second_status
            .iter()
            .filter(|service| matches!(service.service.as_str(), "postgres" | "sacrum"))
            .map(|service| service.name.clone())
            .collect();
        first_names.sort();
        second_names.sort();
        assert_eq!(first_names.len(), 2);
        assert_eq!(first_names, second_names);
        assert!(second_status.iter().all(|service| {
            service.state == "running" && service.health.as_deref() == Some("healthy")
        }));
        assert!(volume_exists);
    }

    fn legacy_inspect_json(postgres_image: &str, volume: &str) -> String {
        legacy_inspect_json_with(postgres_image, volume, "", None)
    }

    fn legacy_inspect_json_with(
        postgres_image: &str,
        volume: &str,
        host_ip: &str,
        extra_environment: Option<String>,
    ) -> String {
        let mut postgres_environment = vec![
            "POSTGRES_USER=postgres".to_string(),
            "POSTGRES_PASSWORD=postgres".to_string(),
            "POSTGRES_DB=sacrum_prod".to_string(),
        ];
        postgres_environment.extend(extra_environment);
        let postgres = serde_json::json!({
            "Image": postgres_image,
            "Env": postgres_environment,
            "Project": "vertebrae-dev",
            "Service": "postgres",
            "PortBindings": {},
            "Mounts": [{
                "Type": "volume",
                "Name": volume,
                "Destination": "/var/lib/postgresql/data"
            }]
        });
        let sacrum = serde_json::json!({
            "Image": "ghcr.io/camonz/sacrum:latest",
            "Env": [
                "DATABASE_URL=ecto://postgres:postgres@postgres/sacrum_prod",
                "SECRET_KEY_BASE=dev-secret-key-base-that-is-at-least-64-bytes-long-for-phoenix-app"
            ],
            "Project": "vertebrae-dev",
            "Service": "sacrum",
            "PortBindings": {
                "4000/tcp": [{ "HostIp": host_ip, "HostPort": "4400" }]
            },
            "Mounts": []
        });
        format!("{postgres}\n{sacrum}\n")
    }

    fn legacy_volume_inspect(project: &str, volume: &str) -> String {
        serde_json::json!({
            "Name": "vertebrae-dev_pgdata",
            "Project": project,
            "Volume": volume,
        })
        .to_string()
    }
}
