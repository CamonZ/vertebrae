use std::time::Duration;

use serde::Deserialize;

use super::legacy::LegacyVolumeStatus;
use super::DockerCompose;
use crate::local_backend::command::ProcessRunner;
use crate::local_backend::state::{
    LocalBackendError, ManagedStackPaths, ManagedStackState, RuntimeSecrets, StackKind,
    LEGACY_VOLUME,
};

pub(super) const RECONCILE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MINIMUM_SAFE_ENGINE_MAJOR: u64 = 28;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceStatus {
    pub name: String,
    pub service: String,
    pub state: String,
    pub health: Option<String>,
    pub exit_code: Option<i32>,
}

impl<R, H> DockerCompose<R, H>
where
    R: ProcessRunner,
{
    pub async fn start_and_wait_until_healthy(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError>
    where
        H: super::health::HealthProbe,
    {
        if state.kind != StackKind::Managed {
            return Err(LocalBackendError::InvalidState(
                "fresh provisioning cannot start an adopted development stack".to_string(),
            ));
        }

        state.provisioning_state = crate::local_backend::state::ProvisioningState::InProgress;
        paths.save_state(state)?;

        let result = async {
            self.up_detached(paths, state).await?;
            self.wait_until_healthy(paths, state).await?;
            let secrets = self.validate_stack_files(paths, state)?;
            self.status_without_prerequisite(paths, state, &secrets)
                .await
        }
        .await;

        match result {
            Ok(status) => Ok(status),
            Err(error) => {
                state.provisioning_state = crate::local_backend::state::ProvisioningState::Failed;
                if let Err(save_error) = paths.save_state(state) {
                    return Err(LocalBackendError::InvalidState(format!(
                        "{error}; additionally could not record failed provisioning state: {save_error}"
                    )));
                }
                Err(error)
            }
        }
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
}

fn classify_port_error(error: LocalBackendError, port: u16) -> LocalBackendError {
    match error {
        LocalBackendError::CommandFailed { output, .. } if port_conflict(&output) => {
            LocalBackendError::PortUnavailable { port, output }
        }
        error => error,
    }
}

fn port_conflict(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    output.contains("port is already allocated")
        || output.contains("address already in use")
        || (output.contains("bind for") && output.contains("port"))
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

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::transport::{DOCKER_ENV_REMOVE, QUICK_COMMAND_TIMEOUT};
    use super::*;
    use crate::local_backend::command::CommandOutput;
    use crate::local_backend::state::ProvisioningState;

    #[tokio::test]
    async fn start_and_wait_records_in_progress_and_keeps_it_until_seeding_finishes() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
        let volume = state.postgres_volume();
        let status_json = format!(
            r#"[{{"Name":"{volume}-postgres-1","Service":"postgres","State":"running","Health":"healthy","ExitCode":0}},{{"Name":"{volume}-sacrum-1","Service":"sacrum","State":"running","Health":"healthy","ExitCode":0}}]"#
        );
        let runner = MockRunner::after_prerequisites([
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(format!("{volume}\n")),
            CommandOutput::success(status_json.clone()),
            CommandOutput::success("unix:///tmp/docker.sock"),
            CommandOutput::success(status_json),
        ]);
        let controller = controller(runner, MockHealth::with_results([true]));

        let status = controller
            .start_and_wait_until_healthy(&paths, &mut state)
            .await
            .expect("managed stack should become healthy");

        assert_eq!(state.provisioning_state, ProvisioningState::InProgress);
        assert_eq!(paths.load_state().expect("load state"), Some(state));
        assert_eq!(status.len(), 2);
        assert!(status.iter().all(|service| {
            service.state == "running" && service.health.as_deref() == Some("healthy")
        }));
    }

    #[tokio::test]
    async fn start_failure_is_recorded_without_tearing_down_the_stack() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
        let runner = MockRunner::after_prerequisites([CommandOutput::failure(
            1,
            "pull access denied for Sacrum image",
        )]);
        let controller = controller(runner.clone(), MockHealth::default());

        let error = controller
            .start_and_wait_until_healthy(&paths, &mut state)
            .await
            .expect_err("image pull failure should be reported");

        assert!(error.to_string().contains("pull access denied"));
        assert_eq!(state.provisioning_state, ProvisioningState::Failed);
        assert_eq!(
            paths
                .load_state()
                .expect("load failed state")
                .expect("failed state")
                .provisioning_state,
            ProvisioningState::Failed
        );
        assert!(runner.requests().iter().all(|request| {
            !request
                .args_as_strings()
                .iter()
                .any(|argument| argument == "down")
        }));
    }

    #[tokio::test]
    async fn detached_up_uses_app_assets_and_returns_structured_status() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
        let postgres_volume = state.postgres_volume();
        let status_json = r#"[{"Name":"vertebrae-local-postgres-1","Service":"postgres","State":"running","Health":"healthy","ExitCode":0},{"Name":"vertebrae-local-sacrum-1","Service":"sacrum","State":"running","Health":"healthy","ExitCode":0}]"#;
        let runner = MockRunner::after_prerequisites([
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(format!("{postgres_volume}\n")),
            CommandOutput::success(status_json),
        ]);
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
        for (name, value) in [
            ("POSTGRES_IMAGE_REF", "postgres:18-alpine"),
            ("POSTGRES_VOLUME", postgres_volume.as_str()),
            ("POSTGRES_VOLUME_EXTERNAL", "false"),
            ("POSTGRES_DATA_PATH", "/var/lib/postgresql"),
            ("SACRUM_BIND_PREFIX", "127.0.0.1:"),
        ] {
            assert_eq!(up.env_value(name), Some(std::ffi::OsStr::new(value)));
        }
        for name in ["POSTGRES_PASSWORD", "SECRET_KEY_BASE"] {
            assert_eq!(up.env_value(name), None);
            assert!(up.removes_env(name));
        }
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
        assert!(requests.iter().all(|request| {
            !request
                .args_as_strings()
                .iter()
                .any(|argument| argument == "down")
        }));
    }

    #[tokio::test]
    async fn unsupported_engine_blocks_fresh_mutation_but_not_diagnosis() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
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
    async fn initialized_stacks_refuse_a_missing_volume() {
        for kind in [StackKind::Managed, StackKind::AdoptedLegacy] {
            let (_temp, paths, mut state) = stack_fixture(kind);
            state.postgres_volume_initialized = true;
            if kind == StackKind::Managed {
                state.provisioning_state = ProvisioningState::Failed;
            }
            let runner = MockRunner::after_prerequisites([CommandOutput::success("")]);
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
    }

    #[tokio::test]
    async fn provisioning_failure_before_volume_creation_remains_retryable() {
        for provisioning_state in [ProvisioningState::InProgress, ProvisioningState::Failed] {
            let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
            state.provisioning_state = provisioning_state;
            let runner = MockRunner::after_prerequisites([
                CommandOutput::success(""),
                CommandOutput::failure(1, "retry reached Compose validation"),
            ]);
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
        let (_temp, paths, mut state) = stack_fixture(StackKind::AdoptedLegacy);
        let status_json = r#"[{"Name":"vertebrae-dev-postgres-1","Service":"postgres","State":"running","Health":"healthy","ExitCode":0}]"#;
        let runner = MockRunner::after_prerequisites([
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(status_json),
        ]);
        let controller = controller(runner.clone(), MockHealth::default());

        controller
            .up_detached(&paths, &mut state)
            .await
            .expect("reconcile adopted stack");

        let requests = runner.requests();
        let up = &requests[6];
        for (name, value) in [
            ("POSTGRES_VOLUME", "vertebrae-dev_pgdata"),
            ("POSTGRES_VOLUME_EXTERNAL", "true"),
            ("POSTGRES_IMAGE_REF", "postgres:17-alpine"),
        ] {
            assert_eq!(up.env_value(name), Some(std::ffi::OsStr::new(value)));
        }
    }

    #[tokio::test]
    async fn allocated_port_has_a_structured_error() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
        let runner = MockRunner::after_prerequisites([
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::failure(
                1,
                "Bind for 127.0.0.1:4400 failed: port is already allocated",
            ),
        ]);
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
}
