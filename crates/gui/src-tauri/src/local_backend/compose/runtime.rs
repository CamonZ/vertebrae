use super::{DockerRuntime, ServiceStatus};
use crate::local_backend::command::ProcessRunner;
use crate::local_backend::runtime::{ContainerRuntime, DatabaseVolumeStatus, StartMode};
use crate::local_backend::state::{
    ApiToken, LocalBackendError, ManagedStackPaths, ManagedStackState, RuntimeSecrets, SeedAccount,
};
use async_trait::async_trait;

#[async_trait]
impl<R: ProcessRunner> ContainerRuntime for DockerRuntime<R> {
    async fn revalidate_target(&self) -> Result<(), LocalBackendError> {
        self.revalidate_context().await
    }
    fn validate_stack_files(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        self.validate_stack_files(paths, state)
    }
    async fn prepare_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        mode: StartMode,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        self.prepare_start(paths, state, mode).await
    }
    async fn inspect_database_volume(
        &self,
        state: &ManagedStackState,
    ) -> Result<DatabaseVolumeStatus, LocalBackendError> {
        self.inspect_database_volume(state).await
    }
    async fn start_services(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
        mode: StartMode,
    ) -> Result<(), LocalBackendError> {
        self.start_services(paths, state, secrets, mode).await
    }
    async fn database_volume_exists(&self, name: &str) -> Result<bool, LocalBackendError> {
        self.named_volume_exists(name).await
    }
    async fn status(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.status(paths, state).await
    }
    async fn status_after_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.status_without_prerequisite(paths, state, secrets)
            .await
    }
    async fn run_seeder(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        account: &SeedAccount,
        token: &ApiToken,
    ) -> Result<(), LocalBackendError> {
        self.run_seeder(paths, state, account, token).await
    }
    async fn replace_sacrum_image(
        &self,
        paths: &ManagedStackPaths,
        current: &ManagedStackState,
        updated: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        self.replace_sacrum_image(paths, current, updated).await
    }
    async fn logs(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<String, LocalBackendError> {
        self.checked_stack(
            self.compose_request(
                paths,
                state,
                "read local backend logs",
                ["logs", "--no-color", "--tail", "80", "postgres", "sacrum"],
                self.quick_timeout,
            ),
            secrets,
        )
        .await
        .map(|output| output.summary())
    }
}
