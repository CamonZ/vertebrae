//! `vtb daemon install` — write the launchd plist and load the service.

use clap::Args;
use std::fs;
use std::process::Command;

use super::{DaemonError, generate_plist, log_dir, plist_path};

/// Install vtb-daemon as a launchd service.
#[derive(Debug, Args)]
pub struct DaemonInstallCommand {
    /// Explicit path to the vtb-daemon binary (auto-detected from PATH if omitted)
    #[arg(long)]
    pub binary: Option<String>,
}

impl DaemonInstallCommand {
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
        let binary_path = self.resolve_binary()?;
        let plist = plist_path()?;
        let logs = log_dir()?;

        // Ensure ~/Library/LaunchAgents exists
        if let Some(parent) = plist.parent() {
            fs::create_dir_all(parent).map_err(|e| DaemonError::CreateDir {
                path: parent.display().to_string(),
                reason: e.to_string(),
            })?;
        }

        // Ensure log directory exists
        fs::create_dir_all(&logs).map_err(|e| DaemonError::CreateDir {
            path: logs.display().to_string(),
            reason: e.to_string(),
        })?;

        // If the service is already loaded, unload it first so we can update the plist
        if plist.exists() {
            let _ = Command::new("launchctl")
                .args(["unload", &plist.display().to_string()])
                .output();
        }

        // Write the plist file
        let content = generate_plist(&binary_path);
        fs::write(&plist, &content).map_err(|e| DaemonError::WritePlist {
            path: plist.display().to_string(),
            reason: e.to_string(),
        })?;

        // Load the service
        let output = Command::new("launchctl")
            .args(["load", &plist.display().to_string()])
            .output()
            .map_err(|e| DaemonError::Launchctl {
                action: "load".to_string(),
                reason: e.to_string(),
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(DaemonError::Launchctl {
                action: "load".to_string(),
                reason: stderr.trim().to_string(),
            });
        }

        Ok(format!(
            "vtb-daemon installed and loaded.\n\
             \n\
             Plist:   {}\n\
             Binary:  {}\n\
             Logs:    {}/daemon.log\n\
             Errors:  {}/daemon.error.log\n\
             \n\
             The daemon will start automatically on login.",
            plist.display(),
            binary_path,
            logs.display(),
            logs.display(),
        ))
    }

    /// Resolve the vtb-daemon binary path.
    ///
    /// If `--binary` was provided, validate it exists. Otherwise look it up
    /// via `which vtb-daemon`.
    #[cfg(target_os = "macos")]
    fn resolve_binary(&self) -> Result<String, DaemonError> {
        if let Some(ref explicit) = self.binary {
            let path = std::path::Path::new(explicit);
            if !path.exists() {
                return Err(DaemonError::BinaryNotFound(format!(
                    "Specified path does not exist: {explicit}"
                )));
            }
            // Canonicalize to get the absolute path
            let canonical = path
                .canonicalize()
                .map_err(|e| DaemonError::BinaryResolution(e.to_string()))?;
            return Ok(canonical.display().to_string());
        }

        // Auto-detect via `which`
        let output = Command::new("which")
            .arg("vtb-daemon")
            .output()
            .map_err(|e| DaemonError::BinaryResolution(e.to_string()))?;

        if !output.status.success() {
            return Err(DaemonError::BinaryNotFound(
                "Ensure vtb-daemon is installed and in your PATH, \
                 or use --binary to specify the path explicitly."
                    .to_string(),
            ));
        }

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return Err(DaemonError::BinaryNotFound(
                "which returned empty result. Use --binary to specify the path explicitly."
                    .to_string(),
            ));
        }

        // Canonicalize to resolve any symlinks
        let canonical = std::path::Path::new(&path)
            .canonicalize()
            .map_err(|e| DaemonError::BinaryResolution(e.to_string()))?;

        Ok(canonical.display().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_command_debug() {
        let cmd = DaemonInstallCommand { binary: None };
        let dbg = format!("{:?}", cmd);
        assert!(
            dbg.contains("DaemonInstallCommand"),
            "Debug should contain struct name, got: {dbg}"
        );
    }

    #[test]
    fn install_command_with_explicit_binary() {
        let cmd = DaemonInstallCommand {
            binary: Some("/usr/local/bin/vtb-daemon".to_string()),
        };
        assert_eq!(
            cmd.binary.as_deref(),
            Some("/usr/local/bin/vtb-daemon"),
            "binary field should store the provided path"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_binary_rejects_nonexistent_explicit_path() {
        let cmd = DaemonInstallCommand {
            binary: Some("/nonexistent/path/vtb-daemon".to_string()),
        };
        let result = cmd.resolve_binary();
        assert!(result.is_err(), "Should reject nonexistent explicit path");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("not found") || err_msg.contains("does not exist"),
            "Error should mention the path problem, got: {err_msg}"
        );
    }
}
