//! The GUI selects a Docker runtime at the composition boundary. Shared startup,
//! provisioning, HTTP readiness, volume-preservation policy, and image-state
//! commits run through LocalBackendManager and the semantic ContainerRuntime
//! contract. Docker discovery, context validation, Compose commands, and metadata
//! parsing remain in compose. Saved schema-version-1 state is unchanged; this
//! extraction does not add runtime selection or Podman support.

mod command;
pub(crate) mod compose;
mod health;
mod manager;
pub(crate) mod manifest;
pub(crate) mod provisioning;
mod runtime;
pub(crate) mod state;

use compose::DockerCompose;
use health::HealthProbe;
use manager::LocalBackendManager;
use runtime::ContainerRuntime;
use state::{ApiToken, LocalBackendError, ManagedStackPaths, ManagedStackState, ProvisioningState};

pub(crate) async fn ensure_for_startup() -> Result<bool, LocalBackendError> {
    let paths = ManagedStackPaths::new()?;
    let Some(state) = paths.load_state()? else {
        return Ok(false);
    };
    let compose = DockerCompose::system_for(state.docker_target.clone())?;
    ensure_for_startup_with(&paths, &compose, |backend_url, api_token| {
        provisioning::persist_local_client_config(backend_url, api_token)
    })
    .await
}

async fn ensure_for_startup_with<T, H, F>(
    paths: &ManagedStackPaths,
    compose: &LocalBackendManager<T, H>,
    persist_client_config: F,
) -> Result<bool, LocalBackendError>
where
    T: ContainerRuntime,
    H: HealthProbe,
    F: Fn(&str, &ApiToken) -> Result<(), LocalBackendError>,
{
    let Some(state) = paths.load_state()? else {
        return Ok(false);
    };

    ensure_ready_stack(compose, paths, state, persist_client_config).await?;
    Ok(true)
}

async fn ensure_ready_stack<T, H, F>(
    compose: &LocalBackendManager<T, H>,
    paths: &ManagedStackPaths,
    mut state: ManagedStackState,
    persist_client_config: F,
) -> Result<ManagedStackState, LocalBackendError>
where
    T: ContainerRuntime,
    H: HealthProbe,
    F: Fn(&str, &ApiToken) -> Result<(), LocalBackendError>,
{
    if state.provisioning_state != ProvisioningState::Ready {
        return Err(LocalBackendError::InvalidState(
            "saved local backend setup is not ready; complete local setup before startup"
                .to_string(),
        ));
    }

    compose.up_detached(paths, &mut state).await?;
    compose.wait_until_healthy(paths, &state).await?;
    let api_token = paths.load_api_token()?;
    compose.authenticate_backend(&state, &api_token).await?;
    persist_client_config(&state.backend_url(), &api_token)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::command::CommandOutput;
    use super::compose::test_support::{controller, stack_fixture, MockHealth, MockRunner};
    use super::state::{ApiToken, ProvisioningState, StackKind};
    use super::*;

    #[tokio::test]
    async fn startup_without_saved_state_does_not_touch_docker() {
        let temp = tempfile::tempdir().expect("create data directory");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let runner = MockRunner::default();
        let compose = controller(runner.clone(), MockHealth::default());

        let ensured = ensure_for_startup_with(&paths, &compose, |_, _| Ok(()))
            .await
            .expect("missing state is a direct-config startup");

        assert!(!ensured);
        assert!(runner.requests().is_empty());
    }

    #[tokio::test]
    async fn startup_rejects_saved_state_that_is_not_ready() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
        state.provisioning_state = ProvisioningState::Pending;
        paths.save_state(&state).expect("save pending state");
        let runner = MockRunner::default();
        let compose = controller(runner.clone(), MockHealth::default());

        let error = ensure_for_startup_with(&paths, &compose, |_, _| Ok(()))
            .await
            .expect_err("incomplete setup must not be started");

        assert!(
            matches!(error, LocalBackendError::InvalidState(message) if message.contains("not ready"))
        );
        assert!(runner.requests().is_empty());
    }

    #[tokio::test]
    async fn startup_reconciles_a_ready_stack_and_reuses_the_saved_token() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
        state.provisioning_state = ProvisioningState::Ready;
        paths.save_state(&state).expect("save ready state");
        let configured_token =
            ApiToken::new(format!("sac_{}", "c".repeat(64))).expect("valid saved token");
        paths
            .ensure_api_token(&configured_token)
            .expect("persist saved token");
        let saved_token = paths.load_api_token().expect("load saved token");
        let endpoint = state.docker_target.endpoint.clone();
        let runner = MockRunner::with_outputs([
            CommandOutput::success(endpoint.as_str()),
            CommandOutput::success("28.0.0"),
            CommandOutput::success("2.30.0"),
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(""),
            CommandOutput::success(state.postgres_volume()),
            CommandOutput::success(""),
            CommandOutput::success(endpoint.as_str()),
        ]);
        let compose = controller(runner.clone(), MockHealth::with_results([true]));
        let persisted = Arc::new(Mutex::new(None::<(String, String)>));
        let captured = persisted.clone();

        let ensured = ensure_for_startup_with(&paths, &compose, move |url, token| {
            *captured.lock().expect("capture lock") =
                Some((url.to_string(), token.as_str().to_string()));
            Ok(())
        })
        .await
        .expect("ready stack should be reconciled");

        assert!(ensured);
        assert_eq!(
            *persisted.lock().expect("capture lock"),
            Some((state.backend_url(), saved_token.as_str().to_string()))
        );
        assert!(
            paths
                .load_state()
                .expect("load reconciled state")
                .expect("state exists")
                .postgres_volume_initialized
        );
        assert!(runner.requests().iter().all(|request| {
            !request
                .args_as_strings()
                .iter()
                .any(|argument| argument == "down")
        }));
    }
}
