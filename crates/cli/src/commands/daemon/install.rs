//! `vtb daemon install` — install the daemon service via the shared
//! [`vertebrae_installer`] crate.

use std::path::PathBuf;
use std::process::Command;

use clap::Args;
use vertebrae_installer as installer;

use super::DaemonError;

/// Install vtb-daemon as a launchd (macOS) or systemd `--user` (Linux)
/// service.
#[derive(Debug, Args)]
pub struct DaemonInstallCommand {
    /// Explicit path to the vtb-daemon binary (auto-detected from PATH if omitted)
    #[arg(long)]
    pub binary: Option<String>,
}

impl DaemonInstallCommand {
    pub async fn execute(&self) -> Result<String, DaemonError> {
        let binary_path = self.resolve_binary()?;
        let report = installer::install_service(&binary_path)?;

        Ok(format!(
            "vtb-daemon installed and loaded.\n\
             \n\
             {}:   {}\n\
             Binary:  {}\n\
             Logs:    {}\n\
             Errors:  {}\n\
             \n\
             The daemon will start automatically on login.",
            service_file_label(),
            report.service_file.display(),
            report.binary_path.display(),
            report.stdout_log.display(),
            report.stderr_log.display(),
        ))
    }

    /// Resolve the vtb-daemon binary path.
    ///
    /// If `--binary` was provided, validate it exists and canonicalise it.
    /// Otherwise look it up via `which vtb-daemon`.
    fn resolve_binary(&self) -> Result<PathBuf, DaemonError> {
        if let Some(ref explicit) = self.binary {
            let path = std::path::Path::new(explicit);
            if !path.exists() {
                return Err(DaemonError::BinaryNotFound(format!(
                    "Specified path does not exist: {explicit}"
                )));
            }
            let canonical = path
                .canonicalize()
                .map_err(|e| DaemonError::BinaryResolution(e.to_string()))?;
            return Ok(canonical);
        }

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

        let canonical = std::path::Path::new(&path)
            .canonicalize()
            .map_err(|e| DaemonError::BinaryResolution(e.to_string()))?;
        Ok(canonical)
    }
}

#[cfg(target_os = "linux")]
fn service_file_label() -> &'static str {
    "Unit"
}

#[cfg(not(target_os = "linux"))]
fn service_file_label() -> &'static str {
    "Plist"
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
