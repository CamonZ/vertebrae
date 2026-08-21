use super::*;

use crate::events::{LocalBackendProgressEvent, LocalBackendProgressStage};
use crate::local_backend::compose::{DockerCompose, LegacyStackDetection};
use crate::local_backend::manifest::BackendManifestClient;
use crate::local_backend::provisioning::{self, ProvisioningResult};
use crate::local_backend::state::{
    ApiToken, BackendImageChannel, LocalBackendError, ManagedStackPaths, ManagedStackState,
    ProvisioningStage, ProvisioningState, SeedAccount, StackKind, LOCAL_SACRUM_IMAGE_REF,
};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LocalBackendSetupResult {
    pub status: LocalBackendSetupStatus,
    pub backend_url: Option<String>,
    pub adoption_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LocalBackendSetupStatus {
    Ready,
    AdoptionRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LocalBackendUpdateRelease {
    pub channel: String,
    pub version: String,
    pub build: String,
    pub image_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LocalBackendUpdateStatus {
    pub configured: bool,
    pub channel: Option<String>,
    pub current_image_ref: Option<String>,
    pub latest: Option<LocalBackendUpdateRelease>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LocalBackendUpdateResult {
    pub channel: String,
    pub version: String,
    pub build: String,
    pub image_ref: String,
}

#[tauri::command]
#[specta::specta]
pub async fn check_local_backend_update() -> Result<LocalBackendUpdateStatus, CommandError> {
    let paths = ManagedStackPaths::new().map_err(local_backend_error)?;
    let Some(state) = paths.load_state().map_err(local_backend_error)? else {
        return Ok(LocalBackendUpdateStatus {
            configured: false,
            channel: None,
            current_image_ref: None,
            latest: None,
            available: false,
        });
    };

    let manifest = BackendManifestClient::default()
        .fetch(state.image_channel)
        .await
        .map_err(local_backend_error)?;
    let available = manifest.requires_image_update(&state);

    Ok(LocalBackendUpdateStatus {
        configured: true,
        channel: Some(state.image_channel.manifest_channel().to_string()),
        current_image_ref: Some(state.sacrum_image_ref),
        latest: Some(LocalBackendUpdateRelease {
            channel: manifest.channel,
            version: manifest.version,
            build: manifest.build,
            image_ref: manifest.image_ref,
        }),
        available,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn apply_approved_local_backend_update(
    approved: bool,
    channel: String,
    version: String,
    build: String,
    image_ref: String,
) -> Result<LocalBackendUpdateResult, CommandError> {
    if !approved {
        return Err(CommandError {
            message: "Explicit GUI approval is required before applying a local backend update."
                .to_string(),
        });
    }

    let paths = ManagedStackPaths::new().map_err(local_backend_error)?;
    let state = paths
        .load_state()
        .map_err(local_backend_error)?
        .ok_or_else(|| {
            local_backend_error(LocalBackendError::InvalidState(
                "a configured local backend is required before applying an update".to_string(),
            ))
        })?;
    if state.provisioning_state != ProvisioningState::Ready {
        return Err(local_backend_error(LocalBackendError::InvalidState(
            "the local backend must be ready before applying an update".to_string(),
        )));
    }

    let manifest = BackendManifestClient::default()
        .fetch(state.image_channel)
        .await
        .map_err(local_backend_error)?;
    if manifest.channel != channel
        || manifest.version != version
        || manifest.build != build
        || manifest.image_ref != image_ref
    {
        return Err(local_backend_error(LocalBackendError::InvalidState(
            "the approved local backend release is no longer current; check for updates again"
                .to_string(),
        )));
    }
    if !manifest.requires_image_update(&state) {
        return Err(local_backend_error(LocalBackendError::InvalidState(
            "the configured local backend is already up to date".to_string(),
        )));
    }

    let compose =
        DockerCompose::system_for(state.docker_target.clone()).map_err(local_backend_error)?;
    compose
        .update_sacrum_image(&paths, &state, &manifest.image_ref)
        .await
        .map_err(local_backend_error)?;

    Ok(LocalBackendUpdateResult {
        channel: manifest.channel,
        version: manifest.version,
        build: manifest.build,
        image_ref: manifest.image_ref,
    })
}

/// Provision or adopt the local Sacrum backend and persist its generated
/// connection settings before project initialization begins.
#[tauri::command]
#[specta::specta]
pub async fn setup_local_backend(
    app_handle: AppHandle,
    adopt_legacy: bool,
) -> Result<LocalBackendSetupResult, CommandError> {
    let paths = ManagedStackPaths::new().map_err(local_backend_error)?;
    let compose = DockerCompose::system().await.map_err(local_backend_error)?;
    let detection = compose
        .detect_legacy_stack()
        .await
        .map_err(local_backend_error)?;

    let mut state = match &detection {
        LegacyStackDetection::Compatible(_candidate) if !adopt_legacy => {
            return Ok(LocalBackendSetupResult {
                status: LocalBackendSetupStatus::AdoptionRequired,
                backend_url: None,
                adoption_message: Some(
                    "An existing vertebrae-dev backend was found. Confirm adoption to preserve its database and continue setup.".to_string(),
                ),
            });
        }
        LegacyStackDetection::HostPortRequired => {
            return Err(local_backend_error(
                LocalBackendError::LegacyHostPortRequired,
            ));
        }
        LegacyStackDetection::Unsafe(reason) => {
            return Err(local_backend_error(LocalBackendError::UnsafeLegacyStack(
                reason.clone(),
            )));
        }
        LegacyStackDetection::Compatible(candidate) => compose
            .adopt_legacy_stack(
                &paths,
                &detection,
                Some(candidate.host_port),
                LOCAL_SACRUM_IMAGE_REF,
                BackendImageChannel::BackendMaster,
                true,
            )
            .await
            .map_err(local_backend_error)?,
        LegacyStackDetection::Absent => match paths.load_state().map_err(local_backend_error)? {
            Some(existing) if existing.kind == StackKind::AdoptedLegacy => {
                return Err(local_backend_error(LocalBackendError::UnsafeLegacyStack(
                    "saved adoption state exists but vertebrae-dev was not detected".to_string(),
                )));
            }
            Some(existing) => existing,
            None => ManagedStackState::fresh(
                LOCAL_SACRUM_IMAGE_REF,
                crate::local_backend::state::select_host_port(0).map_err(local_backend_error)?,
                BackendImageChannel::BackendMaster,
                compose.target().clone(),
            )
            .map_err(local_backend_error)?,
        },
    };

    let progress = |stage| emit_progress(&app_handle, stage);
    if state.provisioning_state == ProvisioningState::Ready {
        progress(ProvisioningStage::Health);
        compose
            .wait_until_healthy(&paths, &state)
            .await
            .map_err(local_backend_error)?;
        let _services = compose
            .status(&paths, &state)
            .await
            .map_err(local_backend_error)?;
        let api_token = provisioning::ensure_api_token(&paths).map_err(local_backend_error)?;
        provisioning::persist_local_client_config(&state.backend_url(), &api_token)
            .map_err(local_backend_error)?;
        return Ok(ready_result(state.backend_url()));
    }

    let result = if state.kind == StackKind::AdoptedLegacy {
        let api_token = configured_api_token().map_err(local_backend_error)?;
        compose
            .provision_adopted(&paths, &mut state, api_token, progress)
            .await
    } else {
        let account = SeedAccount::generated_for_installation(state.installation_id)
            .map_err(local_backend_error)?;
        compose
            .provision_fresh_with_progress(&paths, &mut state, account, progress)
            .await
    };

    result
        .map(ready_result_from_provisioning)
        .map_err(local_backend_error)
}

fn configured_api_token() -> Result<ApiToken, LocalBackendError> {
    let config = vertebrae_sacrum_client::load_config_file().map_err(|error| {
        LocalBackendError::InvalidState(format!(
            "could not load the configured backend token for adoption: {error}"
        ))
    })?;
    let token = config
        .sacrum
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            LocalBackendError::InvalidState(
                "adopting an existing local backend requires an API token in config.toml"
                    .to_string(),
            )
        })?;
    ApiToken::new(token.to_string())
}

fn ready_result_from_provisioning(result: ProvisioningResult) -> LocalBackendSetupResult {
    ready_result(result.backend_url)
}

fn ready_result(backend_url: String) -> LocalBackendSetupResult {
    LocalBackendSetupResult {
        status: LocalBackendSetupStatus::Ready,
        backend_url: Some(backend_url),
        adoption_message: None,
    }
}

fn emit_progress(app_handle: &AppHandle, stage: ProvisioningStage) {
    let (stage, message) = match stage {
        ProvisioningStage::Pulling => (
            LocalBackendProgressStage::Pulling,
            "Pulling the local backend and PostgreSQL images...",
        ),
        ProvisioningStage::Migrating => (
            LocalBackendProgressStage::Migrating,
            "Applying backend database migrations...",
        ),
        ProvisioningStage::Health => (
            LocalBackendProgressStage::Health,
            "Waiting for backend health checks...",
        ),
        ProvisioningStage::Seeding => (
            LocalBackendProgressStage::Seeding,
            "Creating the local backend account...",
        ),
    };
    let _ = app_handle.emit(
        "local-backend-progress-event",
        LocalBackendProgressEvent {
            stage,
            message: message.to_string(),
        },
    );
}

fn local_backend_error(error: LocalBackendError) -> CommandError {
    let diagnostic = error.diagnostic();
    log::warn!(
        "local backend setup failed [{}]: {}",
        diagnostic.code,
        diagnostic.message
    );
    CommandError {
        message: diagnostic.message,
    }
}
