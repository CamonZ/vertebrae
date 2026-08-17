//! Rich error type for the installer crate.
//!
//! Errors carry the path or action that failed plus a human-readable reason
//! so callers (CLI, GUI) can render meaningful diagnostics without having to
//! re-derive context.

use std::path::PathBuf;

use thiserror::Error;

/// Errors that can be returned by the installer API.
#[derive(Debug, Error)]
pub enum InstallerError {
    /// The current user's home directory could not be determined.
    #[error("Could not determine home directory")]
    HomeDir,

    /// A required source binary was missing.
    #[error("Source binary not found at {path}")]
    SourceNotFound { path: PathBuf },

    /// Failed to create a directory.
    #[error("Failed to create directory {path}: {reason}")]
    CreateDir { path: PathBuf, reason: String },

    /// Failed to copy a binary into its staged location.
    #[error("Failed to copy {from} to {to}: {reason}")]
    CopyBinary {
        from: PathBuf,
        to: PathBuf,
        reason: String,
    },

    /// Failed to set executable permissions on a staged binary.
    #[error("Failed to set executable permissions on {path}: {reason}")]
    Chmod { path: PathBuf, reason: String },

    /// Failed to create or replace a symlink in `~/.local/bin`.
    #[error("Failed to symlink {link} -> {target}: {reason}")]
    Symlink {
        link: PathBuf,
        target: PathBuf,
        reason: String,
    },

    /// The GUI-managed path contains an installation owned by another tool.
    #[error("Refusing to replace unmanaged installation at {path}")]
    UnmanagedInstall { path: PathBuf },

    /// Failed to remove a file (binary, symlink, plist, unit file).
    #[error("Failed to remove {path}: {reason}")]
    Remove { path: PathBuf, reason: String },

    /// Failed to write a service definition file (plist or systemd unit).
    #[error("Failed to write service file {path}: {reason}")]
    WriteServiceFile { path: PathBuf, reason: String },

    /// `launchctl` invocation failed.
    #[error("launchctl {action} failed: {reason}")]
    Launchctl { action: String, reason: String },

    /// `systemctl --user` invocation failed.
    #[error("systemctl --user {action} failed: {reason}")]
    Systemctl { action: String, reason: String },

    /// A registered daemon did not reach the running state after relaunch.
    #[error("Daemon service did not become healthy after relaunch: {reason}")]
    ServiceHealth { reason: String },

    /// The operation is not supported on this OS (e.g. Windows).
    #[error("Installer is not supported on this platform")]
    UnsupportedPlatform,
}

impl InstallerError {
    /// Whether a service-manager status query failed because the manager is
    /// unavailable in the current environment (for example, a GUI test
    /// container without a systemd user bus).
    pub(crate) fn is_service_manager_unavailable(&self) -> bool {
        let reason = match self {
            Self::Launchctl { reason, .. } | Self::Systemctl { reason, .. } => reason,
            _ => return false,
        };

        let reason = reason.to_ascii_lowercase();
        [
            "failed to connect to bus",
            "failed to connect to user scope bus",
            "system has not been booted with systemd",
            "systemd is not running",
            "dbus_session_bus_address",
            "xdg_runtime_dir",
            "no such file or directory",
        ]
        .iter()
        .any(|marker| reason.contains(marker))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_unavailable_systemd_user_bus() {
        let error = InstallerError::Systemctl {
            action: "show".to_string(),
            reason: "Failed to connect to bus: No medium found".to_string(),
        };

        assert!(error.is_service_manager_unavailable());
    }

    #[test]
    fn recognizes_missing_user_bus_environment() {
        let error = InstallerError::Systemctl {
            action: "show".to_string(),
            reason: "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined".to_string(),
        };

        assert!(error.is_service_manager_unavailable());
    }

    #[test]
    fn does_not_downgrade_unrelated_service_manager_errors() {
        let error = InstallerError::Systemctl {
            action: "show".to_string(),
            reason: "Access denied".to_string(),
        };

        assert!(!error.is_service_manager_unavailable());
    }
}
