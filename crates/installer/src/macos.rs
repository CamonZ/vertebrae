//! macOS-specific service registration via `launchctl` and the per-user
//! `~/Library/LaunchAgents/` plist.
//!
//! Public-facing labels and log paths are kept stable
//! (`com.vertebrae.daemon`, `~/Library/Logs/vertebrae/`) so re-installing
//! over a previous CLI-only install is idempotent — the same plist file
//! gets rewritten and the same `launchctl` label gets re-loaded.

#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;

use crate::error::InstallerError;
#[cfg(target_os = "macos")]
use crate::paths::log_dir;
#[cfg(target_os = "macos")]
use crate::service::ServiceInstallReport;
use crate::service::{LAUNCHD_LABEL, ServiceStatus};
#[cfg(target_os = "macos")]
use crate::service::{
    SERVICE_HEALTH_POLL_INTERVAL, ServiceRelaunch, relaunch_registered_service_with,
};

/// Return the user LaunchAgents plist path for the daemon.
///
/// `~/Library/LaunchAgents/com.vertebrae.daemon.plist`
pub fn plist_path() -> Result<PathBuf, InstallerError> {
    let home = dirs::home_dir().ok_or(InstallerError::HomeDir)?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist")))
}

/// Generate the launchd plist XML for a daemon binary at `binary_path`.
///
/// Pulled out so unit tests can assert against the string without touching
/// the filesystem.
pub fn generate_plist(binary_path: &str) -> String {
    let label = LAUNCHD_LABEL;
    // If we can't resolve $HOME at plist-generation time, fall back to /tmp —
    // /tmp is always writable, which beats a plist with empty log paths.
    let home_str = dirs::home_dir()
        .map(|h| h.display().to_string())
        .unwrap_or_else(|| "/tmp".to_string());
    let logs = format!("{home_str}/Library/Logs/vertebrae");
    let stdout = format!("{logs}/daemon.log");
    let stderr = format!("{logs}/daemon.error.log");

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary_path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{stdout}</string>
    <key>StandardErrorPath</key>
    <string>{stderr}</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
"#
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn install_service(binary_path: &Path) -> Result<ServiceInstallReport, InstallerError> {
    use std::fs;
    use std::process::Command;

    let plist = plist_path()?;
    let logs = log_dir()?;

    if let Some(parent) = plist.parent() {
        fs::create_dir_all(parent).map_err(|e| InstallerError::CreateDir {
            path: parent.to_path_buf(),
            reason: e.to_string(),
        })?;
    }
    fs::create_dir_all(&logs).map_err(|e| InstallerError::CreateDir {
        path: logs.clone(),
        reason: e.to_string(),
    })?;

    // Best-effort unload so a subsequent `launchctl load` doesn't fail with
    // "service already loaded".
    if plist.exists() {
        let _ = Command::new("launchctl")
            .args(["unload", &plist.display().to_string()])
            .output();
    }

    let plist_str = binary_path.display().to_string();
    let content = generate_plist(&plist_str);
    fs::write(&plist, &content).map_err(|e| InstallerError::WriteServiceFile {
        path: plist.clone(),
        reason: e.to_string(),
    })?;

    let output = Command::new("launchctl")
        .args(["load", &plist.display().to_string()])
        .output()
        .map_err(|e| InstallerError::Launchctl {
            action: "load".to_string(),
            reason: e.to_string(),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(InstallerError::Launchctl {
            action: "load".to_string(),
            reason: stderr,
        });
    }

    Ok(ServiceInstallReport {
        label: LAUNCHD_LABEL.to_string(),
        service_file: plist,
        binary_path: binary_path.to_path_buf(),
        stdout_log: logs.join("daemon.log"),
        stderr_log: logs.join("daemon.error.log"),
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn uninstall_service() -> Result<(), InstallerError> {
    use std::fs;
    use std::process::Command;

    let plist = plist_path()?;
    if !plist.exists() {
        return Ok(());
    }

    let output = Command::new("launchctl")
        .args(["unload", &plist.display().to_string()])
        .output()
        .map_err(|e| InstallerError::Launchctl {
            action: "unload".to_string(),
            reason: e.to_string(),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // If the service isn't currently loaded, that's fine — we still
        // remove the plist below.
        if !stderr.contains("Could not find specified service") {
            return Err(InstallerError::Launchctl {
                action: "unload".to_string(),
                reason: stderr.trim().to_string(),
            });
        }
    }

    fs::remove_file(&plist).map_err(|e| InstallerError::Remove {
        path: plist.clone(),
        reason: e.to_string(),
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn service_status() -> Result<ServiceStatus, InstallerError> {
    use std::process::Command;

    let output = Command::new("launchctl")
        .args(["list", LAUNCHD_LABEL])
        .output()
        .map_err(|e| InstallerError::Launchctl {
            action: "list".to_string(),
            reason: e.to_string(),
        })?;

    if !output.status.success() {
        return launchctl_list_failure(
            &output.status.to_string(),
            &String::from_utf8_lossy(&output.stderr),
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_launchctl_list_output(&stdout))
}

#[cfg(target_os = "macos")]
pub(crate) fn relaunch_service_if_registered() -> Result<ServiceRelaunch, InstallerError> {
    relaunch_registered_service_with(service_status, kickstart_service, || {
        std::thread::sleep(SERVICE_HEALTH_POLL_INTERVAL)
    })
}

#[cfg(target_os = "macos")]
fn kickstart_service() -> Result<(), InstallerError> {
    use std::process::Command;

    let uid_output =
        Command::new("id")
            .arg("-u")
            .output()
            .map_err(|error| InstallerError::Launchctl {
                action: "resolve user domain".to_string(),
                reason: error.to_string(),
            })?;
    if !uid_output.status.success() {
        return Err(InstallerError::Launchctl {
            action: "resolve user domain".to_string(),
            reason: String::from_utf8_lossy(&uid_output.stderr)
                .trim()
                .to_string(),
        });
    }
    let uid_output = String::from_utf8_lossy(&uid_output.stdout);
    let uid = parse_user_id(&uid_output)?;
    run_kickstart_with(uid, |arguments| {
        Command::new("launchctl").args(arguments).output()
    })
}

#[cfg(any(target_os = "macos", test))]
fn run_kickstart_with<Run>(uid: &str, run: Run) -> Result<(), InstallerError>
where
    Run: FnOnce(&[String]) -> std::io::Result<std::process::Output>,
{
    let arguments = kickstart_arguments(uid);
    let action = arguments.join(" ");
    let output = run(&arguments).map_err(|error| InstallerError::Launchctl {
        action: action.clone(),
        reason: error.to_string(),
    })?;
    if !output.status.success() {
        return Err(InstallerError::Launchctl {
            action,
            reason: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn parse_user_id(output: &str) -> Result<&str, InstallerError> {
    let uid = output.trim();
    if uid.is_empty() || !uid.chars().all(|character| character.is_ascii_digit()) {
        return Err(InstallerError::Launchctl {
            action: "resolve user domain".to_string(),
            reason: format!("unexpected user id '{uid}'"),
        });
    }
    Ok(uid)
}

/// launchd service target used to relaunch the registered per-user agent.
pub fn kickstart_target(uid: &str) -> String {
    format!("gui/{uid}/{LAUNCHD_LABEL}")
}

/// Arguments used to relaunch an already-loaded launchd user agent.
pub fn kickstart_arguments(uid: &str) -> [String; 3] {
    [
        "kickstart".to_string(),
        "-k".to_string(),
        kickstart_target(uid),
    ]
}

#[cfg(any(target_os = "macos", test))]
fn launchctl_service_is_missing(stderr: &str) -> bool {
    stderr.contains("Could not find specified service")
        || stderr.contains("Could not find service")
        || stderr.contains("service not found")
}

#[cfg(any(target_os = "macos", test))]
fn launchctl_list_failure(
    exit_status: &str,
    stderr: &str,
) -> Result<ServiceStatus, InstallerError> {
    let stderr = stderr.trim();
    if launchctl_service_is_missing(stderr) {
        return Ok(ServiceStatus::NotLoaded);
    }
    Err(InstallerError::Launchctl {
        action: "list".to_string(),
        reason: if stderr.is_empty() {
            format!("command exited with {exit_status}")
        } else {
            stderr.to_string()
        },
    })
}

/// Parse the output of `launchctl list <label>`.
///
/// macOS prints either a tab-separated `PID\tStatus\tLabel` line (when
/// called without a specific label) or a detailed `{...}` key-value blob
/// (when called with a specific label). We handle both because behaviour
/// drifts between macOS versions.
pub fn parse_launchctl_list_output(output: &str) -> ServiceStatus {
    let trimmed = output.trim();

    if let Some(status) = try_parse_tabular(trimmed) {
        return status;
    }
    if let Some(status) = try_parse_detailed(trimmed) {
        return status;
    }

    // Got output but couldn't parse it — the service is at least loaded.
    ServiceStatus::Loaded {
        last_exit_status: 0,
    }
}

fn try_parse_tabular(output: &str) -> Option<ServiceStatus> {
    for line in output.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 && parts[2].trim() == LAUNCHD_LABEL {
            let pid_str = parts[0].trim();
            let status_str = parts[1].trim();

            if pid_str == "-" {
                let exit_status = status_str.parse::<i32>().unwrap_or(0);
                return Some(ServiceStatus::Loaded {
                    last_exit_status: exit_status,
                });
            } else if let Ok(pid) = pid_str.parse::<u32>() {
                return Some(ServiceStatus::Running { pid });
            }
        }
    }
    None
}

fn try_parse_detailed(output: &str) -> Option<ServiceStatus> {
    if !output.contains("Label") || !output.contains(LAUNCHD_LABEL) {
        return None;
    }

    let mut pid: Option<u32> = None;
    let mut last_exit_status: i32 = 0;

    for line in output.lines() {
        let line = line.trim().trim_end_matches(';');
        if let Some(rest) = line.strip_prefix("\"PID\"")
            && let Some(value) = rest.split('=').nth(1)
        {
            pid = value.trim().trim_matches('"').parse::<u32>().ok();
        }
        if let Some(rest) = line.strip_prefix("\"LastExitStatus\"")
            && let Some(value) = rest.split('=').nth(1)
        {
            last_exit_status = value.trim().trim_matches('"').parse::<i32>().unwrap_or(0);
        }
    }

    if let Some(pid) = pid {
        Some(ServiceStatus::Running { pid })
    } else {
        Some(ServiceStatus::Loaded { last_exit_status })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    const SAMPLE_BINARY: &str = "/usr/local/bin/vtb-daemon";

    #[test]
    fn plist_contains_stable_label() {
        let plist = generate_plist(SAMPLE_BINARY);
        assert!(
            plist.contains("<string>com.vertebrae.daemon</string>"),
            "plist must carry the stable launchd label"
        );
    }

    #[test]
    fn plist_contains_binary_path() {
        let plist = generate_plist(SAMPLE_BINARY);
        assert!(
            plist.contains(&format!("<string>{SAMPLE_BINARY}</string>")),
            "plist must reference the binary at {SAMPLE_BINARY}"
        );
    }

    #[test]
    fn plist_has_run_at_load_and_keep_alive() {
        let plist = generate_plist(SAMPLE_BINARY);
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
    }

    #[test]
    fn registered_service_relaunch_targets_existing_launchd_user_agent() {
        assert_eq!(kickstart_target("501"), "gui/501/com.vertebrae.daemon");
        assert_eq!(
            kickstart_arguments("501"),
            [
                "kickstart".to_string(),
                "-k".to_string(),
                "gui/501/com.vertebrae.daemon".to_string()
            ]
        );
    }

    #[test]
    fn launchd_user_domain_requires_numeric_user_id() {
        assert_eq!(parse_user_id("501\n").unwrap(), "501");
        assert!(parse_user_id("").is_err());
        assert!(parse_user_id("$(whoami)").is_err());
    }

    #[test]
    fn launchd_kickstart_nonzero_exit_is_returned_with_exact_action() {
        let error = run_kickstart_with("501", |arguments| {
            assert_eq!(arguments, &kickstart_arguments("501"));
            Ok(Output {
                status: ExitStatus::from_raw(1),
                stdout: Vec::new(),
                stderr: b"Not privileged".to_vec(),
            })
        })
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "launchctl kickstart -k gui/501/com.vertebrae.daemon failed: Not privileged"
        );
    }

    #[test]
    fn launchd_only_treats_explicit_not_found_as_not_loaded() {
        assert!(launchctl_service_is_missing(
            "Could not find service com.vertebrae.daemon in domain for user gui: 501"
        ));
        assert!(launchctl_service_is_missing(
            "Could not find specified service"
        ));
        assert!(!launchctl_service_is_missing("Operation not permitted"));

        let error =
            launchctl_list_failure("exit status: 1", "Operation not permitted").unwrap_err();
        assert_eq!(
            error.to_string(),
            "launchctl list failed: Operation not permitted"
        );
        assert_eq!(
            launchctl_list_failure("exit status: 1", "Could not find specified service").unwrap(),
            ServiceStatus::NotLoaded
        );
    }

    #[test]
    fn plist_points_log_paths_at_library_logs_vertebrae() {
        let plist = generate_plist(SAMPLE_BINARY);
        // Stable log path is load-bearing for idempotent re-install.
        assert!(
            plist.contains("Library/Logs/vertebrae/daemon.log"),
            "plist stdout path must remain Library/Logs/vertebrae/daemon.log"
        );
        assert!(
            plist.contains("Library/Logs/vertebrae/daemon.error.log"),
            "plist stderr path must remain Library/Logs/vertebrae/daemon.error.log"
        );
    }

    #[test]
    fn plist_marks_process_as_background() {
        let plist = generate_plist(SAMPLE_BINARY);
        assert!(plist.contains("<key>ProcessType</key>"));
        assert!(plist.contains("<string>Background</string>"));
    }

    #[test]
    fn plist_is_well_formed_xml() {
        let plist = generate_plist(SAMPLE_BINARY);
        assert!(plist.starts_with("<?xml version=\"1.0\""));
        assert!(plist.contains("<!DOCTYPE plist"));
        assert!(plist.contains("<plist version=\"1.0\">"));
        assert!(plist.trim_end().ends_with("</plist>"));
    }

    #[test]
    fn parse_tabular_running() {
        let status = parse_launchctl_list_output("12345\t0\tcom.vertebrae.daemon");
        assert_eq!(status, ServiceStatus::Running { pid: 12345 });
    }

    #[test]
    fn parse_tabular_loaded_not_running() {
        let status = parse_launchctl_list_output("-\t0\tcom.vertebrae.daemon");
        assert_eq!(
            status,
            ServiceStatus::Loaded {
                last_exit_status: 0
            }
        );
    }

    #[test]
    fn parse_tabular_loaded_with_exit_status() {
        let status = parse_launchctl_list_output("-\t78\tcom.vertebrae.daemon");
        assert_eq!(
            status,
            ServiceStatus::Loaded {
                last_exit_status: 78
            }
        );
    }

    #[test]
    fn parse_tabular_picks_the_vertebrae_row() {
        let status = parse_launchctl_list_output(
            "456\t0\tcom.apple.something\n789\t0\tcom.vertebrae.daemon",
        );
        assert_eq!(status, ServiceStatus::Running { pid: 789 });
    }

    #[test]
    fn parse_detailed_running() {
        let output = r#"{
    "LimitLoadToSessionType" = "Aqua";
    "Label" = "com.vertebrae.daemon";
    "OnDemand" = true;
    "LastExitStatus" = 0;
    "PID" = 99887;
    "Program" = "/usr/local/bin/vtb-daemon";
};"#;
        assert_eq!(
            parse_launchctl_list_output(output),
            ServiceStatus::Running { pid: 99887 }
        );
    }

    #[test]
    fn parse_detailed_loaded_with_exit_status() {
        let output = r#"{
    "Label" = "com.vertebrae.daemon";
    "LastExitStatus" = 256;
    "Program" = "/usr/local/bin/vtb-daemon";
};"#;
        assert_eq!(
            parse_launchctl_list_output(output),
            ServiceStatus::Loaded {
                last_exit_status: 256
            }
        );
    }

    #[test]
    fn parse_empty_output_defaults_to_loaded() {
        assert_eq!(
            parse_launchctl_list_output(""),
            ServiceStatus::Loaded {
                last_exit_status: 0
            }
        );
    }
}
