//! OS service management: register/unregister the daemon with launchd
//! (macOS) or systemd `--user` (Linux), and query its status.
//!
//! The free functions in this module dispatch to a per-OS implementation in
//! [`crate::macos`] or [`crate::linux`].

use std::path::{Path, PathBuf};
use std::time::Duration;

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

/// Outcome of asking the OS service manager to relaunch the daemon without
/// registering it as a new service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceRelaunch {
    /// The daemon was not registered, so no start or install command ran.
    NotRegistered,
    /// The registered service was relaunched and reached the running state.
    Restarted { pid: u32 },
}

pub(crate) const SERVICE_HEALTH_ATTEMPTS: usize = 20;
pub(crate) const SERVICE_HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(250);

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

/// Query the daemon service for the installer UI.
///
/// The first-run installer can run in environments without a service manager,
/// such as a container used for GUI acceptance tests. In that case the
/// service is unavailable rather than registered, so report [`NotLoaded`].
/// Other errors remain strict so callers do not silently ignore a broken
/// service-manager query. The updater uses [`service_status`] directly because
/// it must not skip a required daemon relaunch after an ambiguous query.
pub fn service_status_for_installation() -> Result<ServiceStatus, InstallerError> {
    soften_unavailable_service_status(service_status())
}

fn soften_unavailable_service_status(
    result: Result<ServiceStatus, InstallerError>,
) -> Result<ServiceStatus, InstallerError> {
    match result {
        Err(error) if error.is_service_manager_unavailable() => Ok(ServiceStatus::NotLoaded),
        result => result,
    }
}

/// Relaunch the daemon only when it is already registered with the OS service
/// manager, then wait for it to report a healthy running process.
///
/// This function never writes a service definition, enables a unit, or loads
/// an unregistered service. Callers can therefore use it after replacing the
/// managed daemon binary without changing the user's registration choice.
pub fn relaunch_service_if_registered() -> Result<ServiceRelaunch, InstallerError> {
    #[cfg(target_os = "macos")]
    {
        crate::macos::relaunch_service_if_registered()
    }
    #[cfg(target_os = "linux")]
    {
        crate::linux::relaunch_service_if_registered()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(InstallerError::UnsupportedPlatform)
    }
}

pub(crate) fn relaunch_registered_service_with<Status, Relaunch, Wait>(
    mut status: Status,
    mut relaunch: Relaunch,
    mut wait: Wait,
) -> Result<ServiceRelaunch, InstallerError>
where
    Status: FnMut() -> Result<ServiceStatus, InstallerError>,
    Relaunch: FnMut() -> Result<(), InstallerError>,
    Wait: FnMut(),
{
    let before = status()?;
    if before == ServiceStatus::NotLoaded {
        return Ok(ServiceRelaunch::NotRegistered);
    }
    relaunch()?;

    let mut last_status = before;
    for attempt in 0..SERVICE_HEALTH_ATTEMPTS {
        if attempt > 0 {
            wait();
        }
        last_status = status()?;
        if let ServiceStatus::Running { pid } = last_status {
            return Ok(ServiceRelaunch::Restarted { pid });
        }
    }

    Err(InstallerError::ServiceHealth {
        reason: format!(
            "expected a running process after {SERVICE_HEALTH_ATTEMPTS} checks, got {last_status}"
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

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

    #[test]
    fn relaunch_skips_unregistered_service_without_running_restart_command() {
        let restart_called = Cell::new(false);

        let outcome = relaunch_registered_service_with(
            || Ok(ServiceStatus::NotLoaded),
            || {
                restart_called.set(true);
                Ok(())
            },
            || {},
        )
        .unwrap();

        assert_eq!(outcome, ServiceRelaunch::NotRegistered);
        assert!(!restart_called.get());
    }

    #[test]
    fn relaunch_registered_service_accepts_a_healthy_reused_pid() {
        let checks = Cell::new(0);
        let restart_calls = Cell::new(0);
        let waits = Cell::new(0);

        let outcome = relaunch_registered_service_with(
            || {
                let check = checks.get();
                checks.set(check + 1);
                Ok(match check {
                    0 => ServiceStatus::Running { pid: 10 },
                    1 => ServiceStatus::Loaded {
                        last_exit_status: 0,
                    },
                    _ => ServiceStatus::Running { pid: 10 },
                })
            },
            || {
                restart_calls.set(restart_calls.get() + 1);
                Ok(())
            },
            || waits.set(waits.get() + 1),
        )
        .unwrap();

        assert_eq!(outcome, ServiceRelaunch::Restarted { pid: 10 });
        assert_eq!(restart_calls.get(), 1);
        assert_eq!(checks.get(), 3);
        assert_eq!(waits.get(), 1);
    }

    #[test]
    fn relaunch_command_failure_is_returned_without_health_polling() {
        let checks = Cell::new(0);
        let error = relaunch_registered_service_with(
            || {
                checks.set(checks.get() + 1);
                Ok(ServiceStatus::Loaded {
                    last_exit_status: 1,
                })
            },
            || {
                Err(InstallerError::Systemctl {
                    action: "restart vertebrae-daemon".to_string(),
                    reason: "job failed".to_string(),
                })
            },
            || {},
        )
        .unwrap_err();

        assert_eq!(checks.get(), 1);
        assert_eq!(
            error.to_string(),
            "systemctl --user restart vertebrae-daemon failed: job failed"
        );
    }

    #[test]
    fn relaunch_reports_last_unhealthy_status_after_bounded_checks() {
        let checks = Cell::new(0);
        let waits = Cell::new(0);
        let error = relaunch_registered_service_with(
            || {
                checks.set(checks.get() + 1);
                Ok(ServiceStatus::Loaded {
                    last_exit_status: 78,
                })
            },
            || Ok(()),
            || waits.set(waits.get() + 1),
        )
        .unwrap_err();

        assert_eq!(checks.get(), SERVICE_HEALTH_ATTEMPTS + 1);
        assert_eq!(waits.get(), SERVICE_HEALTH_ATTEMPTS - 1);
        assert_eq!(
            error.to_string(),
            "Daemon service did not become healthy after relaunch: expected a running process after 20 checks, got loaded but not running (last exit status: 78)"
        );
    }

    #[test]
    fn installation_status_treats_unavailable_service_manager_as_not_loaded() {
        let status = soften_unavailable_service_status(Err(InstallerError::Systemctl {
            action: "show".to_string(),
            reason: "Failed to connect to bus: No medium found".to_string(),
        }))
        .unwrap();

        assert_eq!(status, ServiceStatus::NotLoaded);
    }

    #[test]
    fn installation_status_preserves_other_service_manager_errors() {
        let error = soften_unavailable_service_status(Err(InstallerError::Systemctl {
            action: "show".to_string(),
            reason: "Access denied".to_string(),
        }))
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "systemctl --user show failed: Access denied"
        );
    }
}
