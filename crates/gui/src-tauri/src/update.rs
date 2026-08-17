//! Signed, GUI-approved component update transaction.
//!
//! Discovery is read-only. Approval verifies and stages every artifact,
//! activates sidecars with rollback, then installs the GUI without relaunching.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fs2::available_space;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;
use url::Url;
use vertebrae_installer::{
    data_bin_dir, data_dir, relaunch_service_if_registered, service_status, symlink_path,
    BinaryTransaction, InstallerError, ServiceRelaunch, ServiceStatus,
};

use crate::commands::CommandError;

const COMPONENT_MANIFEST_BASE: &str =
    "https://github.com/CamonZ/vertebrae/releases/download/channel-";
const GUI_MANIFEST_BASE: &str = "https://github.com/CamonZ/vertebrae/releases/download/channel-";
const TARGET_TRIPLE: &str = env!("TAURI_ENV_TARGET_TRIPLE");
const COMPONENT_ORDER: [ComponentSpec; 3] = [
    ComponentSpec {
        manifest_key: "cli",
        binary_name: "vtb",
    },
    ComponentSpec {
        manifest_key: "daemon",
        binary_name: "vtb-daemon",
    },
    ComponentSpec {
        manifest_key: "gate",
        binary_name: "vtb-gate",
    },
];
const GUI_COMPONENT_KEY: &str = "gui";
const MIN_FREE_SPACE: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
struct ComponentSpec {
    manifest_key: &'static str,
    binary_name: &'static str,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateComponentState {
    Pending,
    Downloaded,
    Verified,
    Staged,
    Activated,
    HealthChecked,
    PendingRelaunch,
    RolledBack,
    Failed,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct UpdateComponentResult {
    pub component: String,
    pub state: UpdateComponentState,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateTransactionState {
    Preflight,
    Downloading,
    Verifying,
    Activating,
    HealthChecked,
    DeferredRelaunch,
    Success,
    PartialFailure,
    RetryableFailure,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct UpdateTransactionResult {
    pub transaction_id: Option<String>,
    pub state: UpdateTransactionState,
    pub channel: String,
    pub version: String,
    pub build: String,
    pub progress: Vec<UpdateComponentResult>,
    pub compatibility: String,
    pub signature: String,
    pub hash: String,
    pub disk: String,
    pub component_readiness: String,
    pub daemon_service: String,
    pub recovery_action: Option<String>,
    pub restart_forced: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseManifest {
    schema: u32,
    channel: String,
    generated_at: String,
    components: HashMap<String, ArtifactManifest>,
    signature: String,
    public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ArtifactManifest {
    version: String,
    build: String,
    target: String,
    url: String,
    sha256: String,
    size: u64,
    signature: String,
    public_key: String,
}

/// The approval gate runs before any network or filesystem work.
#[tauri::command]
#[specta::specta]
pub async fn apply_approved_component_update(
    app_handle: AppHandle,
    approved: bool,
    channel: String,
    version: String,
    build: Option<String>,
) -> Result<UpdateTransactionResult, CommandError> {
    require_explicit_approval(approved)?;

    let expected_build = build.filter(|value| !value.trim().is_empty());
    let mut result = empty_result(&channel, &version, expected_build.as_deref());
    let manifest = match load_component_manifest(&channel).await {
        Ok(manifest) => manifest,
        Err(error) => return Ok(failed_result(result, error, true)),
    };

    if let Err(error) = validate_preflight(&channel, &version, expected_build.as_deref(), &manifest)
    {
        return Ok(failed_result(result, error, true));
    }
    result.build = manifest
        .components
        .values()
        .next()
        .map(|artifact| artifact.build.clone())
        .unwrap_or_default();
    result.compatibility = format!("{} / {}", TARGET_TRIPLE, version);
    result.signature = "Signed component manifest verified".to_string();
    result.hash = "SHA-256 checks required for all artifacts".to_string();
    result.disk = "Sufficient space available".to_string();
    result.component_readiness = "GUI-managed component paths ready".to_string();
    emit_progress(&app_handle, &result);

    let gui_update = match load_gui_update(
        &app_handle,
        &channel,
        &version,
        expected_build.as_deref(),
        &manifest,
    )
    .await
    {
        Ok(update) => update,
        Err(error) => return Ok(failed_result(result, error, true)),
    };
    result.progress[3].state = UpdateComponentState::Verified;
    result.progress[3].message = "Signed GUI updater metadata verified".to_string();
    emit_progress(&app_handle, &result);

    let gui_bytes = match download_gui_artifact(&gui_update, &manifest).await {
        Ok(bytes) => bytes,
        Err(error) => return Ok(failed_result(result, error, true)),
    };

    result.state = UpdateTransactionState::Downloading;
    let staging_dir = match make_staging_dir(&version, expected_build.as_deref()) {
        Ok(path) => path,
        Err(error) => return Ok(failed_result(result, error, true)),
    };
    let mut sources = Vec::with_capacity(COMPONENT_ORDER.len());
    if let Err(error) = download_and_verify_components(
        &manifest,
        &staging_dir,
        &mut result,
        &mut sources,
        &app_handle,
    )
    .await
    {
        remove_staging_dir(&staging_dir);
        return Ok(failed_result(result, error, true));
    }

    result.progress[3].state = UpdateComponentState::Downloaded;
    result.progress[3].message = "GUI artifact downloaded and Tauri signature verified".to_string();
    emit_progress(&app_handle, &result);

    result.state = UpdateTransactionState::Activating;
    let activation_sources: Vec<(&str, &Path)> = COMPONENT_ORDER
        .iter()
        .zip(sources.iter())
        .map(|(spec, path)| (spec.binary_name, path.as_path()))
        .collect();
    let daemon_changed = match managed_daemon_artifact_changed(&sources[1]) {
        Ok(changed) => changed,
        Err(error) => {
            remove_staging_dir(&staging_dir);
            return Ok(failed_result(result, error, true));
        }
    };
    let daemon_was_registered = if daemon_changed {
        match service_status() {
            Ok(ServiceStatus::NotLoaded) => false,
            Ok(ServiceStatus::Running { .. } | ServiceStatus::Loaded { .. }) => true,
            Err(error) => {
                remove_staging_dir(&staging_dir);
                return Ok(failed_result(
                    result,
                    update_error(format!(
                        "Could not inspect daemon service registration before activation: {error}"
                    )),
                    true,
                ));
            }
        }
    } else {
        false
    };
    let transaction = match BinaryTransaction::activate(&activation_sources) {
        Ok(transaction) => transaction,
        Err(error) => {
            remove_staging_dir(&staging_dir);
            return Ok(failed_result(
                result,
                update_error(format!(
                    "Activation failed and previous components were restored: {error:?}"
                )),
                false,
            ));
        }
    };
    for index in 0..COMPONENT_ORDER.len() {
        result.progress[index].state = UpdateComponentState::Activated;
        result.progress[index].message = "Atomically activated".to_string();
    }
    emit_progress(&app_handle, &result);

    if let Err(error) = verify_managed_component_links() {
        let error = rollback_failure(&transaction, error, false);
        remove_staging_dir(&staging_dir);
        return Ok(failed_result(result, error, false));
    }

    let daemon_lifecycle = match reconcile_daemon_service(
        daemon_changed,
        daemon_was_registered,
        relaunch_service_if_registered,
        service_status,
    ) {
        Ok(outcome) => outcome,
        Err(error) => {
            let error =
                rollback_failure(&transaction, error, daemon_changed && daemon_was_registered);
            remove_staging_dir(&staging_dir);
            return Ok(failed_result(result, error, false));
        }
    };
    result.daemon_service = daemon_lifecycle.message.clone();
    result.state = UpdateTransactionState::HealthChecked;
    for index in 0..COMPONENT_ORDER.len() {
        result.progress[index].state = UpdateComponentState::HealthChecked;
        result.progress[index].message = "Managed symlink verified".to_string();
    }
    result.progress[1].message = daemon_lifecycle.message.clone();
    emit_progress(&app_handle, &result);

    // The Tauri updater has already verified the GUI archive before install.
    // Its platform-specific install is atomic and does not relaunch on the
    // supported macOS/Linux targets. Sidecars are rolled back if it fails.
    if let Err(error) = gui_update.install(gui_bytes) {
        let error = rollback_failure(
            &transaction,
            update_error(error.to_string()),
            daemon_lifecycle.restarted,
        );
        remove_staging_dir(&staging_dir);
        return Ok(failed_result(result, error, false));
    }
    transaction.commit();
    remove_staging_dir(&staging_dir);

    result.progress[3].state = UpdateComponentState::PendingRelaunch;
    result.progress[3].message = "Installed; GUI relaunch remains deferred".to_string();
    result.state = UpdateTransactionState::DeferredRelaunch;
    result.recovery_action = Some(
        "Update completed without a forced restart. Relaunch the GUI later to use the new GUI build.".to_string(),
    );
    result.restart_forced = false;
    emit_progress(&app_handle, &result);
    Ok(result)
}

fn require_explicit_approval(approved: bool) -> Result<(), CommandError> {
    if approved {
        Ok(())
    } else {
        Err(update_error(
            "Explicit GUI approval is required before applying an update.",
        ))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn relaunch_application(app_handle: AppHandle) -> Result<(), CommandError> {
    app_handle.restart();
}

async fn download_and_verify_components(
    manifest: &ReleaseManifest,
    staging_dir: &Path,
    result: &mut UpdateTransactionResult,
    sources: &mut Vec<PathBuf>,
    app_handle: &AppHandle,
) -> Result<(), CommandError> {
    for (index, spec) in COMPONENT_ORDER.iter().enumerate() {
        let artifact = manifest.components.get(spec.manifest_key).ok_or_else(|| {
            update_error(format!(
                "Signed manifest does not contain component '{}'",
                spec.manifest_key
            ))
        })?;
        let bytes = download_bytes(&artifact.url).await?;
        let progress = &mut result.progress[index];
        progress.state = UpdateComponentState::Downloaded;
        progress.message = format!("Downloaded {} bytes", bytes.len());

        verify_artifact(spec.manifest_key, artifact, &bytes)?;
        progress.state = UpdateComponentState::Verified;
        progress.message = "Signature, SHA-256, size, target, and identity verified".to_string();

        let destination = staging_dir.join(spec.binary_name);
        fs::write(&destination, &bytes).map_err(|error| {
            update_error(format!(
                "Could not stage {} artifact: {error}",
                spec.manifest_key
            ))
        })?;
        sources.push(destination);
        progress.state = UpdateComponentState::Staged;
        progress.message = "Artifact staged before activation".to_string();
        emit_progress(app_handle, result);
    }
    Ok(())
}

fn empty_result(channel: &str, version: &str, build: Option<&str>) -> UpdateTransactionResult {
    UpdateTransactionResult {
        transaction_id: None,
        state: UpdateTransactionState::Preflight,
        channel: channel.to_string(),
        version: version.to_string(),
        build: build.unwrap_or_default().to_string(),
        progress: COMPONENT_ORDER
            .iter()
            .map(|spec| spec.manifest_key)
            .chain(std::iter::once(GUI_COMPONENT_KEY))
            .map(|component| UpdateComponentResult {
                component: component.to_string(),
                state: UpdateComponentState::Pending,
                message: "Waiting for preflight".to_string(),
            })
            .collect(),
        compatibility: "Pending".to_string(),
        signature: "Pending".to_string(),
        hash: "Pending".to_string(),
        disk: "Pending".to_string(),
        component_readiness: "Pending".to_string(),
        daemon_service: "Not checked".to_string(),
        recovery_action: None,
        restart_forced: false,
    }
}

fn failed_result(
    mut result: UpdateTransactionResult,
    error: CommandError,
    retryable: bool,
) -> UpdateTransactionResult {
    result.state = if retryable {
        UpdateTransactionState::RetryableFailure
    } else {
        UpdateTransactionState::PartialFailure
    };
    result.recovery_action = Some(if retryable {
        format!(
            "No components were activated; correct the release or network issue and retry: {}",
            error.message
        )
    } else {
        format!(
            "Previous active components were preserved or restored; retry the approved release: {}",
            error.message
        )
    });
    for component in &mut result.progress {
        if !retryable && component.component != GUI_COMPONENT_KEY {
            component.state = UpdateComponentState::RolledBack;
            component.message = "Previous active component preserved".to_string();
        } else if !matches!(
            component.state,
            UpdateComponentState::Activated
                | UpdateComponentState::HealthChecked
                | UpdateComponentState::RolledBack
        ) {
            component.state = UpdateComponentState::Failed;
            component.message = error.message.clone();
        }
    }
    result
}

fn validate_preflight(
    channel: &str,
    version: &str,
    expected_build: Option<&str>,
    manifest: &ReleaseManifest,
) -> Result<(), CommandError> {
    if manifest.schema != 1 {
        return Err(update_error(format!(
            "Unsupported component manifest schema {}",
            manifest.schema
        )));
    }
    if !matches!(channel, "master" | "release") || manifest.channel != channel {
        return Err(update_error(
            "Selected update channel does not match the signed manifest",
        ));
    }
    if version.is_empty()
        || manifest
            .components
            .values()
            .any(|artifact| artifact.version != version)
    {
        return Err(update_error(
            "Selected release version does not match the signed artifacts",
        ));
    }
    if let Some(build) = expected_build {
        if manifest
            .components
            .values()
            .any(|artifact| artifact.build != build)
        {
            return Err(update_error(
                "Selected release build does not match the signed artifacts",
            ));
        }
    }
    verify_manifest_signature(manifest)?;
    for spec in COMPONENT_ORDER {
        let artifact = manifest.components.get(spec.manifest_key).ok_or_else(|| {
            update_error(format!(
                "Signed manifest is missing required component '{}'",
                spec.manifest_key
            ))
        })?;
        if artifact.target != TARGET_TRIPLE {
            return Err(update_error(format!(
                "Component '{}' targets {}, expected {TARGET_TRIPLE}",
                spec.manifest_key, artifact.target
            )));
        }
        if artifact.url.parse::<Url>().is_err() || !artifact.url.starts_with("https://") {
            return Err(update_error(format!(
                "Component '{}' has an unsafe artifact URL",
                spec.manifest_key
            )));
        }
        if artifact.sha256.len() != 64
            || !artifact
                .sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(update_error(format!(
                "Component '{}' has an invalid SHA-256",
                spec.manifest_key
            )));
        }
        if artifact.public_key != manifest.public_key {
            return Err(update_error(format!(
                "Component '{}' has a different signing identity",
                spec.manifest_key
            )));
        }
        if !is_managed_or_absent(spec.binary_name)? {
            return Err(update_error(format!(
                "Component '{}' is not GUI-managed",
                spec.manifest_key
            )));
        }
    }
    let gui = manifest
        .components
        .get(GUI_COMPONENT_KEY)
        .ok_or_else(|| update_error("Signed manifest is missing required component 'gui'"))?;
    if gui.target != TARGET_TRIPLE {
        return Err(update_error(format!(
            "Component 'gui' targets {}, expected {TARGET_TRIPLE}",
            gui.target
        )));
    }
    if gui.url.parse::<Url>().is_err() || !gui.url.starts_with("https://") {
        return Err(update_error("Component 'gui' has an unsafe artifact URL"));
    }
    if gui.sha256.len() != 64
        || !gui
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(update_error("Component 'gui' has an invalid SHA-256"));
    }
    if gui.public_key != manifest.public_key {
        return Err(update_error(
            "Component 'gui' has a different signing identity",
        ));
    }
    let total_size: u64 = COMPONENT_ORDER
        .iter()
        .filter_map(|spec| manifest.components.get(spec.manifest_key))
        .map(|artifact| artifact.size)
        .sum::<u64>()
        + gui.size;
    let root = data_dir().map_err(|error| update_error(error.to_string()))?;
    fs::create_dir_all(&root).map_err(|error| update_error(error.to_string()))?;
    if available_space(&root).map_err(|error| update_error(error.to_string()))?
        < total_size + MIN_FREE_SPACE
    {
        return Err(update_error(
            "Not enough disk space for the verified release",
        ));
    }
    Ok(())
}

fn verify_manifest_signature(manifest: &ReleaseManifest) -> Result<(), CommandError> {
    let mut payload = format!(
        "vertebrae-manifest-v1\nschema={}\nchannel={}\ngenerated_at={}\n",
        manifest.schema, manifest.channel, manifest.generated_at
    );
    for component in ["gui", "cli", "daemon", "gate"] {
        if let Some(artifact) = manifest.components.get(component) {
            payload.push_str(&signature_payload(component, artifact));
        }
    }
    verify_signature(&manifest.public_key, &payload, &manifest.signature)
}

fn verify_artifact(
    component: &str,
    artifact: &ArtifactManifest,
    bytes: &[u8],
) -> Result<(), CommandError> {
    if bytes.len() as u64 != artifact.size {
        return Err(update_error(format!(
            "Artifact '{component}' size does not match the signed manifest"
        )));
    }
    let digest = hex_digest(bytes);
    if digest != artifact.sha256.to_ascii_lowercase() {
        return Err(update_error(format!(
            "Artifact '{component}' SHA-256 verification failed"
        )));
    }
    verify_signature(
        &artifact.public_key,
        &signature_payload(component, artifact),
        &artifact.signature,
    )
}

fn signature_payload(component: &str, artifact: &ArtifactManifest) -> String {
    format!(
        "vertebrae-artifact-v1\ncomponent={component}\nversion={}\nbuild={}\ntarget={}\nurl={}\nsha256={}\nsize={}\n",
        artifact.version, artifact.build, artifact.target, artifact.url, artifact.sha256, artifact.size
    )
}

fn verify_signature(
    public_key: &str,
    payload: &str,
    encoded_signature: &str,
) -> Result<(), CommandError> {
    let key_bytes = decode_public_key(public_key)?;
    let key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|error| update_error(format!("Invalid component signing key: {error}")))?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded_signature)
        .map_err(|error| update_error(format!("Invalid component signature encoding: {error}")))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|error| update_error(format!("Invalid component signature: {error}")))?;
    key.verify(payload.as_bytes(), &signature)
        .map_err(|error| update_error(format!("Component signature verification failed: {error}")))
}

fn decode_public_key(value: &str) -> Result<[u8; 32], CommandError> {
    let trimmed = value.trim();
    let decoded = if trimmed.contains("BEGIN PUBLIC KEY") {
        let body = trimmed
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        base64::engine::general_purpose::STANDARD.decode(body)
    } else {
        base64::engine::general_purpose::STANDARD.decode(trimmed)
    }
    .map_err(|error| update_error(format!("Invalid component public key encoding: {error}")))?;

    let key = if decoded.len() == 32 {
        decoded.as_slice()
    } else if decoded.len() >= 32 {
        &decoded[decoded.len() - 32..]
    } else {
        return Err(update_error(
            "Component public key must contain 32 Ed25519 bytes",
        ));
    };
    key.try_into()
        .map_err(|_| update_error("Component public key must contain 32 Ed25519 bytes"))
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_managed_or_absent(component: &str) -> Result<bool, CommandError> {
    let link = symlink_path(component).map_err(|error| update_error(error.to_string()))?;
    let staged = data_bin_dir()
        .map_err(|error| update_error(error.to_string()))?
        .join(component);
    match fs::symlink_metadata(&link) {
        Err(_) => Ok(true),
        Ok(meta) if meta.file_type().is_symlink() => Ok(fs::read_link(&link)
            .map(|target| {
                let target = if target.is_absolute() {
                    target
                } else {
                    link.parent().unwrap_or_else(|| Path::new(".")).join(target)
                };
                target == staged
            })
            .unwrap_or(false)),
        Ok(_) => Ok(false),
    }
}

fn verify_managed_component_links() -> Result<(), CommandError> {
    for spec in COMPONENT_ORDER {
        if !is_managed_component_active(spec.binary_name)? {
            return Err(update_error(format!(
                "Managed symlink check failed for {}",
                spec.manifest_key
            )));
        }
    }
    Ok(())
}

fn is_managed_component_active(component: &str) -> Result<bool, CommandError> {
    let link = symlink_path(component).map_err(|error| update_error(error.to_string()))?;
    let staged = data_bin_dir()
        .map_err(|error| update_error(error.to_string()))?
        .join(component);
    let metadata = match fs::symlink_metadata(&link) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(update_error(error.to_string())),
    };
    if !metadata.file_type().is_symlink() || !staged.is_file() {
        return Ok(false);
    }
    let target = fs::read_link(&link).map_err(|error| update_error(error.to_string()))?;
    let target = if target.is_absolute() {
        target
    } else {
        link.parent().unwrap_or_else(|| Path::new(".")).join(target)
    };
    Ok(target == staged)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonLifecycleOutcome {
    message: String,
    restarted: bool,
}

fn reconcile_daemon_service<Relaunch, Status>(
    daemon_changed: bool,
    daemon_was_registered: bool,
    mut relaunch: Relaunch,
    mut status: Status,
) -> Result<DaemonLifecycleOutcome, CommandError>
where
    Relaunch: FnMut() -> Result<ServiceRelaunch, InstallerError>,
    Status: FnMut() -> Result<ServiceStatus, InstallerError>,
{
    if daemon_changed && daemon_was_registered {
        return match relaunch().map_err(|error| {
            update_error(format!(
                "Updated daemon service could not be relaunched: {error}"
            ))
        })? {
            ServiceRelaunch::Restarted { pid } => Ok(DaemonLifecycleOutcome {
                message: format!(
                    "Managed daemon changed; registered service relaunched and healthy (PID {pid})"
                ),
                restarted: true,
            }),
            ServiceRelaunch::NotRegistered => Err(update_error(
                "Daemon service registration disappeared before relaunch; no unregistered service was started",
            )),
        };
    }

    if daemon_changed {
        return Ok(DaemonLifecycleOutcome {
            message: "Managed daemon changed; service is not registered, so no service was started"
                .to_string(),
            restarted: false,
        });
    }

    let status = status().map_err(|error| update_error(error.to_string()))?;
    Ok(DaemonLifecycleOutcome {
        message: match status {
            ServiceStatus::Running { pid } => {
                format!("Running (PID {pid}); daemon artifact unchanged, so no restart was needed")
            }
            ServiceStatus::Loaded { last_exit_status } => format!(
                "Loaded but not running (last exit status: {last_exit_status}); daemon artifact unchanged, so no restart was needed"
            ),
            ServiceStatus::NotLoaded => {
                "Not loaded; daemon artifact unchanged and no service lifecycle change requested"
                    .to_string()
            }
        },
        restarted: false,
    })
}

fn managed_daemon_artifact_changed(candidate: &Path) -> Result<bool, CommandError> {
    let managed = data_bin_dir()
        .map_err(|error| update_error(error.to_string()))?
        .join("vtb-daemon");
    let candidate_bytes = fs::read(candidate).map_err(|error| {
        update_error(format!(
            "Could not read staged daemon artifact before activation: {error}"
        ))
    })?;
    let managed_bytes = match fs::read(&managed) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(update_error(format!(
                "Could not read managed daemon artifact before activation: {error}"
            )));
        }
    };
    Ok(artifact_bytes_changed(
        managed_bytes.as_deref(),
        &candidate_bytes,
    ))
}

fn artifact_bytes_changed(previous: Option<&[u8]>, candidate: &[u8]) -> bool {
    previous != Some(candidate)
}

fn rollback_failure(
    transaction: &BinaryTransaction,
    original: CommandError,
    restore_registered_daemon: bool,
) -> CommandError {
    if let Err(error) = transaction.rollback() {
        return update_error(format!(
            "{}; managed component rollback also failed: {error}",
            original.message
        ));
    }

    if restore_registered_daemon {
        if let Err(error) = restore_daemon_after_rollback(relaunch_service_if_registered) {
            return update_error(format!(
                "{}; previous binaries were restored, but the daemon service could not be restored: {}",
                original.message, error.message
            ));
        }
    }
    original
}

fn restore_daemon_after_rollback<Relaunch>(mut relaunch: Relaunch) -> Result<(), CommandError>
where
    Relaunch: FnMut() -> Result<ServiceRelaunch, InstallerError>,
{
    match relaunch().map_err(|error| update_error(error.to_string()))? {
        ServiceRelaunch::Restarted { .. } => Ok(()),
        ServiceRelaunch::NotRegistered => Err(update_error(
            "the previously registered daemon service is no longer registered",
        )),
    }
}

async fn load_component_manifest(channel: &str) -> Result<ReleaseManifest, CommandError> {
    let url = manifest_url(channel)?;
    let bytes = download_bytes(&url).await?;
    serde_json::from_slice(&bytes).map_err(|error| {
        update_error(format!(
            "Signed component manifest is invalid JSON: {error}"
        ))
    })
}

async fn load_gui_update(
    app_handle: &AppHandle,
    channel: &str,
    version: &str,
    expected_build: Option<&str>,
    manifest: &ReleaseManifest,
) -> Result<tauri_plugin_updater::Update, CommandError> {
    let endpoint = Url::parse(&gui_manifest_url(channel)?)
        .map_err(|error| update_error(format!("Invalid GUI updater endpoint: {error}")))?;
    let requested_version = version.to_string();
    let updater = app_handle
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| update_error(format!("Could not configure GUI updater: {error}")))?
        .version_comparator(move |_current, release| {
            release.version.to_string() == requested_version
        })
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| update_error(format!("Could not build GUI updater: {error}")))?;
    let update = updater
        .check()
        .await
        .map_err(|error| update_error(format!("Signed GUI update check failed: {error}")))?
        .ok_or_else(|| update_error("The selected signed GUI release is unavailable"))?;

    if update.version != version {
        return Err(update_error(
            "The signed GUI release does not match the reviewed version",
        ));
    }
    if let Some(build) = expected_build {
        let published_build = update
            .raw_json
            .get("build")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| update_error("The signed GUI release has no build identity"))?;
        if published_build != build {
            return Err(update_error(
                "The signed GUI release does not match the reviewed build",
            ));
        }
    }

    let gui_artifact = manifest
        .components
        .get(GUI_COMPONENT_KEY)
        .ok_or_else(|| update_error("Signed component manifest is missing the GUI artifact"))?;
    if gui_artifact.version != version
        || expected_build.is_some_and(|build| gui_artifact.build != build)
        || gui_artifact.target != TARGET_TRIPLE
        || gui_artifact.url != update.download_url.as_str()
    {
        return Err(update_error(
            "The signed GUI artifact identity does not match the signed GUI updater release",
        ));
    }
    Ok(update)
}

async fn download_gui_artifact(
    update: &tauri_plugin_updater::Update,
    manifest: &ReleaseManifest,
) -> Result<Vec<u8>, CommandError> {
    let bytes = update
        .download(&mut |_chunk, _total| {}, || {})
        .await
        .map_err(|error| update_error(format!("Signed GUI artifact download failed: {error}")))?;
    let artifact = manifest
        .components
        .get(GUI_COMPONENT_KEY)
        .ok_or_else(|| update_error("Signed component manifest is missing the GUI artifact"))?;
    verify_artifact(GUI_COMPONENT_KEY, artifact, &bytes)?;
    Ok(bytes)
}

fn emit_progress(app_handle: &AppHandle, result: &UpdateTransactionResult) {
    let _ = app_handle.emit("component-update-progress", result);
}

fn manifest_url(channel: &str) -> Result<String, CommandError> {
    if !matches!(channel, "master" | "release") {
        return Err(update_error("Unsupported update channel"));
    }
    Ok(format!(
        "{COMPONENT_MANIFEST_BASE}{channel}/latest-{TARGET_TRIPLE}.json"
    ))
}

fn gui_manifest_url(channel: &str) -> Result<String, CommandError> {
    if !matches!(channel, "master" | "release") {
        return Err(update_error("Unsupported update channel"));
    }
    Ok(format!("{GUI_MANIFEST_BASE}{channel}/gui-latest.json"))
}

async fn download_bytes(url: &str) -> Result<Vec<u8>, CommandError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| update_error(format!("Update client could not be created: {error}")))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| update_error(format!("Update download failed: {error}")))?;
    if !response.status().is_success() {
        return Err(update_error(format!(
            "Update download returned HTTP {}",
            response.status()
        )));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| update_error(format!("Update download body failed: {error}")))
}

fn make_staging_dir(version: &str, build: Option<&str>) -> Result<PathBuf, CommandError> {
    let root = data_dir().map_err(|error| update_error(error.to_string()))?;
    let suffix = build.unwrap_or("unknown").replace(['/', '\\'], "_");
    let path = root.join(format!(
        ".update-staging-{version}-{suffix}-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&path).map_err(|error| {
        update_error(format!(
            "Could not create update staging directory: {error}"
        ))
    })?;
    Ok(path)
}

fn remove_staging_dir(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

fn update_error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::cell::Cell;

    fn fixture_manifest(signing_key: &SigningKey) -> ReleaseManifest {
        let public_key = base64::engine::general_purpose::STANDARD
            .encode(signing_key.verifying_key().as_bytes());
        let mut components = HashMap::new();
        for spec in COMPONENT_ORDER
            .iter()
            .copied()
            .chain(std::iter::once(ComponentSpec {
                manifest_key: GUI_COMPONENT_KEY,
                binary_name: "gui",
            }))
        {
            let bytes = spec.manifest_key.as_bytes();
            let artifact = ArtifactManifest {
                version: "1.2.3".to_string(),
                build: "build-7".to_string(),
                target: TARGET_TRIPLE.to_string(),
                url: format!("https://example.test/{}", spec.manifest_key),
                sha256: hex_digest(bytes),
                size: bytes.len() as u64,
                signature: String::new(),
                public_key: public_key.clone(),
            };
            let mut artifact = artifact;
            artifact.signature = base64::engine::general_purpose::STANDARD.encode(
                signing_key
                    .sign(signature_payload(spec.manifest_key, &artifact).as_bytes())
                    .to_bytes(),
            );
            components.insert(spec.manifest_key.to_string(), artifact);
        }
        let mut manifest = ReleaseManifest {
            schema: 1,
            channel: "release".to_string(),
            generated_at: "2026-08-10T00:00:00Z".to_string(),
            components,
            signature: String::new(),
            public_key,
        };
        let mut payload = format!(
            "vertebrae-manifest-v1\nschema={}\nchannel={}\ngenerated_at={}\n",
            manifest.schema, manifest.channel, manifest.generated_at
        );
        for component in ["gui", "cli", "daemon", "gate"] {
            if let Some(artifact) = manifest.components.get(component) {
                payload.push_str(&signature_payload(component, artifact));
            }
        }
        manifest.signature = base64::engine::general_purpose::STANDARD
            .encode(signing_key.sign(payload.as_bytes()).to_bytes());
        manifest
    }

    #[test]
    fn signed_fixture_validates_without_release_notes() {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let manifest = fixture_manifest(&signing_key);
        assert!(validate_preflight("release", "1.2.3", Some("build-7"), &manifest).is_ok());
        for (component, bytes) in [
            ("cli", b"cli".as_slice()),
            ("daemon", b"daemon".as_slice()),
            ("gate", b"gate".as_slice()),
            ("gui", b"gui".as_slice()),
        ] {
            verify_artifact(component, &manifest.components[component], bytes).unwrap();
        }
    }

    #[test]
    fn wrong_target_and_hash_stop_before_activation() {
        let signing_key = SigningKey::from_bytes(&[8; 32]);
        let mut manifest = fixture_manifest(&signing_key);
        manifest.components.get_mut("daemon").unwrap().target = "wrong-target".to_string();
        assert!(validate_preflight("release", "1.2.3", Some("build-7"), &manifest).is_err());

        let mut manifest = fixture_manifest(&signing_key);
        manifest.components.get_mut("cli").unwrap().sha256 = "0".repeat(64);
        assert!(verify_artifact("cli", &manifest.components["cli"], b"cli").is_err());
    }

    #[test]
    fn declined_approval_is_gated_before_network_or_filesystem_work() {
        let error = require_explicit_approval(false).expect_err("declined update must be gated");
        assert_eq!(
            error.message,
            "Explicit GUI approval is required before applying an update."
        );
    }

    #[test]
    fn invalid_manifest_signature_stops_preflight() {
        let signing_key = SigningKey::from_bytes(&[9; 32]);
        let mut manifest = fixture_manifest(&signing_key);
        manifest.signature = base64::engine::general_purpose::STANDARD.encode([0; 64]);

        assert!(validate_preflight("release", "1.2.3", Some("build-7"), &manifest).is_err());
    }

    #[test]
    fn component_order_maps_manifest_keys_to_managed_binary_names() {
        assert_eq!(
            COMPONENT_ORDER
                .iter()
                .map(|spec| (spec.manifest_key, spec.binary_name))
                .collect::<Vec<_>>(),
            vec![
                ("cli", "vtb"),
                ("daemon", "vtb-daemon"),
                ("gate", "vtb-gate")
            ]
        );
    }

    #[test]
    fn daemon_change_detection_compares_actual_artifact_bytes() {
        assert!(!artifact_bytes_changed(Some(b"same"), b"same"));
        assert!(artifact_bytes_changed(Some(b"old"), b"new"));
        assert!(artifact_bytes_changed(None, b"first-managed-install"));
    }

    #[test]
    fn unchanged_daemon_reports_status_without_relaunching_service() {
        let relaunch_calls = Cell::new(0);
        let status_calls = Cell::new(0);

        let outcome = reconcile_daemon_service(
            false,
            true,
            || {
                relaunch_calls.set(relaunch_calls.get() + 1);
                Ok(ServiceRelaunch::Restarted { pid: 99 })
            },
            || {
                status_calls.set(status_calls.get() + 1);
                Ok(ServiceStatus::Running { pid: 42 })
            },
        )
        .unwrap();

        assert_eq!(relaunch_calls.get(), 0);
        assert_eq!(status_calls.get(), 1);
        assert_eq!(
            outcome,
            DaemonLifecycleOutcome {
                message: "Running (PID 42); daemon artifact unchanged, so no restart was needed"
                    .to_string(),
                restarted: false,
            }
        );
    }

    #[test]
    fn changed_daemon_does_not_start_or_install_unregistered_service() {
        let relaunch_calls = Cell::new(0);
        let status_calls = Cell::new(0);

        let outcome = reconcile_daemon_service(
            true,
            false,
            || {
                relaunch_calls.set(relaunch_calls.get() + 1);
                Ok(ServiceRelaunch::Restarted { pid: 99 })
            },
            || {
                status_calls.set(status_calls.get() + 1);
                Ok(ServiceStatus::Running { pid: 42 })
            },
        )
        .unwrap();

        assert_eq!(relaunch_calls.get(), 0);
        assert_eq!(status_calls.get(), 0);
        assert_eq!(
            outcome.message,
            "Managed daemon changed; service is not registered, so no service was started"
        );
        assert!(!outcome.restarted);
    }

    #[test]
    fn changed_daemon_relaunches_registered_service_and_reports_healthy_pid() {
        let relaunch_calls = Cell::new(0);

        let outcome = reconcile_daemon_service(
            true,
            true,
            || {
                relaunch_calls.set(relaunch_calls.get() + 1);
                Ok(ServiceRelaunch::Restarted { pid: 73 })
            },
            || Ok(ServiceStatus::NotLoaded),
        )
        .unwrap();

        assert_eq!(relaunch_calls.get(), 1);
        assert_eq!(
            outcome,
            DaemonLifecycleOutcome {
                message:
                    "Managed daemon changed; registered service relaunched and healthy (PID 73)"
                        .to_string(),
                restarted: true,
            }
        );
    }

    #[test]
    fn registered_service_disappearing_during_update_is_a_transaction_failure() {
        let error = reconcile_daemon_service(
            true,
            true,
            || Ok(ServiceRelaunch::NotRegistered),
            || Ok(ServiceStatus::NotLoaded),
        )
        .unwrap_err();

        assert_eq!(
            error.message,
            "Daemon service registration disappeared before relaunch; no unregistered service was started"
        );
    }

    #[test]
    fn daemon_relaunch_failure_is_exposed_to_update_transaction() {
        let error = reconcile_daemon_service(
            true,
            true,
            || {
                Err(InstallerError::ServiceHealth {
                    reason: "still inactive".to_string(),
                })
            },
            || Ok(ServiceStatus::NotLoaded),
        )
        .unwrap_err();

        assert_eq!(
            error.message,
            "Updated daemon service could not be relaunched: Daemon service did not become healthy after relaunch: still inactive"
        );
    }

    #[test]
    fn rollback_relaunch_requires_previously_registered_service_to_return() {
        assert!(
            restore_daemon_after_rollback(|| Ok(ServiceRelaunch::Restarted { pid: 7 })).is_ok()
        );
        let error =
            restore_daemon_after_rollback(|| Ok(ServiceRelaunch::NotRegistered)).unwrap_err();
        assert_eq!(
            error.message,
            "the previously registered daemon service is no longer registered"
        );
    }
}
