//! System composition boundary; a saved installation never falls back to another runtime.
use super::command::SystemProcessRunner;
use super::compose::{DockerCompose, DockerRuntime, LegacyStackDetection, ReqwestHealthProbe};
use super::manager::LocalBackendManager;
use super::podman::PodmanRuntime;
use super::runtime::{ContainerRuntime, DatabaseVolumeStatus, ServiceStatus, StartMode};
use super::state::{
    ApiToken, BackendImageChannel, LocalBackendError, ManagedStackPaths, ManagedStackState,
    RuntimeKind, RuntimeSecrets, SeedAccount,
};
use async_trait::async_trait;

pub(crate) enum SelectedRuntime {
    Docker(DockerRuntime<SystemProcessRunner>),
    Podman(PodmanRuntime<SystemProcessRunner>),
}

pub(crate) type SystemBackend = LocalBackendManager<SelectedRuntime, ReqwestHealthProbe>;

/// Selection is validated in Rust even when the GUI disables changing it.
pub(crate) fn select_runtime(
    saved: Option<&ManagedStackState>,
    requested: Option<RuntimeKind>,
) -> Result<RuntimeKind, LocalBackendError> {
    let selected = requested
        .or_else(|| saved.map(|state| state.runtime))
        .unwrap_or_default();
    if saved.is_some_and(|state| state.runtime != selected) {
        return Err(LocalBackendError::InvalidState("This installation already belongs to another container runtime; reopen it with the saved runtime.".into()));
    }
    Ok(selected)
}

impl SystemBackend {
    pub async fn system(kind: RuntimeKind) -> Result<Self, LocalBackendError> {
        let runtime = match kind {
            RuntimeKind::Docker => SelectedRuntime::Docker(DockerCompose::system().await?.runtime),
            RuntimeKind::Podman => SelectedRuntime::Podman(PodmanRuntime::system().await?),
        };
        Ok(Self::with_runtime(runtime, ReqwestHealthProbe::default()))
    }
    pub fn for_state(state: &ManagedStackState) -> Result<Self, LocalBackendError> {
        state.validate()?;
        let runtime = match state.runtime {
            RuntimeKind::Docker => SelectedRuntime::Docker(
                DockerCompose::system_for(state.docker_target()?.clone())?.runtime,
            ),
            RuntimeKind::Podman => SelectedRuntime::Podman(PodmanRuntime::system_for(
                state.podman_target.clone().ok_or_else(|| {
                    LocalBackendError::InvalidState("saved Podman identity is missing".into())
                })?,
            )?),
        };
        Ok(Self::with_runtime(runtime, ReqwestHealthProbe::default()))
    }
    pub fn fresh_state(
        &self,
        image: &str,
        port: u16,
        channel: BackendImageChannel,
    ) -> Result<ManagedStackState, LocalBackendError> {
        match &self.runtime {
            SelectedRuntime::Docker(runtime) => {
                ManagedStackState::fresh(image, port, channel, runtime.target.clone())
            }
            SelectedRuntime::Podman(runtime) => {
                ManagedStackState::fresh_podman(image, port, channel, runtime.target().clone())
            }
        }
    }
    pub async fn detect_legacy_stack(&self) -> Result<LegacyStackDetection, LocalBackendError> {
        match &self.runtime {
            SelectedRuntime::Docker(runtime) => runtime.detect_legacy_stack().await,
            SelectedRuntime::Podman(_) => Ok(LegacyStackDetection::Absent),
        }
    }
    pub async fn adopt_legacy_stack(
        &self,
        paths: &ManagedStackPaths,
        detection: &LegacyStackDetection,
        channel: BackendImageChannel,
        confirmed: bool,
    ) -> Result<ManagedStackState, LocalBackendError> {
        match &self.runtime {
            SelectedRuntime::Docker(runtime) => {
                runtime
                    .adopt_legacy_stack(paths, detection, channel, confirmed)
                    .await
            }
            SelectedRuntime::Podman(_) => Err(LocalBackendError::Podman(
                "legacy Docker stacks cannot be adopted with Podman".into(),
            )),
        }
    }
}

#[async_trait]
impl ContainerRuntime for SelectedRuntime {
    async fn revalidate_target(&self) -> Result<(), LocalBackendError> {
        match self {
            Self::Docker(r) => r.revalidate_target().await,
            Self::Podman(r) => r.revalidate_target().await,
        }
    }
    fn validate_stack_files(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        match self {
            Self::Docker(r) => ContainerRuntime::validate_stack_files(r, paths, state),
            Self::Podman(r) => r.validate_stack_files(paths, state),
        }
    }
    async fn prepare_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        mode: StartMode,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        match self {
            Self::Docker(r) => ContainerRuntime::prepare_start(r, paths, state, mode).await,
            Self::Podman(r) => r.prepare_start(paths, state, mode).await,
        }
    }
    async fn inspect_database_volume(
        &self,
        state: &ManagedStackState,
    ) -> Result<DatabaseVolumeStatus, LocalBackendError> {
        match self {
            Self::Docker(r) => ContainerRuntime::inspect_database_volume(r, state).await,
            Self::Podman(r) => r.inspect_database_volume(state).await,
        }
    }
    async fn start_services(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
        mode: StartMode,
    ) -> Result<(), LocalBackendError> {
        match self {
            Self::Docker(r) => {
                ContainerRuntime::start_services(r, paths, state, secrets, mode).await
            }
            Self::Podman(r) => r.start_services(paths, state, secrets, mode).await,
        }
    }
    async fn database_volume_exists(&self, name: &str) -> Result<bool, LocalBackendError> {
        match self {
            Self::Docker(r) => r.database_volume_exists(name).await,
            Self::Podman(r) => r.database_volume_exists(name).await,
        }
    }
    async fn status(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        match self {
            Self::Docker(r) => ContainerRuntime::status(r, paths, state).await,
            Self::Podman(r) => r.status(paths, state).await,
        }
    }
    async fn status_after_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        match self {
            Self::Docker(r) => r.status_after_start(paths, state, secrets).await,
            Self::Podman(r) => r.status_after_start(paths, state, secrets).await,
        }
    }
    async fn run_seeder(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        account: &SeedAccount,
        token: &ApiToken,
    ) -> Result<(), LocalBackendError> {
        match self {
            Self::Docker(r) => r.run_seeder(paths, state, account, token).await,
            Self::Podman(r) => r.run_seeder(paths, state, account, token).await,
        }
    }
    async fn replace_sacrum_image(
        &self,
        paths: &ManagedStackPaths,
        current: &ManagedStackState,
        updated: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        match self {
            Self::Docker(r) => {
                ContainerRuntime::replace_sacrum_image(r, paths, current, updated).await
            }
            Self::Podman(r) => r.replace_sacrum_image(paths, current, updated).await,
        }
    }
    async fn logs(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<String, LocalBackendError> {
        match self {
            Self::Docker(r) => r.logs(paths, state, secrets).await,
            Self::Podman(r) => r.logs(paths, state, secrets).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_backend::compose::test_support::{stack_fixture, DIGEST_IMAGE};
    use crate::local_backend::podman::PodmanTarget;
    use crate::local_backend::state::StackKind;

    #[test]
    fn selection_defaults_only_for_fresh_installations_and_rejects_cross_runtime_reuse() {
        assert_eq!(select_runtime(None, None).unwrap(), RuntimeKind::Docker);
        assert_eq!(
            select_runtime(None, Some(RuntimeKind::Podman)).unwrap(),
            RuntimeKind::Podman
        );
        let (_temp, _paths, docker) = stack_fixture(StackKind::Managed);
        let podman = ManagedStackState::fresh_podman(
            DIGEST_IMAGE,
            4400,
            BackendImageChannel::BackendRelease,
            PodmanTarget {
                endpoint: "unix:///run/user/1000/podman/podman.sock".into(),
                storage_root: "/storage".into(),
                provider: std::env::current_exe().unwrap(),
                machine: None,
            },
        )
        .unwrap();
        for state in [&docker, &podman] {
            assert_eq!(select_runtime(Some(state), None).unwrap(), state.runtime);
            let other = if state.runtime == RuntimeKind::Docker {
                RuntimeKind::Podman
            } else {
                RuntimeKind::Docker
            };
            assert!(select_runtime(Some(state), Some(other)).is_err());
        }
    }
    #[test]
    fn old_docker_state_keeps_its_wire_shape_and_rejects_missing_or_null_identity() {
        let (_temp, _paths, state) = stack_fixture(StackKind::Managed);
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert!(value.get("runtime").is_none());
        assert!(value.get("podman_target").is_none());
        for replacement in [
            None,
            Some(serde_json::Value::Null),
            Some(serde_json::json!({"name":123})),
        ] {
            let mut damaged = value.clone();
            match replacement {
                None => {
                    damaged.as_object_mut().unwrap().remove("docker_target");
                }
                Some(value) => {
                    damaged["docker_target"] = value;
                }
            }
            let parsed = serde_json::from_value::<ManagedStackState>(damaged);
            assert!(parsed.is_err() || parsed.unwrap().validate().is_err());
        }
    }
}
