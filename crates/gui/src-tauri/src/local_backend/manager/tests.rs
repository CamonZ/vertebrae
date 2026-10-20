use async_trait::async_trait;
use std::sync::Mutex;

use super::*;
use crate::local_backend::compose::test_support::{stack_fixture, MockHealth};
use crate::local_backend::state::{ApiToken, ProvisioningState, RuntimeSecrets, SeedAccount};

#[derive(Default)]
struct FakeRuntime {
    calls: Mutex<Vec<&'static str>>,
    fail: Option<&'static str>,
    volume_absent: bool,
    volume_unsafe: bool,
}

impl FakeRuntime {
    fn record(&self, operation: &'static str) -> Result<(), LocalBackendError> {
        self.calls.lock().unwrap().push(operation);
        if self.fail == Some(operation) {
            Err(LocalBackendError::InvalidState(format!(
                "fake {operation} failure"
            )))
        } else {
            Ok(())
        }
    }
    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl ContainerRuntime for FakeRuntime {
    async fn revalidate_target(&self) -> Result<(), LocalBackendError> {
        self.record("target")
    }
    fn validate_stack_files(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        self.record("files")?;
        paths.load_runtime_secrets(state.kind)
    }
    async fn prepare_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        _: StartMode,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        self.record("prepare")?;
        paths.load_runtime_secrets(state.kind)
    }
    async fn inspect_database_volume(
        &self,
        _: &ManagedStackState,
    ) -> Result<DatabaseVolumeStatus, LocalBackendError> {
        self.record("volume")?;
        Ok(if self.volume_unsafe {
            DatabaseVolumeStatus::Unsafe("unexpected volume metadata".to_string())
        } else if self.volume_absent {
            DatabaseVolumeStatus::Absent
        } else {
            DatabaseVolumeStatus::Present
        })
    }
    async fn start_services(
        &self,
        _: &ManagedStackPaths,
        _: &ManagedStackState,
        _: &RuntimeSecrets,
        mode: StartMode,
    ) -> Result<(), LocalBackendError> {
        self.record(if mode == StartMode::Reconcile {
            "start"
        } else {
            "adopted"
        })
    }
    async fn database_volume_exists(&self, _: &str) -> Result<bool, LocalBackendError> {
        self.record("exists")?;
        Ok(!self.volume_absent)
    }
    async fn status(
        &self,
        _: &ManagedStackPaths,
        _: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.record("status")?;
        Ok(vec![])
    }
    async fn status_after_start(
        &self,
        _: &ManagedStackPaths,
        _: &ManagedStackState,
        _: &RuntimeSecrets,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.record("started status")?;
        Ok(vec![])
    }
    async fn run_seeder(
        &self,
        _: &ManagedStackPaths,
        _: &ManagedStackState,
        _: &SeedAccount,
        _: &ApiToken,
    ) -> Result<(), LocalBackendError> {
        self.record("seed")
    }
    async fn replace_sacrum_image(
        &self,
        _: &ManagedStackPaths,
        _: &ManagedStackState,
        _: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        self.record("replace")
    }
    async fn logs(
        &self,
        _: &ManagedStackPaths,
        _: &ManagedStackState,
        _: &RuntimeSecrets,
    ) -> Result<String, LocalBackendError> {
        self.record("logs")?;
        Ok("fake runtime logs".to_string())
    }
}

#[tokio::test]
async fn start_reports_progress_and_preserves_pending_final_commit() {
    let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
    let manager =
        LocalBackendManager::with_runtime(FakeRuntime::default(), MockHealth::with_results([true]));
    let progress = Mutex::new(vec![]);
    manager
        .start_and_wait_until_healthy_with_progress(&paths, &mut state, |stage| {
            progress.lock().unwrap().push(stage)
        })
        .await
        .unwrap();
    assert_eq!(
        *progress.lock().unwrap(),
        vec![
            ProvisioningStage::Pulling,
            ProvisioningStage::Migrating,
            ProvisioningStage::Health
        ]
    );
    assert_eq!(
        manager.runtime.calls(),
        [
            "prepare",
            "volume",
            "start",
            "exists",
            "started status",
            "target",
            "files",
            "files",
            "started status"
        ]
    );
    assert_eq!(
        paths.load_state().unwrap().unwrap().provisioning_state,
        ProvisioningState::InProgress
    );
}

#[tokio::test]
async fn failed_start_is_persisted_without_health_or_seeding() {
    let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
    let runtime = FakeRuntime {
        fail: Some("start"),
        ..Default::default()
    };
    let manager = LocalBackendManager::with_runtime(runtime, MockHealth::default());
    assert!(manager
        .start_and_wait_until_healthy(&paths, &mut state)
        .await
        .is_err());
    assert_eq!(manager.runtime.calls(), ["prepare", "volume", "start"]);
    assert_eq!(
        paths.load_state().unwrap().unwrap().provisioning_state,
        ProvisioningState::Failed
    );
}

#[tokio::test]
async fn health_failure_includes_runtime_logs_and_records_failure() {
    let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
    let mut manager =
        LocalBackendManager::with_runtime(FakeRuntime::default(), MockHealth::default());
    manager.health_timeout = Duration::ZERO;
    let error = manager
        .start_and_wait_until_healthy(&paths, &mut state)
        .await
        .unwrap_err();
    assert!(
        matches!(error, LocalBackendError::HealthTimedOut { logs, .. } if logs == "fake runtime logs")
    );
    assert_eq!(
        manager.runtime.calls(),
        [
            "prepare",
            "volume",
            "start",
            "exists",
            "started status",
            "target",
            "files",
            "logs"
        ]
    );
    assert_eq!(
        paths.load_state().unwrap().unwrap().provisioning_state,
        ProvisioningState::Failed
    );
}

#[tokio::test]
async fn image_state_is_committed_only_after_health_and_status_succeed() {
    let (_temp, paths, state) = stack_fixture(StackKind::Managed);
    paths.save_state(&state).unwrap();
    let image = format!("ghcr.io/camonz/sacrum@sha256:{}", "a".repeat(64));
    let manager = LocalBackendManager::with_runtime(
        FakeRuntime {
            fail: Some("status"),
            ..Default::default()
        },
        MockHealth::with_results([true]),
    );
    assert!(manager
        .update_sacrum_image(&paths, &state, &image, Some("new"), None, None)
        .await
        .is_err());
    assert_eq!(paths.load_state().unwrap().unwrap(), state);
    assert_eq!(
        manager.runtime.calls(),
        ["replace", "target", "files", "status"]
    );

    let manager =
        LocalBackendManager::with_runtime(FakeRuntime::default(), MockHealth::with_results([true]));
    manager
        .update_sacrum_image(&paths, &state, &image, Some("new"), None, None)
        .await
        .unwrap();
    let saved = paths.load_state().unwrap().unwrap();
    assert_eq!(saved.sacrum_image_ref, image);
    assert_eq!(saved.postgres_volume(), state.postgres_volume());
    assert_eq!(saved.docker_target, state.docker_target);
}

#[tokio::test]
async fn ready_startup_reuses_credentials_without_seeding() {
    let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
    state.provisioning_state = ProvisioningState::Ready;
    state.postgres_volume_initialized = true;
    let token = ApiToken::generate().unwrap();
    paths.ensure_api_token(&token).unwrap();
    let manager =
        LocalBackendManager::with_runtime(FakeRuntime::default(), MockHealth::with_results([true]));
    let saved =
        crate::local_backend::ensure_ready_stack(&manager, &paths, state.clone(), |url, saved| {
            assert_eq!(url, state.backend_url());
            assert_eq!(saved.as_str(), token.as_str());
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(saved, state);
    assert_eq!(
        manager.runtime.calls(),
        [
            "prepare",
            "volume",
            "start",
            "started status",
            "target",
            "files"
        ]
    );
}

#[tokio::test]
async fn seeding_failure_preserves_generated_token_and_records_failed_setup() {
    let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
    let manager = LocalBackendManager::with_runtime(
        FakeRuntime {
            fail: Some("seed"),
            ..Default::default()
        },
        MockHealth::with_results([true]),
    );
    let account = SeedAccount::new("person@example.test", "person", "password").unwrap();
    assert!(manager
        .provision_fresh(&paths, &mut state, account)
        .await
        .is_err());
    let token = paths.load_api_token().unwrap();
    assert_eq!(
        manager.runtime.calls(),
        [
            "prepare",
            "volume",
            "start",
            "exists",
            "started status",
            "target",
            "files",
            "files",
            "started status",
            "seed"
        ]
    );
    assert_eq!(
        paths.load_state().unwrap().unwrap().provisioning_state,
        ProvisioningState::Failed
    );
    assert_eq!(
        super::super::provisioning::ensure_api_token(&paths)
            .unwrap()
            .as_str(),
        token.as_str()
    );
}

#[tokio::test]
async fn missing_or_unsafe_existing_volumes_prevent_any_container_start() {
    for kind in [StackKind::Managed, StackKind::AdoptedLegacy] {
        for unsafe_metadata in [false, true] {
            let (_temp, paths, mut state) = stack_fixture(kind);
            state.postgres_volume_initialized = true;
            let runtime = FakeRuntime {
                volume_absent: true,
                volume_unsafe: unsafe_metadata,
                ..Default::default()
            };
            let manager = LocalBackendManager::with_runtime(runtime, MockHealth::default());
            let error = manager.up_detached(&paths, &mut state).await.unwrap_err();
            assert!(matches!(
                error,
                LocalBackendError::PersistentVolumeUnavailable { .. }
            ));
            assert_eq!(manager.runtime.calls(), ["prepare", "volume"]);
        }
    }
}

#[tokio::test]
async fn absent_volume_after_creation_is_not_recorded_as_initialized() {
    let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
    let runtime = FakeRuntime {
        volume_absent: true,
        ..Default::default()
    };
    let manager = LocalBackendManager::with_runtime(runtime, MockHealth::default());
    assert!(matches!(
        manager.up_detached(&paths, &mut state).await,
        Err(LocalBackendError::PersistentVolumeUnavailable { .. })
    ));
    assert!(!state.postgres_volume_initialized);
    assert_eq!(
        manager.runtime.calls(),
        ["prepare", "volume", "start", "exists"]
    );
}

#[tokio::test]
async fn adoption_uses_preserved_containers_without_creating_a_volume() {
    let (_temp, paths, mut state) = stack_fixture(StackKind::AdoptedLegacy);
    let original = state.clone();
    let manager = LocalBackendManager::with_runtime(FakeRuntime::default(), MockHealth::default());
    manager.up_adopted(&paths, &mut state).await.unwrap();
    assert_eq!(state, original);
    assert_eq!(
        manager.runtime.calls(),
        ["prepare", "volume", "adopted", "started status"]
    );
}

#[tokio::test]
async fn schema_one_saved_installation_resumes_without_new_runtime_metadata() {
    let (_temp, paths, _) = stack_fixture(StackKind::Managed);
    // The pre-extraction state shape deliberately has no runtime discriminator
    // or optional image metadata. Keep it independent of the current serializer.
    let saved_json = serde_json::json!({
        "schema_version": 1,
        "kind": "managed",
        "installation_id": "01234567-89ab-4cde-8fab-0123456789ab",
        "docker_target": crate::local_backend::compose::test_support::docker_target(),
        "sacrum_image_ref": crate::local_backend::compose::test_support::DIGEST_IMAGE,
        "image_channel": "backend-release",
        "provisioning_state": "ready",
        "postgres_volume_initialized": true,
        "host_port": 4400,
        "sacrum_bind_host": "127.0.0.1"
    });
    std::fs::write(&paths.state_file, serde_json::to_vec(&saved_json).unwrap()).unwrap();
    let before = paths.load_state().unwrap().unwrap();
    let token = ApiToken::generate().unwrap();
    paths.ensure_api_token(&token).unwrap();
    let manager =
        LocalBackendManager::with_runtime(FakeRuntime::default(), MockHealth::with_results([true]));
    assert!(
        crate::local_backend::ensure_for_startup_with(&paths, &manager, |_, _| Ok(()))
            .await
            .unwrap()
    );
    assert_eq!(paths.load_state().unwrap().unwrap(), before);
    assert_eq!(
        manager.runtime.calls(),
        [
            "prepare",
            "volume",
            "start",
            "started status",
            "target",
            "files"
        ]
    );
}
