//! Semantic container operations consumed by the shared backend manager.
use async_trait::async_trait;

use super::state::{
    ApiToken, LocalBackendError, ManagedStackPaths, ManagedStackState, RuntimeSecrets, SeedAccount,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceStatus {
    pub name: String,
    pub service: String,
    pub state: String,
    pub health: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartMode {
    Reconcile,
    PreserveExisting,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DatabaseVolumeStatus {
    Present,
    Absent,
    Unsafe(String),
}

/// Implementations pin and revalidate their connection and preserve existing volumes.
/// Operations may create containers; they must
/// redact secrets from diagnostics. HTTP readiness and final state commits belong to
/// the manager. Implementations retain responsibility for command timeout/cleanup.
#[async_trait]
pub(crate) trait ContainerRuntime: Send + Sync {
    async fn revalidate_target(&self) -> Result<(), LocalBackendError>;
    fn validate_stack_files(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<RuntimeSecrets, LocalBackendError>;
    async fn prepare_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        mode: StartMode,
    ) -> Result<RuntimeSecrets, LocalBackendError>;
    async fn inspect_database_volume(
        &self,
        state: &ManagedStackState,
    ) -> Result<DatabaseVolumeStatus, LocalBackendError>;
    async fn start_services(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
        mode: StartMode,
    ) -> Result<(), LocalBackendError>;
    async fn database_volume_exists(&self, name: &str) -> Result<bool, LocalBackendError>;
    async fn status(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError>;
    /// Read status after a successful start without repeating prerequisite checks.
    async fn status_after_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError>;
    async fn run_seeder(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        account: &SeedAccount,
        token: &ApiToken,
    ) -> Result<(), LocalBackendError>;
    /// Pull/recreate only Sacrum. The manager commits updated state after readiness.
    async fn replace_sacrum_image(
        &self,
        paths: &ManagedStackPaths,
        current: &ManagedStackState,
        updated: &ManagedStackState,
    ) -> Result<(), LocalBackendError>;
    async fn logs(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<String, LocalBackendError>;
}
