//! Daemon management commands for the vtb-daemon service lifecycle.
//!
//! Implements `vtb daemon install`, `vtb daemon uninstall`, and `vtb daemon
//! status` as thin wrappers over the [`vertebrae_installer`] crate so the
//! same logic can be reused from the Tauri GUI installer.

mod install;
mod status;
mod uninstall;

pub use install::DaemonInstallCommand;
pub use status::DaemonStatusCommand;
pub use uninstall::DaemonUninstallCommand;

use clap::Subcommand;
use thiserror::Error;
use vertebrae_installer::InstallerError;

/// The launchd service label used for the vtb-daemon plist.
///
/// Re-exported from the installer crate so existing CLI tests/callers
/// continue to compile.
pub const LAUNCHD_LABEL: &str = vertebrae_installer::LAUNCHD_LABEL;

/// The systemd `--user` unit name used for the vtb-daemon service.
pub const SYSTEMD_UNIT_NAME: &str = vertebrae_installer::SYSTEMD_UNIT_NAME;

/// Daemon management commands
#[derive(Debug, Subcommand)]
pub enum DaemonCommand {
    /// Install vtb-daemon as a launchd or systemd user service
    Install(DaemonInstallCommand),
    /// Uninstall the vtb-daemon launchd or systemd user service
    Uninstall(DaemonUninstallCommand),
    /// Check the status of the vtb-daemon launchd or systemd user service
    Status(DaemonStatusCommand),
}

impl DaemonCommand {
    /// Execute the daemon subcommand.
    pub async fn execute(&self) -> Result<String, DaemonError> {
        match self {
            DaemonCommand::Install(cmd) => cmd.execute().await,
            DaemonCommand::Uninstall(cmd) => cmd.execute().await,
            DaemonCommand::Status(cmd) => cmd.execute().await,
        }
    }
}

/// Error type for daemon management command failures.
///
/// Wraps [`InstallerError`] from the shared crate plus a couple of
/// CLI-specific failure modes (binary resolution via `which`).
#[derive(Debug, Error)]
pub enum DaemonError {
    /// The vtb-daemon binary was not found in PATH.
    #[error("vtb-daemon binary not found in PATH. {0}")]
    BinaryNotFound(String),
    /// Failed to resolve the vtb-daemon binary path.
    #[error("Failed to resolve vtb-daemon binary path: {0}")]
    BinaryResolution(String),
    /// An error bubbled up from the installer crate.
    #[error(transparent)]
    Installer(#[from] InstallerError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launchd_label_is_reverse_dns() {
        assert_eq!(LAUNCHD_LABEL, "com.vertebrae.daemon");
        assert!(
            LAUNCHD_LABEL.starts_with("com."),
            "Label should use reverse DNS notation"
        );
    }

    #[test]
    fn daemon_error_display_binary_not_found() {
        let err = DaemonError::BinaryNotFound("Install it with cargo install".to_string());
        let msg = err.to_string();
        assert!(
            msg.contains("vtb-daemon binary not found"),
            "Expected binary not found message, got: {msg}"
        );
        assert!(
            msg.contains("Install it with cargo install"),
            "Expected hint in message, got: {msg}"
        );
    }

    #[test]
    fn daemon_error_display_binary_resolution() {
        let err = DaemonError::BinaryResolution("io error".to_string());
        let msg = err.to_string();
        assert!(
            msg.contains("resolve vtb-daemon binary path") && msg.contains("io error"),
            "Expected resolution error, got: {msg}"
        );
    }

    #[test]
    fn daemon_error_wraps_installer_error() {
        let inner = InstallerError::HomeDir;
        let err: DaemonError = inner.into();
        let msg = err.to_string();
        assert!(
            msg.contains("home directory"),
            "DaemonError should pass through installer error text, got: {msg}"
        );
    }

    #[test]
    fn daemon_command_debug() {
        let cmd = DaemonCommand::Status(DaemonStatusCommand {});
        let dbg = format!("{:?}", cmd);
        assert!(
            dbg.contains("Status"),
            "Debug should contain variant name, got: {dbg}"
        );
    }
}
