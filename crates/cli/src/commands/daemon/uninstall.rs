//! `vtb daemon uninstall` — unload the launchd service and remove the plist.

use clap::Args;
use std::fs;
use std::process::Command;

use super::{DaemonError, plist_path};

/// Uninstall the vtb-daemon launchd service.
#[derive(Debug, Args)]
pub struct DaemonUninstallCommand {}

impl DaemonUninstallCommand {
    pub async fn execute(&self) -> Result<String, DaemonError> {
        #[cfg(not(target_os = "macos"))]
        {
            return Err(DaemonError::UnsupportedPlatform);
        }

        #[cfg(target_os = "macos")]
        {
            self.execute_macos().await
        }
    }

    #[cfg(target_os = "macos")]
    async fn execute_macos(&self) -> Result<String, DaemonError> {
        let plist = plist_path()?;

        if !plist.exists() {
            return Ok("vtb-daemon is not installed (no plist found).".to_string());
        }

        // Unload the service (stops it if running)
        let output = Command::new("launchctl")
            .args(["unload", &plist.display().to_string()])
            .output()
            .map_err(|e| DaemonError::Launchctl {
                action: "unload".to_string(),
                reason: e.to_string(),
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // If the service wasn't loaded, that's fine — we still remove the plist
            if !stderr.contains("Could not find specified service") {
                return Err(DaemonError::Launchctl {
                    action: "unload".to_string(),
                    reason: stderr.trim().to_string(),
                });
            }
        }

        // Remove the plist file
        fs::remove_file(&plist).map_err(|e| DaemonError::RemovePlist {
            path: plist.display().to_string(),
            reason: e.to_string(),
        })?;

        Ok(format!(
            "vtb-daemon uninstalled.\n\
             \n\
             Removed: {}\n\
             \n\
             The daemon will no longer start on login.",
            plist.display()
        ))
    }
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
