mod command;
pub(crate) mod compose;
pub(crate) mod manifest;
pub(crate) mod provisioning;
pub(crate) mod state;

use command::ProcessRunner;
use compose::{DockerCompose, HealthProbe};
use manifest::BackendManifestClient;
use state::{LocalBackendError, ManagedStackPaths, ManagedStackState, ProvisioningState};

pub(crate) async fn ensure_for_startup() -> Result<bool, LocalBackendError> {
    let paths = ManagedStackPaths::new()?;
    let Some(state) = paths.load_state()? else {
        return Ok(false);
    };

    let compose = DockerCompose::system_for(state.docker_target.clone())?;
    ensure_ready_stack(&compose, &paths, state).await?;
    Ok(true)
}

async fn ensure_ready_stack<R, H>(
    compose: &DockerCompose<R, H>,
    paths: &ManagedStackPaths,
    mut state: ManagedStackState,
) -> Result<ManagedStackState, LocalBackendError>
where
    R: ProcessRunner,
    H: HealthProbe,
{
    if state.provisioning_state != ProvisioningState::Ready {
        return Err(LocalBackendError::InvalidState(
            "saved local backend setup is not ready; complete local setup before startup"
                .to_string(),
        ));
    }

    compose.up_detached(paths, &mut state).await?;
    compose.wait_until_healthy(paths, &state).await?;
    let manifest = BackendManifestClient::default()
        .fetch(state.image_channel)
        .await?;
    if manifest.requires_image_update(&state) {
        compose
            .update_sacrum_image(paths, &state, &manifest.image_ref)
            .await?;
    }
    let api_token = paths.load_api_token()?;
    provisioning::persist_local_client_config(&state.backend_url(), &api_token)?;
    Ok(state)
}
