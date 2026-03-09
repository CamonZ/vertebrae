//! `vtb daemon status` — check whether the vtb-daemon launchd service is running.

use clap::Args;

use super::DaemonError;
#[cfg(any(target_os = "macos", test))]
use super::LAUNCHD_LABEL;
#[cfg(target_os = "macos")]
use {super::plist_path, std::process::Command};

/// Check the status of the vtb-daemon launchd service.
#[derive(Debug, Args)]
pub struct DaemonStatusCommand {}

/// Parsed result from `launchctl list`.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq)]
pub enum ServiceStatus {
    /// The service is loaded and running with the given PID.
    Running { pid: u32 },
    /// The service is loaded but not currently running (e.g., it exited).
    /// The exit status of the last run is included.
    Loaded { last_exit_status: i32 },
    /// The service is not loaded (no plist or not loaded via launchctl).
    NotLoaded,
}

#[cfg(any(target_os = "macos", test))]
impl std::fmt::Display for ServiceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceStatus::Running { pid } => write!(f, "running (PID {pid})"),
            ServiceStatus::Loaded { last_exit_status } => {
                write!(
                    f,
                    "loaded but not running (last exit status: {last_exit_status})"
                )
            }
            ServiceStatus::NotLoaded => write!(f, "not loaded"),
        }
    }
}

impl DaemonStatusCommand {
    pub async fn execute(&self) -> Result<String, DaemonError> {
        #[cfg(not(target_os = "macos"))]
        {
            Err(DaemonError::UnsupportedPlatform)
        }

        #[cfg(target_os = "macos")]
        {
            self.execute_macos().await
        }
    }

    #[cfg(target_os = "macos")]
    async fn execute_macos(&self) -> Result<String, DaemonError> {
        let plist = plist_path()?;
        let plist_installed = plist.exists();
        let status = query_service_status()?;

        let mut lines = Vec::new();
        lines.push(format!("Service: {LAUNCHD_LABEL}"));
        lines.push(format!("Status:  {status}"));
        lines.push(format!(
            "Plist:   {}",
            if plist_installed {
                plist.display().to_string()
            } else {
                "not installed".to_string()
            }
        ));

        Ok(lines.join("\n"))
    }
}

/// Query launchctl for the service status.
///
/// Runs `launchctl list <label>` and parses the output.
/// The output format is: `PID\tStatus\tLabel`
/// where PID is `-` if the process is not running.
#[cfg(target_os = "macos")]
fn query_service_status() -> Result<ServiceStatus, DaemonError> {
    let output = Command::new("launchctl")
        .args(["list", LAUNCHD_LABEL])
        .output()
        .map_err(|e| DaemonError::Launchctl {
            action: "list".to_string(),
            reason: e.to_string(),
        })?;

    if !output.status.success() {
        // If launchctl list fails, the service is not loaded
        return Ok(ServiceStatus::NotLoaded);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_launchctl_list_output(&stdout)
}

/// Parse the output of `launchctl list <label>`.
///
/// The single-service output format is a key-value listing.
/// But when called with a specific label, launchctl prints a single line:
///   `PID\tStatus\tLabel`
/// where PID is `-` when the process isn't running.
///
/// However, `launchctl list <label>` on modern macOS actually outputs
/// a detailed key-value format. We handle both.
#[cfg(any(target_os = "macos", test))]
pub fn parse_launchctl_list_output(output: &str) -> Result<ServiceStatus, DaemonError> {
    let trimmed = output.trim();

    // Try the tab-separated format first: "PID\tStatus\tLabel"
    // This is what `launchctl list` (without a specific label) produces per-line.
    // With a specific label, macOS may output this or a detailed format.
    if let Some(status) = try_parse_tabular(trimmed) {
        return Ok(status);
    }

    // Try the detailed key-value format that `launchctl list <label>` sometimes produces.
    if let Some(status) = try_parse_detailed(trimmed) {
        return Ok(status);
    }

    // If we got output but couldn't parse it, the service is at least loaded
    Ok(ServiceStatus::Loaded {
        last_exit_status: 0,
    })
}

/// Try to parse a single tab-separated line: `PID\tStatus\tLabel`
#[cfg(any(target_os = "macos", test))]
fn try_parse_tabular(output: &str) -> Option<ServiceStatus> {
    // Look for lines with our label
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

/// Try to parse the detailed key-value output from `launchctl list <label>`.
///
/// Example output:
/// ```text
/// {
///     "LimitLoadToSessionType" = "Aqua";
///     "Label" = "com.vertebrae.daemon";
///     "OnDemand" = true;
///     "LastExitStatus" = 0;
///     "PID" = 12345;
///     "Program" = "/usr/local/bin/vtb-daemon";
/// };
/// ```
#[cfg(any(target_os = "macos", test))]
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

    #[test]
    fn status_command_debug() {
        let cmd = DaemonStatusCommand {};
        let dbg = format!("{:?}", cmd);
        assert!(
            dbg.contains("DaemonStatusCommand"),
            "Debug should contain struct name, got: {dbg}"
        );
    }

    #[test]
    fn service_status_display_running() {
        let status = ServiceStatus::Running { pid: 42 };
        let display = status.to_string();
        assert_eq!(display, "running (PID 42)");
    }

    #[test]
    fn service_status_display_loaded() {
        let status = ServiceStatus::Loaded {
            last_exit_status: 1,
        };
        let display = status.to_string();
        assert_eq!(display, "loaded but not running (last exit status: 1)");
    }

    #[test]
    fn service_status_display_not_loaded() {
        let status = ServiceStatus::NotLoaded;
        let display = status.to_string();
        assert_eq!(display, "not loaded");
    }

    #[test]
    fn parse_tabular_running() {
        let output = "12345\t0\tcom.vertebrae.daemon";
        let status = parse_launchctl_list_output(output).unwrap();
        assert_eq!(status, ServiceStatus::Running { pid: 12345 });
    }

    #[test]
    fn parse_tabular_loaded_not_running() {
        let output = "-\t0\tcom.vertebrae.daemon";
        let status = parse_launchctl_list_output(output).unwrap();
        assert_eq!(
            status,
            ServiceStatus::Loaded {
                last_exit_status: 0
            }
        );
    }

    #[test]
    fn parse_tabular_loaded_with_exit_status() {
        let output = "-\t78\tcom.vertebrae.daemon";
        let status = parse_launchctl_list_output(output).unwrap();
        assert_eq!(
            status,
            ServiceStatus::Loaded {
                last_exit_status: 78
            }
        );
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
        let status = parse_launchctl_list_output(output).unwrap();
        assert_eq!(status, ServiceStatus::Running { pid: 99887 });
    }

    #[test]
    fn parse_detailed_loaded_no_pid() {
        let output = r#"{
    "Label" = "com.vertebrae.daemon";
    "LastExitStatus" = 256;
    "Program" = "/usr/local/bin/vtb-daemon";
};"#;
        let status = parse_launchctl_list_output(output).unwrap();
        assert_eq!(
            status,
            ServiceStatus::Loaded {
                last_exit_status: 256
            }
        );
    }

    #[test]
    fn parse_detailed_loaded_zero_exit() {
        let output = r#"{
    "Label" = "com.vertebrae.daemon";
    "LastExitStatus" = 0;
};"#;
        let status = parse_launchctl_list_output(output).unwrap();
        assert_eq!(
            status,
            ServiceStatus::Loaded {
                last_exit_status: 0
            }
        );
    }

    #[test]
    fn parse_unrecognized_output_with_label_defaults_to_loaded() {
        let output = "Label = com.vertebrae.daemon\nsome other format";
        let status = parse_launchctl_list_output(output).unwrap();
        // Should still detect as loaded since it contains our label
        assert_eq!(
            status,
            ServiceStatus::Loaded {
                last_exit_status: 0
            }
        );
    }

    #[test]
    fn parse_empty_output_defaults_to_loaded() {
        // Empty output when launchctl succeeds (status 0) means the service exists
        let output = "";
        let status = parse_launchctl_list_output(output).unwrap();
        assert_eq!(
            status,
            ServiceStatus::Loaded {
                last_exit_status: 0
            }
        );
    }

    #[test]
    fn parse_tabular_ignores_other_services() {
        let output = "456\t0\tcom.apple.something\n789\t0\tcom.vertebrae.daemon";
        let status = parse_launchctl_list_output(output).unwrap();
        assert_eq!(status, ServiceStatus::Running { pid: 789 });
    }
}
