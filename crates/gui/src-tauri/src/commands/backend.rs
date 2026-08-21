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
    pub generated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LocalBackendUpdateStatus {
    pub management: String,
    pub configured: bool,
    pub channel: Option<String>,
    pub current_version: Option<String>,
    pub current_build: Option<String>,
    pub current_image_ref: Option<String>,
    pub current_generated_at: Option<String>,
    pub latest: Option<LocalBackendUpdateRelease>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LocalBackendUpdateResult {
    pub channel: String,
    pub version: String,
    pub build: String,
    pub image_ref: String,
    pub generated_at: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn check_local_backend_update() -> Result<LocalBackendUpdateStatus, CommandError> {
    let paths = ManagedStackPaths::new().map_err(local_backend_error)?;
    let configured_management = configured_backend_management()?;
    if configured_management == "external" {
        return Ok(LocalBackendUpdateStatus {
            management: configured_management.to_string(),
            configured: true,
            channel: None,
            current_version: None,
            current_build: None,
            current_image_ref: None,
            current_generated_at: None,
            latest: None,
            available: false,
        });
    }
    let Some(state) = paths.load_state().map_err(local_backend_error)? else {
        return Ok(LocalBackendUpdateStatus {
            management: configured_management.to_string(),
            configured: false,
            channel: None,
            current_version: None,
            current_build: None,
            current_image_ref: None,
            current_generated_at: None,
            latest: None,
            available: false,
        });
    };

    let manifest = BackendManifestClient::default()
        .fetch(state.image_channel)
        .await
        .map_err(local_backend_error)?;
    let available = manifest.requires_image_update(&state);
    let (current_version, current_build, current_generated_at) = current_backend_release_metadata(
        state.sacrum_version,
        state.sacrum_build,
        state.sacrum_image_created_at,
        &manifest.version,
        &manifest.build,
        manifest.generated_at.as_deref(),
        available,
    );

    Ok(LocalBackendUpdateStatus {
        management: "managed_local".to_string(),
        configured: true,
        channel: Some(state.image_channel.manifest_channel().to_string()),
        current_version,
        current_build,
        current_image_ref: Some(state.sacrum_image_ref),
        current_generated_at,
        latest: Some(LocalBackendUpdateRelease {
            channel: manifest.channel,
            version: manifest.version,
            build: manifest.build,
            image_ref: manifest.image_ref,
            generated_at: manifest.generated_at,
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
        .update_sacrum_image(
            &paths,
            &state,
            &manifest.image_ref,
            Some(&manifest.version),
            Some(&manifest.build),
            manifest.generated_at.as_deref(),
        )
        .await
        .map_err(local_backend_error)?;

    Ok(LocalBackendUpdateResult {
        channel: manifest.channel,
        version: manifest.version,
        build: manifest.build,
        image_ref: manifest.image_ref,
        generated_at: manifest.generated_at,
    })
}

fn configured_backend_management() -> Result<&'static str, CommandError> {
    if let Some(url) = std::env::var_os("VTB_URL").filter(|url| !url.is_empty()) {
        return Ok(backend_management_for_url(&url.to_string_lossy()));
    }

    let config_path = vertebrae_sacrum_client::config_path();
    if !config_path.as_ref().is_some_and(|path| path.exists()) {
        return Ok("not_configured");
    }

    let config = vertebrae_sacrum_client::load_config_file().map_err(|error| CommandError {
        message: format!("Failed to load config file: {error}"),
    })?;
    Ok(backend_management_for_url(&config.sacrum.url))
}

fn backend_management_for_url(url: &str) -> &'static str {
    let parsed = url::Url::parse(url).ok();
    let host = parsed.as_ref().and_then(url::Url::host_str);
    if host.is_some_and(is_loopback_host) {
        "not_configured"
    } else if host.is_some() {
        "external"
    } else {
        "not_configured"
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn current_backend_release_metadata(
    stored_version: Option<String>,
    stored_build: Option<String>,
    stored_generated_at: Option<String>,
    manifest_version: &str,
    manifest_build: &str,
    manifest_generated_at: Option<&str>,
    update_available: bool,
) -> (Option<String>, Option<String>, Option<String>) {
    (
        stored_version.or_else(|| (!update_available).then(|| manifest_version.to_string())),
        stored_build.or_else(|| (!update_available).then(|| manifest_build.to_string())),
        stored_generated_at.or_else(|| {
            (!update_available)
                .then(|| manifest_generated_at.map(str::to_string))
                .flatten()
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::{backend_management_for_url, current_backend_release_metadata};

    #[test]
    fn classifies_backend_urls_by_management() {
        assert_eq!(
            backend_management_for_url("https://backend.example.test/api"),
            "external"
        );
        assert_eq!(
            backend_management_for_url("http://localhost:4400"),
            "not_configured"
        );
        assert_eq!(
            backend_management_for_url("http://127.0.0.1:4400"),
            "not_configured"
        );
        assert_eq!(backend_management_for_url("not-a-url"), "not_configured");
    }

    #[test]
    fn uses_manifest_metadata_when_the_current_image_is_up_to_date() {
        assert_eq!(
            current_backend_release_metadata(
                None,
                None,
                None,
                "0.4.0",
                "abcdef12",
                Some("2026-08-21T00:00:00Z"),
                false,
            ),
            (
                Some("0.4.0".to_string()),
                Some("abcdef12".to_string()),
                Some("2026-08-21T00:00:00Z".to_string())
            )
        );
    }

    #[test]
    fn does_not_use_latest_manifest_metadata_for_an_older_image() {
        assert_eq!(
            current_backend_release_metadata(
                None,
                None,
                None,
                "0.5.0",
                "12345678",
                Some("2026-08-22T00:00:00Z"),
                true,
            ),
            (None, None, None)
        );
    }
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
