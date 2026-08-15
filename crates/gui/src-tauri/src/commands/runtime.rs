use super::*;
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc};
use std::time::Duration;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const UPDATE_RESPONSE_PREVIEW_LIMIT: usize = 256;
const GUI_UPDATE_CHANNEL_ENDPOINTS: [(&str, &str); 2] = [
    (
        "master",
        "https://github.com/CamonZ/vertebrae/releases/download/channel-master/gui-latest.json",
    ),
    (
        "release",
        "https://github.com/CamonZ/vertebrae/releases/download/channel-release/gui-latest.json",
    ),
];

// ============================================================================
// Runtime Status and Lifecycle Commands
// ============================================================================

// ============================================================================
// WebSocket Status Command
// ============================================================================

/// Get the current WebSocket connection status
#[tauri::command]
#[specta::specta]
pub async fn get_websocket_status(
    socket: State<'_, tokio::sync::Mutex<crate::websocket_client::SacrumSocket>>,
) -> Result<String, CommandError> {
    let guard = socket.lock().await;
    let status = guard.get_state().await;
    let status_str = match status {
        crate::websocket_client::ConnectionState::Disconnected => "disconnected",
        crate::websocket_client::ConnectionState::Connecting => "connecting",
        crate::websocket_client::ConnectionState::Connected => "connected",
        crate::websocket_client::ConnectionState::Reconnecting => "reconnecting",
    };
    Ok(status_str.to_string())
}

/// Quit the application.
///
/// Used by the first-run install screen's Cancel button so a user who does not
/// want to install the bundled tools can exit cleanly rather than being routed
/// into an app that can't function without them.
#[tauri::command]
#[specta::specta]
pub async fn quit_application(app_handle: tauri::AppHandle) -> Result<(), CommandError> {
    app_handle.exit(0);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GuiUpdateChannelRelease {
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub raw_json: serde_json::Value,
    pub is_update: bool,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GuiUpdateChannelStatus {
    pub channel: String,
    pub endpoint: String,
    pub available: bool,
    pub release: Option<GuiUpdateChannelRelease>,
    pub error: Option<String>,
}

/// Check the signed GUI release metadata for every supported channel.
///
/// The updater plugin normally reads the single endpoint configured for the
/// current bundle. Channel selection needs independent availability, so each
/// endpoint is checked through a separate native updater builder. This keeps
/// signature and platform validation identical to the normal updater path.
#[tauri::command]
#[specta::specta]
pub async fn check_gui_update_channels(
    app_handle: tauri::AppHandle,
) -> Vec<GuiUpdateChannelStatus> {
    let mut statuses = Vec::with_capacity(GUI_UPDATE_CHANNEL_ENDPOINTS.len());

    for (channel, endpoint) in GUI_UPDATE_CHANNEL_ENDPOINTS {
        let status = check_gui_update_channel(&app_handle, channel, endpoint).await;
        statuses.push(status);
    }

    statuses
}

async fn check_gui_update_channel(
    app_handle: &tauri::AppHandle,
    channel: &str,
    endpoint: &str,
) -> GuiUpdateChannelStatus {
    if let Some(client) = diagnostic_client() {
        if let Err(error) = preflight_gui_update_channel(&client, channel, endpoint).await {
            return unavailable_channel_status(channel, endpoint, error);
        }
    }

    let is_update = Arc::new(AtomicBool::new(false));
    let comparator_state = Arc::clone(&is_update);
    let is_master = channel == "master";
    let result = async {
        let endpoint_url = Url::parse(endpoint)?;
        let updater = app_handle
            .updater_builder()
            .endpoints(vec![endpoint_url])?
            // Ask the updater to return valid metadata even when the channel
            // is current; the flag records whether it is actually newer.
            .version_comparator(move |current, release| {
                let is_newer = if is_master {
                    is_newer_master_version(&current, &release.version)
                } else {
                    release.version > current
                };
                comparator_state.store(is_newer, Ordering::Relaxed);
                true
            })
            .timeout(Duration::from_secs(10))
            .build()?;

        updater.check().await
    }
    .await;

    match result {
        Ok(Some(update)) => GuiUpdateChannelStatus {
            channel: channel.to_string(),
            endpoint: endpoint.to_string(),
            available: true,
            release: Some(GuiUpdateChannelRelease {
                current_version: update.current_version,
                version: update.version,
                date: update.date.map(|date| date.to_string()),
                body: update.body,
                raw_json: update.raw_json,
                is_update: is_update.load(Ordering::Relaxed),
            }),
            error: None,
        },
        Ok(None) => unavailable_channel_status(
            channel,
            endpoint,
            "The signed channel returned no release metadata.",
        ),
        Err(error) => {
            log::warn!(
                "[GUI updater] channel check failed; channel={} endpoint={} error={}",
                channel,
                endpoint,
                error
            );
            if let Some(client) = diagnostic_client() {
                log_endpoint_diagnostic(
                    &client,
                    endpoint,
                    &format!("channel endpoint diagnostic; channel={channel}"),
                )
                .await;
            }
            unavailable_channel_status(channel, endpoint, error.to_string())
        }
    }
}

fn is_newer_master_version(current: &semver::Version, release: &semver::Version) -> bool {
    match (master_version_key(current), master_version_key(release)) {
        (Some(current), Some(release)) => release > current,
        _ => release > current,
    }
}

fn master_version_key(version: &semver::Version) -> Option<(u64, u64, u64, u64)> {
    if version.pre.is_empty() {
        return Some((version.major, version.minor, 0, version.patch));
    }

    let mut identifiers = version.pre.as_str().split('.');
    if identifiers.next()? != "build" {
        return None;
    }
    let build = identifiers.next()?.parse().ok()?;
    if identifiers.next().is_some() {
        return None;
    }
    Some((version.major, version.minor, version.patch, build))
}

async fn preflight_gui_update_channel(
    client: &reqwest::Client,
    channel: &str,
    endpoint: &str,
) -> Result<(), String> {
    let response = client
        .get(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| {
            log::warn!(
                "[GUI updater] channel unavailable; channel={} endpoint={} error={}",
                channel,
                endpoint,
                error
            );
            error.to_string()
        })?;
    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_owned();
    let response_body = match response.text().await {
        Ok(body) => compact_log_value(&body),
        Err(error) => format!("<failed to read response body: {error}>"),
    };

    log::warn!(
        "[GUI updater] channel unavailable; channel={} endpoint={} status={} content_type={} response_preview={:?}",
        channel,
        endpoint,
        status,
        content_type,
        response_body
    );
    Err(format!("Update endpoint returned HTTP status {status}"))
}

fn unavailable_channel_status(
    channel: &str,
    endpoint: &str,
    error: impl Into<String>,
) -> GuiUpdateChannelStatus {
    GuiUpdateChannelStatus {
        channel: channel.to_string(),
        endpoint: endpoint.to_string(),
        available: false,
        release: None,
        error: Some(error.into()),
    }
}

/// Record useful native diagnostics after the updater plugin reports a failed
/// check. The plugin currently logs only that the endpoint returned a
/// non-success status, so this follow-up request captures the configured URL,
/// HTTP status, content type, and a bounded response preview in the app log.
///
/// This command is diagnostic-only: it never downloads, installs, or relaunches
/// the application. It is called only after the signed updater check fails.
#[tauri::command]
#[specta::specta]
pub async fn diagnose_gui_update_check(
    app_handle: tauri::AppHandle,
    reason: String,
) -> Result<(), CommandError> {
    log::error!(
        "[GUI updater] update check failed; error={:?}",
        compact_log_value(&reason)
    );

    let endpoints = configured_updater_endpoints(&app_handle);
    if endpoints.is_empty() {
        log::error!(
            "[GUI updater] endpoint diagnostic skipped; no updater endpoints are configured"
        );
        return Ok(());
    }

    let Some(client) = diagnostic_client() else {
        return Ok(());
    };
    for endpoint in endpoints {
        log_endpoint_diagnostic(&client, &endpoint, "endpoint diagnostic").await;
    }

    Ok(())
}

fn diagnostic_client() -> Option<reqwest::Client> {
    match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => Some(client),
        Err(error) => {
            log::error!(
                "[GUI updater] endpoint diagnostic client could not be created; error={}",
                error
            );
            None
        }
    }
}

async fn log_endpoint_diagnostic(client: &reqwest::Client, endpoint: &str, context: &str) {
    match client
        .get(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("unknown")
                .to_owned();
            let response_body = match response.text().await {
                Ok(body) => compact_log_value(&body),
                Err(error) => format!("<failed to read response body: {error}>"),
            };

            log::error!(
                "[GUI updater] {context}; endpoint={} status={} content_type={} response_preview={:?}",
                endpoint,
                status,
                content_type,
                response_body
            );
        }
        Err(error) => {
            log::error!(
                "[GUI updater] {context} failed; endpoint={} error={}",
                endpoint,
                error
            );
        }
    }
}

fn configured_updater_endpoints(app_handle: &tauri::AppHandle) -> Vec<String> {
    app_handle
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn compact_log_value(value: &str) -> String {
    let compacted = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = compacted.chars();
    let preview: String = chars.by_ref().take(UPDATE_RESPONSE_PREVIEW_LIMIT).collect();
    if chars.next().is_some() {
        format!("{preview}…")
    } else if preview.is_empty() {
        "<empty>".to_string()
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_log_value_normalizes_and_bounds_response_text() {
        assert_eq!(
            compact_log_value("  {\n  \"message\": \"Not Found\" }  "),
            "{ \"message\": \"Not Found\" }"
        );
        assert_eq!(compact_log_value(""), "<empty>");

        let long_value = "x".repeat(UPDATE_RESPONSE_PREVIEW_LIMIT + 1);
        let preview = compact_log_value(&long_value);
        assert_eq!(preview.chars().count(), UPDATE_RESPONSE_PREVIEW_LIMIT + 1);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn master_build_versions_are_compared_by_base_version_and_build_number() {
        let legacy = semver::Version::parse("0.1.18").unwrap();
        let first_build = semver::Version::parse("0.1.0-build.19").unwrap();
        let next_build = semver::Version::parse("0.1.0-build.20").unwrap();
        let next_base = semver::Version::parse("0.1.1-build.1").unwrap();

        assert!(is_newer_master_version(&legacy, &first_build));
        assert!(is_newer_master_version(&first_build, &next_build));
        assert!(is_newer_master_version(&next_build, &next_base));
    }
}
