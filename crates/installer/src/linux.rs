//! Linux service registration via `systemctl --user`.
//!
//! Writes a unit file to `~/.config/systemd/user/vertebrae-daemon.service`,
//! runs `systemctl --user daemon-reload`, then `systemctl --user enable
//! --now vertebrae-daemon`.

#[cfg(target_os = "linux")]
use std::path::Path;
use std::path::PathBuf;

use crate::error::InstallerError;
#[cfg(target_os = "linux")]
use crate::paths::log_dir;
#[cfg(target_os = "linux")]
use crate::service::ServiceInstallReport;
use crate::service::{SYSTEMD_UNIT_NAME, ServiceStatus};

/// Return the path of the systemd `--user` unit file we manage.
///
/// `~/.config/systemd/user/vertebrae-daemon.service`
pub fn unit_path() -> Result<PathBuf, InstallerError> {
    let home = dirs::home_dir().ok_or(InstallerError::HomeDir)?;
    Ok(home
        .join(".config")
        .join("systemd")
        .join("user")
        .join(format!("{SYSTEMD_UNIT_NAME}.service")))
}

/// Generate the systemd unit text for the daemon, given the binary path and
/// log directory.
///
/// Pulled out so unit tests can assert against the generated string.
pub fn generate_unit(binary_path: &str, log_dir: &str) -> String {
    format!(
        "[Unit]\n\
         Description=Vertebrae daemon\n\
         After=network.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={binary_path}\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         StandardOutput=append:{log_dir}/daemon.log\n\
         StandardError=append:{log_dir}/daemon.error.log\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

#[cfg(target_os = "linux")]
pub(crate) fn install_service(binary_path: &Path) -> Result<ServiceInstallReport, InstallerError> {
    use std::fs;
    use std::process::Command;

    let unit = unit_path()?;
    let logs = log_dir()?;

    if let Some(parent) = unit.parent() {
        fs::create_dir_all(parent).map_err(|e| InstallerError::CreateDir {
            path: parent.to_path_buf(),
            reason: e.to_string(),
        })?;
    }
    fs::create_dir_all(&logs).map_err(|e| InstallerError::CreateDir {
        path: logs.clone(),
        reason: e.to_string(),
    })?;

    let content = generate_unit(
        &binary_path.display().to_string(),
        &logs.display().to_string(),
    );
    fs::write(&unit, &content).map_err(|e| InstallerError::WriteServiceFile {
        path: unit.clone(),
        reason: e.to_string(),
    })?;

    run_systemctl(["daemon-reload"])?;
    run_systemctl(["enable", "--now", SYSTEMD_UNIT_NAME])?;

    Ok(ServiceInstallReport {
        label: SYSTEMD_UNIT_NAME.to_string(),
        service_file: unit,
        binary_path: binary_path.to_path_buf(),
        stdout_log: logs.join("daemon.log"),
        stderr_log: logs.join("daemon.error.log"),
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn uninstall_service() -> Result<(), InstallerError> {
    use std::fs;

    let unit = unit_path()?;
    if !unit.exists() {
        return Ok(());
    }

    // Best-effort stop/disable. If the unit isn't enabled or isn't running,
    // systemctl returns non-zero — we still want to remove the file.
    let _ = run_systemctl(["disable", "--now", SYSTEMD_UNIT_NAME]);

    fs::remove_file(&unit).map_err(|e| InstallerError::Remove {
        path: unit.clone(),
        reason: e.to_string(),
    })?;

    // Pick up the removal.
    let _ = run_systemctl(["daemon-reload"]);

    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn service_status() -> Result<ServiceStatus, InstallerError> {
    use std::process::Command;

    // Use `show` so we get a stable key=value format; `is-active`/`is-enabled`
    // exit codes are easy to misinterpret on older systemd.
    let output = Command::new("systemctl")
        .args([
            "--user",
            "show",
            SYSTEMD_UNIT_NAME,
            "--property=LoadState,ActiveState,MainPID,ExecMainStatus",
        ])
        .output()
        .map_err(|e| InstallerError::Systemctl {
            action: "show".to_string(),
            reason: e.to_string(),
        })?;

    if !output.status.success() {
        return Ok(ServiceStatus::NotLoaded);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_systemctl_show_output(&stdout))
}

#[cfg(target_os = "linux")]
fn run_systemctl<I, S>(args: I) -> Result<(), InstallerError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    use std::process::Command;

    let args: Vec<std::ffi::OsString> = args
        .into_iter()
        .map(|a| a.as_ref().to_os_string())
        .collect();
    let action = args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");

    let mut cmd = Command::new("systemctl");
    cmd.arg("--user");
    for a in &args {
        cmd.arg(a);
    }

    let output = cmd.output().map_err(|e| InstallerError::Systemctl {
        action: action.clone(),
        reason: e.to_string(),
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(InstallerError::Systemctl {
            action,
            reason: stderr,
        });
    }
    Ok(())
}

/// Parse the key=value output of `systemctl --user show <unit>
/// --property=LoadState,ActiveState,MainPID,ExecMainStatus`.
pub fn parse_systemctl_show_output(output: &str) -> ServiceStatus {
    let mut load_state = "";
    let mut active_state = "";
    let mut main_pid: u32 = 0;
    let mut exec_status: i32 = 0;

    for line in output.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("LoadState=") {
            load_state = v;
        } else if let Some(v) = line.strip_prefix("ActiveState=") {
            active_state = v;
        } else if let Some(v) = line.strip_prefix("MainPID=") {
            main_pid = v.parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("ExecMainStatus=") {
            exec_status = v.parse().unwrap_or(0);
        }
    }

    // `LoadState=not-found` means systemd doesn't know about the unit.
    if load_state == "not-found" || load_state.is_empty() {
        return ServiceStatus::NotLoaded;
    }

    if active_state == "active" && main_pid > 0 {
        ServiceStatus::Running { pid: main_pid }
    } else {
        ServiceStatus::Loaded {
            last_exit_status: exec_status,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_BINARY: &str = "/home/me/.local/bin/vtb-daemon";
    const SAMPLE_LOGS: &str = "/home/me/.local/state/vertebrae/logs";

    #[test]
    fn unit_has_simple_service_type() {
        let unit = generate_unit(SAMPLE_BINARY, SAMPLE_LOGS);
        assert!(
            unit.contains("Type=simple"),
            "systemd unit should use Type=simple"
        );
    }

    #[test]
    fn unit_exec_start_points_at_binary() {
        let unit = generate_unit(SAMPLE_BINARY, SAMPLE_LOGS);
        assert!(
            unit.contains(&format!("ExecStart={SAMPLE_BINARY}")),
            "ExecStart must reference the binary at {SAMPLE_BINARY}"
        );
    }

    #[test]
    fn unit_restarts_on_failure() {
        let unit = generate_unit(SAMPLE_BINARY, SAMPLE_LOGS);
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("RestartSec=5"));
    }

    #[test]
    fn unit_logs_to_xdg_state() {
        let unit = generate_unit(SAMPLE_BINARY, SAMPLE_LOGS);
        assert!(
            unit.contains(&format!("StandardOutput=append:{SAMPLE_LOGS}/daemon.log")),
            "stdout should append to daemon.log under the log dir"
        );
        assert!(
            unit.contains(&format!(
                "StandardError=append:{SAMPLE_LOGS}/daemon.error.log"
            )),
            "stderr should append to daemon.error.log under the log dir"
        );
    }

    #[test]
    fn unit_has_install_section_for_user_default_target() {
        let unit = generate_unit(SAMPLE_BINARY, SAMPLE_LOGS);
        assert!(
            unit.contains("[Install]"),
            "unit must have an [Install] section so `enable` works"
        );
        assert!(
            unit.contains("WantedBy=default.target"),
            "user units should be WantedBy=default.target"
        );
    }

    #[test]
    fn unit_starts_with_unit_section() {
        let unit = generate_unit(SAMPLE_BINARY, SAMPLE_LOGS);
        assert!(
            unit.starts_with("[Unit]\n"),
            "unit must start with [Unit] section"
        );
        assert!(
            unit.contains("Description=Vertebrae daemon"),
            "[Unit] should carry a human description"
        );
    }

    #[test]
    fn parse_show_running() {
        let output = "LoadState=loaded\nActiveState=active\nMainPID=4242\nExecMainStatus=0\n";
        assert_eq!(
            parse_systemctl_show_output(output),
            ServiceStatus::Running { pid: 4242 }
        );
    }

    #[test]
    fn parse_show_loaded_but_inactive() {
        let output = "LoadState=loaded\nActiveState=inactive\nMainPID=0\nExecMainStatus=3\n";
        assert_eq!(
            parse_systemctl_show_output(output),
            ServiceStatus::Loaded {
                last_exit_status: 3
            }
        );
    }

    #[test]
    fn parse_show_not_found() {
        let output = "LoadState=not-found\nActiveState=inactive\nMainPID=0\nExecMainStatus=0\n";
        assert_eq!(
            parse_systemctl_show_output(output),
            ServiceStatus::NotLoaded
        );
    }

    #[test]
    fn parse_show_empty_treated_as_not_loaded() {
        assert_eq!(parse_systemctl_show_output(""), ServiceStatus::NotLoaded);
    }

    #[test]
    fn parse_show_loaded_active_but_pid_zero_is_loaded() {
        // Edge case: ActiveState=active with no MainPID — treat as loaded.
        let output = "LoadState=loaded\nActiveState=active\nMainPID=0\nExecMainStatus=0\n";
        assert_eq!(
            parse_systemctl_show_output(output),
            ServiceStatus::Loaded {
                last_exit_status: 0
            }
        );
    }
}
