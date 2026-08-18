use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;

use super::command::{
    discover_docker_cli, CommandOutput, CommandRequest, ProcessRunner, SystemProcessRunner,
};
use super::state::{
    BackendImageChannel, DockerTarget, LocalBackendError, ManagedStackPaths, ManagedStackState,
    RuntimeSecrets, StackKind, LEGACY_POSTGRES_IMAGE, LEGACY_PROJECT, LEGACY_VOLUME,
};

const QUICK_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const RECONCILE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(2);
const MINIMUM_SAFE_ENGINE_MAJOR: u64 = 28;
const LEGACY_INSPECT_FORMAT: &str = r#"{"Image":{{json .Config.Image}},"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"Service":{{json (index .Config.Labels "com.docker.compose.service")}},"PortBindings":{{json .HostConfig.PortBindings}},"Mounts":{{json .Mounts}}}"#;
const LEGACY_VOLUME_INSPECT_FORMAT: &str = r#"{"Name":{{json .Name}},"Project":{{json (index .Labels "com.docker.compose.project")}},"Volume":{{json (index .Labels "com.docker.compose.volume")}}}"#;
const DOCKER_ENV_REMOVE: [&str; 8] = [
    "DOCKER_API_VERSION",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_AUTH_CONFIG",
];

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyStackCandidate {
    pub host_port: u16,
    bind_host: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyStackDetection {
    Absent,
    Compatible(LegacyStackCandidate),
    HostPortRequired,
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
    docker_cli: PathBuf,
    target: DockerTarget,
    quick_timeout: Duration,
    reconcile_timeout: Duration,
    health_timeout: Duration,
    health_poll_interval: Duration,
}

#[derive(Debug)]
struct DockerPrerequisites {
    engine_version: String,
    engine_major: u64,
}

async fn resolve_docker_target<R: ProcessRunner>(
    runner: &R,
    docker_cli: &Path,
    timeout: Duration,
) -> Result<DockerTarget, LocalBackendError> {
    let shown = runner
        .run(sanitized_docker_request(
            "resolve Docker context",
            docker_cli,
            ["context", "show"],
            timeout,
        ))
        .await?;
    if !shown.success {
        return Err(LocalBackendError::DockerDaemonUnreachable(shown.summary()));
    }
    let name = shown.stdout.trim();
    if name.is_empty() {
        return Err(LocalBackendError::DockerDaemonUnreachable(
            "Docker returned an empty context name".to_string(),
        ));
    }
    inspect_docker_target(runner, docker_cli, name, timeout).await
}

async fn inspect_docker_target<R: ProcessRunner>(
    runner: &R,
    docker_cli: &Path,
    name: &str,
    timeout: Duration,
) -> Result<DockerTarget, LocalBackendError> {
    let inspected = runner
        .run(sanitized_docker_request(
            "inspect Docker context",
            docker_cli,
            [
                "--context",
                name,
                "context",
                "inspect",
                name,
                "--format",
                "{{.Endpoints.docker.Host}}",
            ],
            timeout,
        ))
        .await?;
    if !inspected.success {
        return Err(LocalBackendError::DockerDaemonUnreachable(
            inspected.summary(),
        ));
    }
    DockerTarget::new(name, inspected.stdout.trim())
}

fn sanitized_docker_request(
    action: &str,
    docker_cli: &Path,
    args: impl IntoIterator<Item = impl Into<OsString>>,
    timeout: Duration,
) -> CommandRequest {
    CommandRequest::new(action, docker_cli.as_os_str(), args, timeout)
        .with_env_removed(DOCKER_ENV_REMOVE)
}

impl DockerCompose<SystemProcessRunner, ReqwestHealthProbe> {
    pub async fn system() -> Result<Self, LocalBackendError> {
        Self::connect(
            SystemProcessRunner,
            ReqwestHealthProbe::default(),
            discover_docker_cli()?,
        )
        .await
    }

    pub fn system_for(target: DockerTarget) -> Result<Self, LocalBackendError> {
        target.validate()?;
        Ok(Self::new(
            SystemProcessRunner,
            ReqwestHealthProbe::default(),
            discover_docker_cli()?,
            target,
        ))
    }
}

impl<R, H> DockerCompose<R, H>
where
    R: ProcessRunner,
    H: HealthProbe,
{
    pub async fn connect(
        runner: R,
        health_probe: H,
        docker_cli: PathBuf,
    ) -> Result<Self, LocalBackendError> {
        if !docker_cli.is_absolute() {
            return Err(LocalBackendError::InvalidState(
                "Docker CLI path must be absolute".to_string(),
            ));
        }
        let target = resolve_docker_target(&runner, &docker_cli, QUICK_COMMAND_TIMEOUT).await?;
        Ok(Self::new(runner, health_probe, docker_cli, target))
    }

    pub fn new(runner: R, health_probe: H, docker_cli: PathBuf, target: DockerTarget) -> Self {
        Self {
            runner,
            health_probe,
            docker_cli,
            target,
            quick_timeout: QUICK_COMMAND_TIMEOUT,
            reconcile_timeout: RECONCILE_TIMEOUT,
            health_timeout: HEALTH_TIMEOUT,
            health_poll_interval: HEALTH_POLL_INTERVAL,
        }
    }

    pub fn with_timeouts(
        mut self,
        quick_timeout: Duration,
        reconcile_timeout: Duration,
        health_timeout: Duration,
        health_poll_interval: Duration,
    ) -> Self {
        self.quick_timeout = quick_timeout;
        self.reconcile_timeout = reconcile_timeout;
        self.health_timeout = health_timeout;
        self.health_poll_interval = health_poll_interval;
        self
    }

    pub fn target(&self) -> &DockerTarget {
        &self.target
    }

    async fn check_prerequisites(&self) -> Result<DockerPrerequisites, LocalBackendError> {
        self.revalidate_context().await?;
        let docker = self
            .runner
            .run(self.docker_request(
                "check Docker",
                ["version", "--format", "{{.Server.Version}}"],
                self.quick_timeout,
            ))
            .await?;
        if !docker.success {
            let output = docker.summary();
            let normalized = output.to_ascii_lowercase();
            return if normalized.contains("permission denied")
                || normalized.contains("access is denied")
            {
                Err(LocalBackendError::DockerDaemonPermissionDenied(output))
            } else {
                Err(LocalBackendError::DockerDaemonUnreachable(output))
            };
        }
        let engine_version = docker.stdout.trim().to_string();
        let engine_major = engine_version
            .split('.')
            .next()
            .and_then(|major| major.parse::<u64>().ok())
            .ok_or_else(|| {
                LocalBackendError::DockerDaemonUnreachable(format!(
                    "Docker returned invalid Engine version '{engine_version}'"
                ))
            })?;

        let compose = self
            .runner
            .run(self.docker_request(
                "check Docker Compose",
                ["compose", "version", "--short"],
                self.quick_timeout,
            ))
            .await?;
        if !compose.success {
            return Err(LocalBackendError::ComposeUnavailable(compose.summary()));
        }
        Ok(DockerPrerequisites {
            engine_version,
            engine_major,
        })
    }

    async fn revalidate_context(&self) -> Result<(), LocalBackendError> {
        let actual = inspect_docker_target(
            &self.runner,
            &self.docker_cli,
            &self.target.name,
            self.quick_timeout,
        )
        .await?;
        if actual != self.target {
            return Err(LocalBackendError::DockerContextChanged {
                expected_name: self.target.name.clone(),
                expected_endpoint: self.target.endpoint.clone(),
                actual_name: actual.name,
                actual_endpoint: actual.endpoint,
            });
        }
        Ok(())
    }

    fn docker_request(
        &self,
        action: &str,
        args: impl IntoIterator<Item = impl Into<OsString>>,
        timeout: Duration,
    ) -> CommandRequest {
        let mut contextual_args = vec![
            OsString::from("--context"),
            OsString::from(&self.target.name),
        ];
        contextual_args.extend(args.into_iter().map(Into::into));
        sanitized_docker_request(action, &self.docker_cli, contextual_args, timeout)
    }

    pub async fn up_detached(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        let prerequisites = self.check_prerequisites().await?;
        let secrets = self.validate_stack_files(paths, state)?;
        if state.kind == StackKind::Managed
            && prerequisites.engine_major < MINIMUM_SAFE_ENGINE_MAJOR
        {
            return Err(LocalBackendError::UnsupportedEngineVersion {
                found: prerequisites.engine_version,
                minimum: MINIMUM_SAFE_ENGINE_MAJOR,
            });
        }
        self.validate_persistent_volume(state).await?;
        self.checked_stack(
            self.compose_request(
                paths,
                state,
                "validate Compose configuration",
                ["config", "--quiet"],
                self.quick_timeout,
            ),
            &secrets,
        )
        .await?;
        let result = self
            .checked_stack(
                self.compose_request(
                    paths,
                    state,
                    "start local Sacrum",
                    ["up", "--detach", "--pull", "missing", "postgres", "sacrum"],
                    self.reconcile_timeout,
                ),
                &secrets,
            )
            .await;
        if let Err(error) = result {
            return Err(classify_port_error(error, state.host_port));
        }
        if !state.postgres_volume_initialized {
            let volume = state.postgres_volume();
            if !self.named_volume_exists(&volume).await? {
                return Err(LocalBackendError::PersistentVolumeUnavailable {
                    volume,
                    reason: "Docker Compose completed without creating the database volume"
                        .to_string(),
                });
            }
            state.postgres_volume_initialized = true;
            paths.save_state(state)?;
        }
        self.status_without_prerequisite(paths, state, &secrets)
            .await
    }

    pub async fn status(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.check_prerequisites().await?;
        let secrets = self.validate_stack_files(paths, state)?;
        self.status_without_prerequisite(paths, state, &secrets)
            .await
    }

    pub async fn wait_until_healthy(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        self.revalidate_context().await?;
        let secrets = self.validate_stack_files(paths, state)?;
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
                            self.quick_timeout,
                        ),
                        &secrets,
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

    async fn validate_persistent_volume(
        &self,
        state: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        match state.kind {
            StackKind::AdoptedLegacy => match self.legacy_volume_status().await? {
                LegacyVolumeStatus::Compatible => Ok(()),
                LegacyVolumeStatus::Absent => Err(LocalBackendError::PersistentVolumeUnavailable {
                    volume: LEGACY_VOLUME.to_string(),
                    reason: "the adopted legacy database volume is missing".to_string(),
                }),
                LegacyVolumeStatus::Unsafe(reason) => {
                    Err(LocalBackendError::PersistentVolumeUnavailable {
                        volume: LEGACY_VOLUME.to_string(),
                        reason,
                    })
                }
            },
            StackKind::Managed => {
                let volume = state.postgres_volume();
                let exists = self.named_volume_exists(&volume).await?;
                if !exists && state.postgres_volume_is_external() {
                    return Err(LocalBackendError::PersistentVolumeUnavailable {
                        volume,
                        reason: "a previously created database volume is missing; restore it or explicitly start over"
                            .to_string(),
                    });
                }
                Ok(())
            }
        }
    }

    async fn named_volume_exists(&self, volume: &str) -> Result<bool, LocalBackendError> {
        let output = self
            .checked(self.docker_request(
                "find local backend database volume",
                [
                    "volume",
                    "ls",
                    "--filter",
                    &format!("name={volume}"),
                    "--format",
                    "{{.Name}}",
                ],
                self.quick_timeout,
            ))
            .await?;
        Ok(output.stdout.lines().any(|name| name.trim() == volume))
    }

    pub async fn detect_legacy_stack(&self) -> Result<LegacyStackDetection, LocalBackendError> {
        self.check_prerequisites().await?;
        let containers = self
            .checked(self.docker_request(
                "find vertebrae-dev containers",
                [
                    "ps",
                    "--all",
                    "--filter",
                    "label=com.docker.compose.project=vertebrae-dev",
                    "--format",
                    "{{.ID}}",
                ],
                self.quick_timeout,
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
                LegacyVolumeStatus::Compatible => LegacyStackDetection::HostPortRequired,
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
            .run(self.docker_request(
                "inspect vertebrae-dev containers",
                inspect_args,
                self.quick_timeout,
            ))
            .await?;
        if !inspected.success {
            return Err(LocalBackendError::CommandFailed {
                action: "inspect vertebrae-dev containers".to_string(),
                status: inspected
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "terminated".to_string()),
                output: inspected.summary(),
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

    pub async fn adopt_legacy_stack(
        &self,
        paths: &ManagedStackPaths,
        detection: &LegacyStackDetection,
        legacy_host_port: Option<u16>,
        sacrum_image_ref: impl Into<String>,
        image_channel: BackendImageChannel,
        confirmed: bool,
    ) -> Result<ManagedStackState, LocalBackendError> {
        if !confirmed {
            return Err(LocalBackendError::AdoptionNotConfirmed);
        }
        let current = self.detect_legacy_stack().await?;
        if !legacy_evidence_matches(detection, &current) {
            return Err(LocalBackendError::UnsafeLegacyStack(
                "Docker state changed after adoption was offered".to_string(),
            ));
        }
        let candidate = match &current {
            LegacyStackDetection::Compatible(candidate) => candidate.clone(),
            LegacyStackDetection::HostPortRequired => {
                let host_port = legacy_host_port
                    .filter(|host_port| *host_port != 0)
                    .ok_or(LocalBackendError::LegacyHostPortRequired)?;
                LegacyStackCandidate {
                    host_port,
                    bind_host: String::new(),
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
        let legacy_secrets = RuntimeSecrets::legacy_development();
        if let Some(existing) = paths.load_state()? {
            if existing.kind != StackKind::AdoptedLegacy {
                return Err(LocalBackendError::UnsafeLegacyStack(
                    "a different managed local stack already exists".to_string(),
                ));
            }
            if existing.docker_target != self.target {
                return Err(LocalBackendError::UnsafeLegacyStack(
                    "saved Docker context does not match the adoption target".to_string(),
                ));
            }
            if paths.load_runtime_secrets(StackKind::AdoptedLegacy)? != legacy_secrets {
                return Err(LocalBackendError::UnsafeLegacyStack(
                    "saved runtime secrets do not match the supported development stack"
                        .to_string(),
                ));
            }
            return Ok(existing);
        }

        if paths.secrets_file.exists()
            && paths.load_runtime_secrets(StackKind::AdoptedLegacy)? != legacy_secrets
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
            self.target.clone(),
        )?;
        paths.install_assets()?;
        paths.ensure_runtime_secrets(&legacy_secrets, StackKind::AdoptedLegacy)?;
        paths.save_state(&state)?;
        Ok(state)
    }

    async fn legacy_volume_status(&self) -> Result<LegacyVolumeStatus, LocalBackendError> {
        let output = self
            .checked(self.docker_request(
                "find vertebrae-dev database volume",
                [
                    "volume",
                    "ls",
                    "--filter",
                    "name=vertebrae-dev_pgdata",
                    "--format",
                    "{{.Name}}",
                ],
                self.quick_timeout,
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
            .checked(self.docker_request(
                "inspect vertebrae-dev database volume",
                [
                    "volume",
                    "inspect",
                    "--format",
                    LEGACY_VOLUME_INSPECT_FORMAT,
                    LEGACY_VOLUME,
                ],
                self.quick_timeout,
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
        secrets: &RuntimeSecrets,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        let output = self
            .checked_stack(
                self.compose_request(
                    paths,
                    state,
                    "read local backend status",
                    ["ps", "--format", "json"],
                    self.quick_timeout,
                ),
                secrets,
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
        timeout: Duration,
    ) -> CommandRequest {
        let project_name = state.project_name();
        let postgres_volume = state.postgres_volume();
        let mut args = vec![
            "compose".into(),
            "--ansi".into(),
            "never".into(),
            "--project-directory".into(),
            paths.root.as_os_str().to_owned(),
            "--project-name".into(),
            project_name.into(),
            "--file".into(),
            paths.compose_file.as_os_str().to_owned(),
            "--env-file".into(),
            paths.secrets_file.as_os_str().to_owned(),
        ];
        args.extend(operation.into_iter().map(Into::into));
        self.docker_request(action, args, timeout)
            .with_env([
                (OsString::from("POSTGRES_VOLUME"), postgres_volume.into()),
                (
                    OsString::from("POSTGRES_VOLUME_EXTERNAL"),
                    state.postgres_volume_is_external().to_string().into(),
                ),
                (
                    OsString::from("POSTGRES_IMAGE_REF"),
                    state.postgres_image_ref().into(),
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
            ])
            .with_env_removed([
                "POSTGRES_PASSWORD",
                "SECRET_KEY_BASE",
                "COMPOSE_PROJECT_NAME",
            ])
    }

    fn validate_stack_files(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        state.validate()?;
        if state.docker_target != self.target {
            return Err(LocalBackendError::DockerContextChanged {
                expected_name: state.docker_target.name.clone(),
                expected_endpoint: state.docker_target.endpoint.clone(),
                actual_name: self.target.name.clone(),
                actual_endpoint: self.target.endpoint.clone(),
            });
        }
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
        paths.load_runtime_secrets(state.kind)
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
        secrets: &RuntimeSecrets,
    ) -> Result<CommandOutput, LocalBackendError> {
        match self.checked(request).await {
            Ok(mut output) => {
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
                output: secrets.redact(&output),
            }),
            Err(LocalBackendError::CommandTimedOut {
                action,
                timeout_seconds,
                output,
            }) => Err(LocalBackendError::CommandTimedOut {
                action,
                timeout_seconds,
                output: secrets.redact(&output),
            }),
            Err(error) => Err(error),
        }
    }
}

fn legacy_evidence_matches(offered: &LegacyStackDetection, current: &LegacyStackDetection) -> bool {
    match (offered, current) {
        (LegacyStackDetection::Compatible(offered), LegacyStackDetection::Compatible(current)) => {
            offered == current
        }
        (LegacyStackDetection::HostPortRequired, LegacyStackDetection::HostPortRequired) => true,
        (LegacyStackDetection::Absent, LegacyStackDetection::Absent) => true,
        (LegacyStackDetection::Unsafe(offered), LegacyStackDetection::Unsafe(current)) => {
            offered == current
        }
        _ => false,
    }
}

fn classify_port_error(error: LocalBackendError, port: u16) -> LocalBackendError {
    match error {
        LocalBackendError::CommandFailed { output, .. }
            if output
                .to_ascii_lowercase()
                .contains("port is already allocated")
                || output
                    .to_ascii_lowercase()
                    .contains("address already in use") =>
        {
            LocalBackendError::PortUnavailable { port, output }
        }
        error => error,
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
    Ok(LegacyStackCandidate {
        host_port,
        bind_host,
    })
}

#[cfg(test)]
mod tests {
    use super::super::state::select_host_port;
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

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

        fn push_outputs(&self, outputs: impl IntoIterator<Item = CommandOutput>) {
            self.outputs.lock().expect("outputs lock").extend(outputs);
        }
    }

    fn docker_target() -> DockerTarget {
        DockerTarget::new("desktop-linux", "unix:///tmp/docker.sock").expect("local target")
    }

    fn controller(runner: MockRunner, health: MockHealth) -> DockerCompose<MockRunner, MockHealth> {
        DockerCompose::new(
            runner,
            health,
            PathBuf::from("/opt/docker/bin/docker"),
            docker_target(),
        )
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
        let state = ManagedStackState::fresh(
            DIGEST_IMAGE,
            4400,
            BackendImageChannel::BackendRelease,
            docker_target(),
        )
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

    fn adopted_stack() -> (tempfile::TempDir, ManagedStackPaths, ManagedStackState) {
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let state = ManagedStackState::adopted_legacy(
            DIGEST_IMAGE,
            4400,
            "",
            BackendImageChannel::BackendRelease,
            docker_target(),
        )
        .expect("valid adopted state");
        paths.install_assets().expect("install assets");
        paths
            .ensure_runtime_secrets(&RuntimeSecrets::legacy_development(), state.kind)
            .expect("persist legacy secrets");
        (temp, paths, state)
    }

    fn prerequisites() -> [CommandOutput; 3] {
        [
            CommandOutput::success("unix:///tmp/docker.sock"),
            CommandOutput::success("28.0.0"),
            CommandOutput::success("2.30.0"),
        ]
    }

    fn running_legacy_outputs(inspect: String) -> Vec<CommandOutput> {
        prerequisites()
            .into_iter()
            .chain([
                CommandOutput::success("postgres-id\nsacrum-id\n"),
                CommandOutput::success(inspect),
                CommandOutput::success("vertebrae-dev_pgdata\n"),
                CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
            ])
            .collect()
    }

    fn volume_only_legacy_outputs() -> Vec<CommandOutput> {
        prerequisites()
            .into_iter()
            .chain([
                CommandOutput::success(""),
                CommandOutput::success("vertebrae-dev_pgdata\n"),
                CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
            ])
            .collect()
    }

    #[tokio::test]
    async fn controller_resolves_a_local_context_and_neutralizes_ambient_overrides() {
        let runner = MockRunner::with_outputs([
            CommandOutput::success("desktop-linux\n"),
            CommandOutput::success("unix:///tmp/docker.sock\n"),
        ]);

        let connected = DockerCompose::connect(
            runner.clone(),
            MockHealth::default(),
            PathBuf::from("/opt/docker/bin/docker"),
        )
        .await
        .expect("connect controller");

        assert_eq!(connected.target(), &docker_target());
        let requests = runner.requests();
        assert_eq!(requests[0].args_as_strings(), ["context", "show"]);
        assert_eq!(
            requests[1].args_as_strings()[..4],
            ["--context", "desktop-linux", "context", "inspect"]
        );
        for request in requests {
            for name in DOCKER_ENV_REMOVE {
                assert!(request.removes_env(name), "{name} must be sanitized");
            }
        }
    }

    #[tokio::test]
    async fn remote_docker_context_is_rejected_before_daemon_access() {
        let runner = MockRunner::with_outputs([
            CommandOutput::success("remote\n"),
            CommandOutput::success("ssh://builder.example/run/docker.sock\n"),
        ]);

        let result = DockerCompose::connect(
            runner.clone(),
            MockHealth::default(),
            PathBuf::from("/opt/docker/bin/docker"),
        )
        .await;
        let Err(error) = result else {
            panic!("remote context must be rejected");
        };

        assert!(matches!(
            error,
            LocalBackendError::UnsupportedDockerContext { name, endpoint }
                if name == "remote" && endpoint.starts_with("ssh://")
        ));
        assert_eq!(runner.requests().len(), 2);
    }

    #[tokio::test]
    async fn persisted_context_endpoint_is_revalidated() {
        let runner =
            MockRunner::with_outputs([CommandOutput::success("unix:///tmp/different-docker.sock")]);
        let controller = controller(runner.clone(), MockHealth::default());

        let error = controller
            .check_prerequisites()
            .await
            .expect_err("changed context must fail");

        assert!(matches!(
            error,
            LocalBackendError::DockerContextChanged { .. }
        ));
        assert_eq!(runner.requests().len(), 1);
    }

    #[tokio::test]
    async fn detached_up_uses_app_assets_and_returns_structured_status() {
        let (_temp, paths, mut state) = ready_stack();
        let postgres_volume = state.postgres_volume();
        let status_json = r#"[{"Name":"vertebrae-local-postgres-1","Service":"postgres","State":"running","Health":"healthy","ExitCode":0},{"Name":"vertebrae-local-sacrum-1","Service":"sacrum","State":"running","Health":"healthy","ExitCode":0}]"#;
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(format!("{postgres_volume}\n")),
            CommandOutput::success(status_json),
        ]));
        let controller = controller(runner.clone(), MockHealth::default());

        let status = controller
            .up_detached(&paths, &mut state)
            .await
            .expect("start stack");

        assert!(state.postgres_volume_initialized);
        assert_eq!(paths.load_state().expect("load state"), Some(state.clone()));
        assert_eq!(status.len(), 2);
        assert_eq!(status[0].service, "postgres");
        assert_eq!(status[0].health.as_deref(), Some("healthy"));
        assert_eq!(status[1].service, "sacrum");
        let requests = runner.requests();
        let up = &requests[5];
        assert_eq!(requests[4].timeout, QUICK_COMMAND_TIMEOUT);
        assert_eq!(up.timeout, RECONCILE_TIMEOUT);
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
            Some(std::ffi::OsStr::new(&postgres_volume))
        );
        assert_eq!(
            up.env_value("POSTGRES_VOLUME_EXTERNAL"),
            Some(std::ffi::OsStr::new("false"))
        );
        assert_eq!(
            up.env_value("POSTGRES_DATA_PATH"),
            Some(std::ffi::OsStr::new("/var/lib/postgresql"))
        );
        assert_eq!(up.env_value("POSTGRES_PASSWORD"), None);
        assert_eq!(up.env_value("SECRET_KEY_BASE"), None);
        assert!(up.removes_env("POSTGRES_PASSWORD"));
        assert!(up.removes_env("SECRET_KEY_BASE"));
        assert!(up.removes_env("DOCKER_HOST"));
        assert!(up.removes_env("DOCKER_CONTEXT"));
        for name in DOCKER_ENV_REMOVE {
            assert!(up.removes_env(name), "{name} must be sanitized");
        }
        assert!(requests.iter().all(|request| {
            request.program == std::ffi::OsStr::new("/opt/docker/bin/docker")
                && (request.action == "inspect Docker context"
                    || request
                        .args_as_strings()
                        .starts_with(&["--context".to_string(), "desktop-linux".to_string()]))
        }));
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
            CommandOutput::success("unix:///tmp/docker.sock"),
            CommandOutput::success("28.0.0"),
            CommandOutput::failure(1, "compose is not a docker command"),
        ]);
        let controller = controller(runner.clone(), MockHealth::default());

        let error = controller
            .check_prerequisites()
            .await
            .expect_err("compose should be unavailable");

        assert!(matches!(error, LocalBackendError::ComposeUnavailable(_)));
        assert_eq!(runner.requests().len(), 3);
    }

    #[tokio::test]
    async fn unsupported_engine_blocks_fresh_mutation_but_not_diagnosis() {
        let (_temp, paths, mut state) = ready_stack();
        let runner = MockRunner::with_outputs([
            CommandOutput::success("unix:///tmp/docker.sock"),
            CommandOutput::success("27.5.1"),
            CommandOutput::success("2.30.0"),
        ]);
        let controller = controller(runner.clone(), MockHealth::default());

        let error = controller
            .up_detached(&paths, &mut state)
            .await
            .expect_err("Engine 27 must not mutate a fresh stack");

        assert!(matches!(
            error,
            LocalBackendError::UnsupportedEngineVersion { found, minimum: 28 }
                if found == "27.5.1"
        ));
        assert_eq!(runner.requests().len(), 3);
    }

    #[tokio::test]
    async fn daemon_permission_and_connectivity_failures_are_distinct() {
        for (message, permission_denied) in [
            ("permission denied while connecting to Docker", true),
            ("Cannot connect to the Docker daemon", false),
        ] {
            let runner = MockRunner::with_outputs([
                CommandOutput::success("unix:///tmp/docker.sock"),
                CommandOutput::failure(1, message),
            ]);
            let controller = controller(runner, MockHealth::default());

            let error = controller
                .check_prerequisites()
                .await
                .expect_err("daemon check must fail");

            assert_eq!(
                matches!(error, LocalBackendError::DockerDaemonPermissionDenied(_)),
                permission_denied
            );
            assert_eq!(
                matches!(error, LocalBackendError::DockerDaemonUnreachable(_)),
                !permission_denied
            );
        }
    }

    #[tokio::test]
    async fn previously_created_managed_state_refuses_a_missing_volume() {
        let (_temp, paths, mut state) = ready_stack();
        state.provisioning_state = super::super::state::ProvisioningState::Failed;
        state.postgres_volume_initialized = true;
        let runner = MockRunner::with_outputs(
            prerequisites()
                .into_iter()
                .chain([CommandOutput::success("")]),
        );
        let controller = controller(runner.clone(), MockHealth::default());

        let error = controller
            .up_detached(&paths, &mut state)
            .await
            .expect_err("missing durable data must not be recreated");

        assert!(matches!(
            error,
            LocalBackendError::PersistentVolumeUnavailable { volume, .. }
                if volume == state.postgres_volume()
        ));
        assert!(runner.requests().iter().all(|request| {
            !request
                .args_as_strings()
                .iter()
                .any(|argument| argument == "up")
        }));
    }

    #[tokio::test]
    async fn provisioning_failure_before_volume_creation_remains_retryable() {
        for provisioning_state in [
            super::super::state::ProvisioningState::InProgress,
            super::super::state::ProvisioningState::Failed,
        ] {
            let (_temp, paths, mut state) = ready_stack();
            state.provisioning_state = provisioning_state;
            let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
                CommandOutput::success(""),
                CommandOutput::failure(1, "retry reached Compose validation"),
            ]));
            let controller = controller(runner.clone(), MockHealth::default());

            let error = controller
                .up_detached(&paths, &mut state)
                .await
                .expect_err("test Compose validation failure");

            assert!(matches!(
                error,
                LocalBackendError::CommandFailed { output, .. }
                    if output.contains("retry reached Compose validation")
            ));
            assert!(!state.postgres_volume_initialized);
            assert!(runner.requests()[4]
                .args_as_strings()
                .ends_with(&["config".to_string(), "--quiet".to_string()]));
        }
    }

    #[tokio::test]
    async fn adopted_mutation_requires_the_compatible_external_volume() {
        let (_temp, paths, mut state) = adopted_stack();
        let status_json = r#"[{"Name":"vertebrae-dev-postgres-1","Service":"postgres","State":"running","Health":"healthy","ExitCode":0}]"#;
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(status_json),
        ]));
        let controller = controller(runner.clone(), MockHealth::default());

        controller
            .up_detached(&paths, &mut state)
            .await
            .expect("reconcile adopted stack");

        let requests = runner.requests();
        let up = &requests[6];
        assert_eq!(
            up.env_value("POSTGRES_VOLUME"),
            Some(std::ffi::OsStr::new("vertebrae-dev_pgdata"))
        );
        assert_eq!(
            up.env_value("POSTGRES_VOLUME_EXTERNAL"),
            Some(std::ffi::OsStr::new("true"))
        );
        assert_eq!(
            up.env_value("POSTGRES_IMAGE_REF"),
            Some(std::ffi::OsStr::new("postgres:17-alpine"))
        );
    }

    #[tokio::test]
    async fn adopted_mutation_refuses_a_missing_volume() {
        let (_temp, paths, mut state) = adopted_stack();
        let runner = MockRunner::with_outputs(
            prerequisites()
                .into_iter()
                .chain([CommandOutput::success("")]),
        );
        let controller = controller(runner.clone(), MockHealth::default());

        let error = controller
            .up_detached(&paths, &mut state)
            .await
            .expect_err("missing legacy volume must not be recreated");

        assert!(matches!(
            error,
            LocalBackendError::PersistentVolumeUnavailable { volume, .. }
                if volume == LEGACY_VOLUME
        ));
        assert!(runner.requests().iter().all(|request| {
            !request
                .args_as_strings()
                .iter()
                .any(|argument| argument == "up")
        }));
    }

    #[tokio::test]
    async fn allocated_port_has_a_structured_error() {
        let (_temp, paths, mut state) = ready_stack();
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::failure(
                1,
                "Bind for 127.0.0.1:4400 failed: port is already allocated",
            ),
        ]));
        let controller = controller(runner, MockHealth::default());

        let error = controller
            .up_detached(&paths, &mut state)
            .await
            .expect_err("allocated port must fail");

        assert!(matches!(
            error,
            LocalBackendError::PortUnavailable { port: 4400, .. }
        ));
        assert_eq!(state.host_port, 4400);
    }

    #[tokio::test]
    async fn health_timeout_returns_bounded_service_logs() {
        let (_temp, paths, state) = ready_stack();
        let runner = MockRunner::with_outputs([
            CommandOutput::success("unix:///tmp/docker.sock"),
            CommandOutput::success(
                "postgres-password-0123456789abcdef0123456789abcdef\nsecret-key-base-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ),
        ]);
        let controller = controller(runner, MockHealth::with_results([false, false]))
            .with_timeouts(
                Duration::from_secs(1),
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
        assert_eq!(url, "http://127.0.0.1:4400/healthz");
        assert_eq!(logs.matches("[redacted]").count(), 2, "{logs}");
        assert!(!logs.contains("postgres-password"), "{logs}");
        assert!(!logs.contains("secret-key-base"), "{logs}");
    }

    #[tokio::test]
    async fn health_polling_stops_after_success() {
        let (_temp, paths, state) = ready_stack();
        let controller = controller(
            MockRunner::with_outputs([CommandOutput::success("unix:///tmp/docker.sock")]),
            MockHealth::with_results([false, true]),
        )
        .with_timeouts(
            Duration::from_secs(1),
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
        let (_temp, paths, mut state) = ready_stack();
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
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success(""),
            CommandOutput::failure(
                1,
                format!("POSTGRES_PASSWORD={postgres_password} SECRET_KEY_BASE={secret_key_base}"),
            ),
        ]));
        let controller = controller(runner.clone(), MockHealth::default());

        let error = controller
            .up_detached(&paths, &mut state)
            .await
            .expect_err("config should fail");

        let message = error.to_string();
        assert_eq!(message.matches("[redacted]").count(), 2, "{message}");
        assert!(!message.contains(&postgres_password), "{message}");
        assert!(!message.contains(&secret_key_base), "{message}");
        let request = &runner.requests()[4];
        assert_eq!(request.env_value("POSTGRES_PASSWORD"), None);
        assert_eq!(request.env_value("SECRET_KEY_BASE"), None);
        assert!(request.removes_env("POSTGRES_PASSWORD"));
        assert!(request.removes_env("SECRET_KEY_BASE"));
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
        let controller = controller(runner, MockHealth::default());

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
    async fn preserved_labeled_volume_requires_only_an_explicit_host_port() {
        let runner = MockRunner::with_outputs(volume_only_legacy_outputs());
        let controller = controller(runner.clone(), MockHealth::default());
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect preserved volume");

        assert!(matches!(detection, LegacyStackDetection::HostPortRequired));
        runner.push_outputs(volume_only_legacy_outputs());
        let error = controller
            .adopt_legacy_stack(
                &paths,
                &detection,
                None,
                DIGEST_IMAGE,
                BackendImageChannel::BackendRelease,
                true,
            )
            .await
            .expect_err("host port is required");
        assert!(matches!(error, LocalBackendError::LegacyHostPortRequired));
        assert!(!paths.root.exists());
        assert!(runner.requests().iter().all(|request| {
            request
                .args_as_strings()
                .iter()
                .all(|argument| !matches!(argument.as_str(), "up" | "down" | "rm"))
        }));

        runner.push_outputs(volume_only_legacy_outputs());
        let state = controller
            .adopt_legacy_stack(
                &paths,
                &detection,
                Some(4400),
                DIGEST_IMAGE,
                BackendImageChannel::BackendRelease,
                true,
            )
            .await
            .expect("adopt preserved volume");
        assert_eq!(state.host_port, 4400);
        assert_eq!(
            state.provisioning_state,
            super::super::state::ProvisioningState::Unverified
        );
        assert_eq!(state.sacrum_bind_host, "");
        assert_eq!(state.postgres_image_ref(), LEGACY_POSTGRES_IMAGE);
    }

    #[tokio::test]
    async fn unrelated_same_named_volume_is_unsafe() {
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success(""),
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("manual", "pgdata")),
        ]));
        let controller = controller(runner, MockHealth::default());

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
            legacy_inspect_json_with(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME, "192.168.1.10");
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success("postgres-id\nsacrum-id\n"),
            CommandOutput::success(inspect),
        ]));
        let controller = controller(runner, MockHealth::default());

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
        assert!(!LEGACY_INSPECT_FORMAT.contains("Env"));
        assert!(!LEGACY_INSPECT_FORMAT.contains("Config.Env"));
        let inspect = legacy_inspect_json(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME);
        let runner = MockRunner::with_outputs(running_legacy_outputs(inspect.clone()));
        let controller = controller(runner.clone(), MockHealth::default());
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect legacy");
        let LegacyStackDetection::Compatible(_) = detection else {
            panic!("expected compatible legacy stack");
        };
        let unconfirmed = controller
            .adopt_legacy_stack(
                &paths,
                &detection,
                None,
                DIGEST_IMAGE,
                BackendImageChannel::BackendRelease,
                false,
            )
            .await;
        assert!(matches!(
            unconfirmed,
            Err(LocalBackendError::AdoptionNotConfirmed)
        ));
        assert!(!paths.root.exists());

        runner.push_outputs(running_legacy_outputs(inspect));
        let state = controller
            .adopt_legacy_stack(
                &paths,
                &detection,
                None,
                DIGEST_IMAGE,
                BackendImageChannel::BackendRelease,
                true,
            )
            .await
            .expect("adopt legacy");

        assert_eq!(state.kind, StackKind::AdoptedLegacy);
        assert_eq!(state.project_name(), "vertebrae-dev");
        assert_eq!(state.postgres_volume(), "vertebrae-dev_pgdata");
        assert_eq!(state.postgres_image_ref(), "postgres:17-alpine");
        assert_eq!(state.host_port, 4400);
        assert_eq!(state.sacrum_bind_host, "");
        assert_eq!(
            state.provisioning_state,
            super::super::state::ProvisioningState::Unverified
        );
        assert_eq!(
            paths
                .load_runtime_secrets(StackKind::AdoptedLegacy)
                .expect("load adopted secrets"),
            RuntimeSecrets::legacy_development()
        );
    }

    #[tokio::test]
    async fn adoption_rejects_evidence_that_changed_after_it_was_offered() {
        let inspect = legacy_inspect_json(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME);
        let runner = MockRunner::with_outputs(running_legacy_outputs(inspect));
        let controller = controller(runner.clone(), MockHealth::default());
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let offered = controller
            .detect_legacy_stack()
            .await
            .expect("detect legacy");
        runner.push_outputs(
            prerequisites()
                .into_iter()
                .chain([CommandOutput::success(""), CommandOutput::success("")]),
        );

        let error = controller
            .adopt_legacy_stack(
                &paths,
                &offered,
                None,
                DIGEST_IMAGE,
                BackendImageChannel::BackendRelease,
                true,
            )
            .await
            .expect_err("changed evidence must not be adopted");

        assert!(matches!(
            error,
            LocalBackendError::UnsafeLegacyStack(reason) if reason.contains("changed")
        ));
        assert!(!paths.root.exists());
    }

    #[tokio::test]
    async fn legacy_stack_with_a_postgres_image_mismatch_is_left_untouched() {
        let inspect = legacy_inspect_json("postgres:18-alpine", LEGACY_VOLUME);
        let runner = MockRunner::with_outputs(prerequisites().into_iter().chain([
            CommandOutput::success("postgres-id\nsacrum-id\n"),
            CommandOutput::success(inspect),
        ]));
        let controller = controller(runner, MockHealth::default());
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
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let first_controller = DockerCompose::system()
            .await
            .expect("connect to local Docker")
            .with_timeouts(
                Duration::from_secs(180),
                Duration::from_secs(180),
                Duration::from_secs(180),
                Duration::from_secs(2),
            );
        let mut state = ManagedStackState::fresh(
            image_ref,
            select_host_port(0).expect("select host port"),
            BackendImageChannel::BackendRelease,
            first_controller.target().clone(),
        )
        .expect("valid managed state");
        let postgres_volume = state.postgres_volume();
        paths.install_assets().expect("install assets");
        paths
            .ensure_runtime_secrets(
                &RuntimeSecrets::generate().expect("generate secrets"),
                state.kind,
            )
            .expect("persist runtime secrets");

        let outcome = async {
            first_controller.up_detached(&paths, &mut state).await?;
            first_controller.wait_until_healthy(&paths, &state).await?;
            let first_status = first_controller.status(&paths, &state).await?;
            let secrets = paths.load_runtime_secrets(state.kind)?;
            first_controller
                .checked_stack(
                    first_controller.compose_request(
                        &paths,
                        &state,
                        "write smoke-test sentinel",
                        [
                            "exec",
                            "--no-TTY",
                            "postgres",
                            "psql",
                            "-U",
                            "postgres",
                            "-d",
                            "sacrum_prod",
                            "-v",
                            "ON_ERROR_STOP=1",
                            "-c",
                            "CREATE TABLE IF NOT EXISTS vertebrae_smoke_sentinel (value text PRIMARY KEY); INSERT INTO vertebrae_smoke_sentinel VALUES ('survived') ON CONFLICT DO NOTHING;",
                        ],
                        Duration::from_secs(30),
                    ),
                    &secrets,
                )
                .await?;

            let second_controller = DockerCompose::system_for(state.docker_target.clone())?
                .with_timeouts(
                    Duration::from_secs(180),
                    Duration::from_secs(180),
                    Duration::from_secs(180),
                    Duration::from_secs(2),
                );
            second_controller.up_detached(&paths, &mut state).await?;
            second_controller.wait_until_healthy(&paths, &state).await?;
            let second_status = second_controller.status(&paths, &state).await?;
            let sentinel = second_controller
                .checked_stack(
                    second_controller.compose_request(
                        &paths,
                        &state,
                        "read smoke-test sentinel",
                        [
                            "exec",
                            "--no-TTY",
                            "postgres",
                            "psql",
                            "-U",
                            "postgres",
                            "-d",
                            "sacrum_prod",
                            "-tAc",
                            "SELECT value FROM vertebrae_smoke_sentinel WHERE value = 'survived';",
                        ],
                        Duration::from_secs(30),
                    ),
                    &secrets,
                )
                .await?;
            let volume = second_controller
                .checked(second_controller.docker_request(
                    "inspect smoke-test volume",
                    ["volume", "inspect", postgres_volume.as_str()],
                    Duration::from_secs(30),
                ))
                .await?;
            Ok::<_, LocalBackendError>((
                first_status,
                second_status,
                sentinel.stdout,
                volume.success,
            ))
        }
        .await;

        if let Ok(cleanup) = DockerCompose::system_for(state.docker_target.clone()) {
            let request = cleanup.compose_request(
                &paths,
                &state,
                "remove smoke-test stack",
                ["down", "--volumes", "--remove-orphans"],
                Duration::from_secs(60),
            );
            let _ = cleanup.checked(request).await;
        }

        let (first_status, second_status, sentinel, volume_exists) =
            outcome.expect("run Docker smoke test");
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
        assert_eq!(sentinel.trim(), "survived");
        assert!(volume_exists);
    }

    fn legacy_inspect_json(postgres_image: &str, volume: &str) -> String {
        legacy_inspect_json_with(postgres_image, volume, "")
    }

    fn legacy_inspect_json_with(postgres_image: &str, volume: &str, host_ip: &str) -> String {
        let postgres = serde_json::json!({
            "Image": postgres_image,
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
