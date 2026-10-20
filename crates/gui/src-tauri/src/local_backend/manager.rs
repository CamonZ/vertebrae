//! Runtime-independent local-backend lifecycle and HTTP readiness.
use super::health::HealthProbe;
use super::runtime::{ContainerRuntime, DatabaseVolumeStatus, ServiceStatus, StartMode};
use super::state::{
    LocalBackendError, ManagedStackPaths, ManagedStackState, ProvisioningStage, StackKind,
};
use std::time::Duration;

pub struct LocalBackendManager<T, H> {
    pub(super) runtime: T,
    pub(super) health_probe: H,
    pub(super) health_timeout: Duration,
    pub(super) health_poll_interval: Duration,
}

impl<T, H> LocalBackendManager<T, H> {
    pub fn with_runtime(runtime: T, health_probe: H) -> Self {
        Self {
            runtime,
            health_probe,
            health_timeout: Duration::from_secs(120),
            health_poll_interval: Duration::from_secs(2),
        }
    }
}

impl<T: ContainerRuntime, H: HealthProbe> LocalBackendManager<T, H> {
    pub async fn start_and_wait_until_healthy(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.start_and_wait_until_healthy_with_progress(paths, state, |_| {})
            .await
    }

    pub async fn start_and_wait_until_healthy_with_progress<F>(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
        progress: F,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError>
    where
        F: Fn(ProvisioningStage) + Send + Sync,
    {
        if state.kind != StackKind::Managed {
            return Err(LocalBackendError::InvalidState(
                "fresh provisioning cannot start an adopted development stack".to_string(),
            ));
        }

        state.provisioning_state = crate::local_backend::state::ProvisioningState::InProgress;
        paths.save_state(state)?;

        let result = async {
            progress(ProvisioningStage::Pulling);
            self.up_detached(paths, state).await?;
            progress(ProvisioningStage::Migrating);
            progress(ProvisioningStage::Health);
            self.wait_until_healthy(paths, state).await?;
            let secrets = self.runtime.validate_stack_files(paths, state)?;
            self.runtime
                .status_after_start(paths, state, &secrets)
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

    pub async fn update_sacrum_image(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        image_ref: &str,
        version: Option<&str>,
        build: Option<&str>,
        image_created_at: Option<&str>,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        let mut updated_state = state.clone();
        updated_state.sacrum_image_ref = image_ref.to_string();
        updated_state.sacrum_version = version.map(str::to_string);
        updated_state.sacrum_build = build.map(str::to_string);
        updated_state.sacrum_image_created_at = image_created_at.map(str::to_string);
        updated_state.validate()?;
        self.runtime
            .replace_sacrum_image(paths, state, &updated_state)
            .await?;
        self.wait_until_healthy(paths, &updated_state).await?;
        let status = self.status(paths, &updated_state).await?;
        paths.save_state(&updated_state)?;
        Ok(status)
    }
}

impl<T: ContainerRuntime, H> LocalBackendManager<T, H> {
    pub async fn up_detached(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.start_services(paths, state, StartMode::Reconcile)
            .await
    }
    pub async fn up_adopted(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        if state.kind != StackKind::AdoptedLegacy {
            return Err(LocalBackendError::InvalidState(
                "legacy adoption startup requires an adopted development stack".to_string(),
            ));
        }
        self.start_services(paths, state, StartMode::PreserveExisting)
            .await
    }
    async fn start_services(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
        mode: StartMode,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        let secrets = self.runtime.prepare_start(paths, state, mode).await?;
        let volume = state.postgres_volume();
        match self.runtime.inspect_database_volume(state).await? {
            DatabaseVolumeStatus::Present => {}
            DatabaseVolumeStatus::Absent if state.kind == StackKind::AdoptedLegacy => {
                return Err(LocalBackendError::PersistentVolumeUnavailable {
                    volume,
                    reason: "the adopted legacy database volume is missing".to_string(),
                });
            }
            DatabaseVolumeStatus::Absent if state.postgres_volume_is_external() => {
                return Err(LocalBackendError::PersistentVolumeUnavailable { volume,
                    reason: "a previously created database volume is missing; restore it or explicitly start over".to_string() });
            }
            DatabaseVolumeStatus::Absent => {}
            DatabaseVolumeStatus::Unsafe(reason) => {
                return Err(LocalBackendError::PersistentVolumeUnavailable { volume, reason });
            }
        }
        self.runtime
            .start_services(paths, state, &secrets, mode)
            .await?;
        if mode == StartMode::Reconcile && !state.postgres_volume_initialized {
            if !self.runtime.database_volume_exists(&volume).await? {
                return Err(LocalBackendError::PersistentVolumeUnavailable {
                    volume,
                    reason: "Docker Compose completed without creating the database volume"
                        .to_string(),
                });
            }
            state.postgres_volume_initialized = true;
            paths.save_state(state)?;
        }
        self.runtime
            .status_after_start(paths, state, &secrets)
            .await
    }

    pub async fn status(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.runtime.status(paths, state).await
    }
}

#[cfg(test)]
mod tests;
