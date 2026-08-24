use std::collections::HashMap;
use std::ffi::OsString;

use serde::Deserialize;

use super::DockerCompose;
use crate::local_backend::command::ProcessRunner;
use crate::local_backend::state::{
    BackendImageChannel, LocalBackendError, ManagedStackPaths, ManagedStackState, RuntimeSecrets,
    StackKind, LEGACY_POSTGRES_IMAGE, LEGACY_PROJECT, LEGACY_VOLUME,
};

pub(super) const LEGACY_INSPECT_FORMAT: &str = r#"{"Image":{{json .Config.Image}},"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"Service":{{json (index .Config.Labels "com.docker.compose.service")}},"PortBindings":{{json .HostConfig.PortBindings}},"Mounts":{{json .Mounts}}}"#;
const LEGACY_VOLUME_INSPECT_FORMAT: &str = r#"{"Name":{{json .Name}},"Project":{{json (index .Labels "com.docker.compose.project")}},"Volume":{{json (index .Labels "com.docker.compose.volume")}}}"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyStackCandidate {
    pub host_port: u16,
    bind_host: String,
}

#[cfg(test)]
impl LegacyStackCandidate {
    pub(crate) fn for_test(host_port: u16) -> Self {
        Self {
            host_port,
            bind_host: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyStackDetection {
    Absent,
    Compatible(LegacyStackCandidate),
    HostPortRequired,
    Unsafe(String),
}

pub(super) enum LegacyVolumeStatus {
    Absent,
    Compatible,
    Unsafe(String),
}

impl<R, H> DockerCompose<R, H>
where
    R: ProcessRunner,
{
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
            .checked(self.docker_request(
                "inspect vertebrae-dev containers",
                inspect_args,
                self.quick_timeout,
            ))
            .await?;
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
        if detection != &current {
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

    pub(super) async fn legacy_volume_status(
        &self,
    ) -> Result<LegacyVolumeStatus, LocalBackendError> {
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
    if !postgres.mounts.iter().any(|mount| {
        mount.mount_type == "volume"
            && mount.name.as_deref() == Some(LEGACY_VOLUME)
            && mount.destination == "/var/lib/postgresql/data"
    }) {
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
    use super::super::test_support::*;
    use super::*;
    use crate::local_backend::command::CommandOutput;
    use crate::local_backend::state::ProvisioningState;
    #[tokio::test]
    async fn truncated_legacy_metadata_is_rejected() {
        let mut inspect =
            CommandOutput::success(legacy_inspect_json(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME));
        inspect.truncated = true;
        let detection =
            detect_legacy([CommandOutput::success("postgres-id\nsacrum-id\n"), inspect])
                .await
                .expect("detect legacy");

        assert!(matches!(
            detection,
            LegacyStackDetection::Unsafe(reason) if reason.contains("inspection limit")
        ));
    }

    #[tokio::test]
    async fn preserved_labeled_volume_requires_only_an_explicit_host_port() {
        let runner = MockRunner::with_outputs(legacy_outputs(None));
        let controller = controller(runner.clone(), MockHealth::default());
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());

        let detection = controller
            .detect_legacy_stack()
            .await
            .expect("detect preserved volume");

        assert!(matches!(detection, LegacyStackDetection::HostPortRequired));
        runner.push_outputs(legacy_outputs(None));
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

        runner.push_outputs(legacy_outputs(None));
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
        assert_eq!(state.provisioning_state, ProvisioningState::Unverified);
        assert_eq!(state.sacrum_bind_host, "");
        assert_eq!(state.postgres_image_ref(), LEGACY_POSTGRES_IMAGE);
    }

    #[tokio::test]
    async fn incompatible_legacy_resources_are_unsafe() {
        for (outputs, expected) in [
            (
                vec![
                    CommandOutput::success(""),
                    CommandOutput::success("vertebrae-dev_pgdata\n"),
                    CommandOutput::success(legacy_volume_inspect("manual", "pgdata")),
                ],
                "expected Compose",
            ),
            (
                vec![
                    CommandOutput::success("postgres-id\nsacrum-id\n"),
                    CommandOutput::success(legacy_inspect_json_with(
                        LEGACY_POSTGRES_IMAGE,
                        LEGACY_VOLUME,
                        "192.168.1.10",
                    )),
                ],
                "192.168.1.10",
            ),
            (
                vec![
                    CommandOutput::success("postgres-id\nsacrum-id\n"),
                    CommandOutput::success(legacy_inspect_json(
                        "postgres:18-alpine",
                        LEGACY_VOLUME,
                    )),
                ],
                "postgres:17-alpine",
            ),
        ] {
            let detection = detect_legacy(outputs).await.expect("detect unsafe legacy");
            assert!(matches!(
                detection,
                LegacyStackDetection::Unsafe(reason) if reason.contains(expected)
            ));
        }
    }

    #[tokio::test]
    async fn legacy_containers_without_the_preserved_volume_are_unsafe() {
        let detection = detect_legacy([
            CommandOutput::success("postgres-id\nsacrum-id\n"),
            CommandOutput::success(legacy_inspect_json(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME)),
            CommandOutput::success(""),
        ])
        .await
        .expect("detect legacy stack");

        assert!(matches!(
            detection,
            LegacyStackDetection::Unsafe(reason) if reason.contains("volume is missing")
        ));
    }

    #[tokio::test]
    async fn compatible_legacy_stack_is_adopted_without_changing_its_v17_volume() {
        assert!(!LEGACY_INSPECT_FORMAT.contains("Env"));
        assert!(!LEGACY_INSPECT_FORMAT.contains("Config.Env"));
        let inspect = legacy_inspect_json(LEGACY_POSTGRES_IMAGE, LEGACY_VOLUME);
        let runner = MockRunner::with_outputs(legacy_outputs(Some(inspect.clone())));
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

        runner.push_outputs(legacy_outputs(Some(inspect)));
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
        assert_eq!(state.provisioning_state, ProvisioningState::Unverified);
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
        let runner = MockRunner::with_outputs(legacy_outputs(Some(inspect)));
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
}
