//! `vtb daemon uninstall` — unregister the launchd or systemd user service via
//! the shared [`vertebrae_installer`] crate.

use clap::Args;
use vertebrae_installer as installer;

use super::DaemonError;

/// Uninstall the vtb-daemon launchd / systemd service.
#[derive(Debug, Args)]
pub struct DaemonUninstallCommand {}

impl DaemonUninstallCommand {
    pub async fn execute(&self) -> Result<String, DaemonError> {
        // Capture the service file path before uninstall so we can report
        // it the same way the old CLI did ("Removed: <plist>").
        let service_file = current_service_file()?;
        let was_installed = service_file.as_ref().is_some_and(|p| p.exists());

        if !was_installed {
            return Ok(not_installed_message().to_string());
        }

        installer::uninstall_service()?;

        let removed = service_file
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        Ok(format!(
            "vtb-daemon uninstalled.\n\
             \n\
             Removed: {removed}\n\
             \n\
             The daemon will no longer start on login."
        ))
    }
}

#[cfg(target_os = "macos")]
fn current_service_file() -> Result<Option<std::path::PathBuf>, DaemonError> {
    Ok(Some(installer::macos::plist_path()?))
}

#[cfg(target_os = "linux")]
fn current_service_file() -> Result<Option<std::path::PathBuf>, DaemonError> {
    Ok(Some(installer::linux::unit_path()?))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn current_service_file() -> Result<Option<std::path::PathBuf>, DaemonError> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn not_installed_message() -> &'static str {
    "vtb-daemon is not installed (no plist found)."
}

#[cfg(target_os = "linux")]
fn not_installed_message() -> &'static str {
    "vtb-daemon is not installed (no systemd unit found)."
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn not_installed_message() -> &'static str {
    "vtb-daemon is not installed."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninstall_command_debug() {
        let cmd = DaemonUninstallCommand {};
        let dbg = format!("{:?}", cmd);
        assert!(
            dbg.contains("DaemonUninstallCommand"),
            "Debug should contain struct name, got: {dbg}"
        );
    }
}
