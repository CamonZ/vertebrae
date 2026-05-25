//! OS service management: register/unregister the daemon with launchd
//! (macOS) or systemd `--user` (Linux), and query its status.
//!
//! The free functions in this module dispatch to a per-OS implementation in
//! [`crate::macos`] or [`crate::linux`].

use std::path::{Path, PathBuf};

use crate::error::InstallerError;

/// macOS launchd label. Kept stable so re-installs over the previous
/// CLI-only install are idempotent.
pub const LAUNCHD_LABEL: &str = "com.vertebrae.daemon";

/// Linux systemd `--user` unit name (without the `.service` suffix).
pub const SYSTEMD_UNIT_NAME: &str = "vertebrae-daemon";

/// Report returned from a successful [`install_service`] call. Lets the
/// caller (CLI, GUI) render install-completion UI without having to know
/// which OS it ran on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceInstallReport {
    /// Stable identifier for the service (launchd label or systemd unit
    /// name).
    pub label: String,
    /// Absolute path of the service definition file we wrote
    /// (`.plist` on macOS, `.service` on Linux).
    pub service_file: PathBuf,
    /// Absolute path of the binary the service was wired up to launch.
    pub binary_path: PathBuf,
    /// Log file the service writes stdout to.
    pub stdout_log: PathBuf,
    /// Log file the service writes stderr to.
    pub stderr_log: PathBuf,
}

/// Current state of the daemon service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceStatus {
    /// Service is loaded with the OS service manager and currently running.
    Running { pid: u32 },
    /// Service is registered with the service manager but is not running
    /// right now (e.g. it exited cleanly or crashed). `last_exit_status`
    /// is best-effort — `0` if unknown.
    Loaded { last_exit_status: i32 },
    /// Service is not registered with the service manager.
    NotLoaded,
}

impl std::fmt::Display for ServiceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceStatus::Running { pid } => write!(f, "running (PID {pid})"),
            ServiceStatus::Loaded { last_exit_status } => write!(
                f,
                "loaded but not running (last exit status: {last_exit_status})"
            ),
            ServiceStatus::NotLoaded => write!(f, "not loaded"),
        }
    }
}

/// Register the daemon binary at `binary_path` with the OS service manager.
///
/// On macOS this writes
/// `~/Library/LaunchAgents/com.vertebrae.daemon.plist` and runs
/// `launchctl load`. If a previous plist exists it is unloaded first so the
/// install is idempotent over a prior install (including a prior CLI-only
/// install).
///
/// On Linux this writes
/// `~/.config/systemd/user/vertebrae-daemon.service`, then runs
/// `systemctl --user daemon-reload && systemctl --user enable --now
/// vertebrae-daemon`.
///
/// On other OSes this returns [`InstallerError::UnsupportedPlatform`].
pub fn install_service(binary_path: &Path) -> Result<ServiceInstallReport, InstallerError> {
    #[cfg(target_os = "macos")]
    {
        crate::macos::install_service(binary_path)
    }
    #[cfg(target_os = "linux")]
    {
        crate::linux::install_service(binary_path)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = binary_path;
        Err(InstallerError::UnsupportedPlatform)
    }
}

/// Unregister the daemon service from the OS service manager and remove the
/// service definition file. Idempotent — missing file is not an error.
pub fn uninstall_service() -> Result<(), InstallerError> {
    #[cfg(target_os = "macos")]
    {
        crate::macos::uninstall_service()
    }
    #[cfg(target_os = "linux")]
    {
        crate::linux::uninstall_service()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(InstallerError::UnsupportedPlatform)
    }
}

/// Query the current state of the daemon service.
pub fn service_status() -> Result<ServiceStatus, InstallerError> {
    #[cfg(target_os = "macos")]
    {
        crate::macos::service_status()
    }
    #[cfg(target_os = "linux")]
    {
        crate::linux::service_status()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(InstallerError::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_status_display_running() {
        assert_eq!(
            ServiceStatus::Running { pid: 42 }.to_string(),
            "running (PID 42)"
        );
    }

    #[test]
    fn service_status_display_loaded() {
        assert_eq!(
            ServiceStatus::Loaded {
                last_exit_status: 1
            }
            .to_string(),
            "loaded but not running (last exit status: 1)"
        );
    }

    #[test]
    fn service_status_display_not_loaded() {
        assert_eq!(ServiceStatus::NotLoaded.to_string(), "not loaded");
    }

    #[test]
    fn launchd_label_kept_stable_for_idempotent_reinstall() {
        // This is load-bearing: if we ever change it, re-installs over a
        // previous CLI-only install will leave the old service registered.
        assert_eq!(LAUNCHD_LABEL, "com.vertebrae.daemon");
    }

    #[test]
    fn systemd_unit_name_is_stable() {
        assert_eq!(SYSTEMD_UNIT_NAME, "vertebrae-daemon");
    }
}
