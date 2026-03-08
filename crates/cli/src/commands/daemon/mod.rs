//! Daemon management commands for vtb-daemon launchd service lifecycle.
//!
//! Implements `vtb daemon install`, `vtb daemon uninstall`, and `vtb daemon status`
//! to manage the vtb-daemon process as a macOS launchd service.

mod install;
mod status;
mod uninstall;

pub use install::DaemonInstallCommand;
pub use status::DaemonStatusCommand;
pub use uninstall::DaemonUninstallCommand;

use clap::Subcommand;

/// The launchd service label used for the vtb-daemon plist.
pub const LAUNCHD_LABEL: &str = "com.vertebrae.daemon";

/// Daemon management commands
#[derive(Debug, Subcommand)]
pub enum DaemonCommand {
    /// Install vtb-daemon as a launchd service
    Install(DaemonInstallCommand),
    /// Uninstall the vtb-daemon launchd service
    Uninstall(DaemonUninstallCommand),
    /// Check the status of the vtb-daemon launchd service
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
#[derive(Debug)]
pub enum DaemonError {
    /// The vtb-daemon binary was not found in PATH
    BinaryNotFound(String),
    /// Failed to resolve the vtb-daemon binary path
    BinaryResolution(String),
    /// Failed to create a directory
    CreateDir { path: String, reason: String },
    /// Failed to write the plist file
    WritePlist { path: String, reason: String },
    /// Failed to remove the plist file
    RemovePlist { path: String, reason: String },
    /// launchctl command failed
    Launchctl { action: String, reason: String },
    /// The home directory could not be determined
    HomeDir,
    /// Not supported on this platform
    UnsupportedPlatform,
}

impl std::fmt::Display for DaemonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DaemonError::BinaryNotFound(hint) => {
                write!(f, "vtb-daemon binary not found in PATH. {hint}")
            }
            DaemonError::BinaryResolution(reason) => {
                write!(f, "Failed to resolve vtb-daemon binary path: {reason}")
            }
            DaemonError::CreateDir { path, reason } => {
                write!(f, "Failed to create directory '{path}': {reason}")
            }
            DaemonError::WritePlist { path, reason } => {
                write!(f, "Failed to write plist file '{path}': {reason}")
            }
            DaemonError::RemovePlist { path, reason } => {
                write!(f, "Failed to remove plist file '{path}': {reason}")
            }
            DaemonError::Launchctl { action, reason } => {
                write!(f, "launchctl {action} failed: {reason}")
            }
            DaemonError::HomeDir => write!(f, "Could not determine home directory"),
            DaemonError::UnsupportedPlatform => {
                write!(
                    f,
                    "Daemon service management is only supported on macOS (launchd)"
                )
            }
        }
    }
}

impl std::error::Error for DaemonError {}

/// Return the path to the LaunchAgents plist file.
///
/// `~/Library/LaunchAgents/com.vertebrae.daemon.plist`
pub fn plist_path() -> Result<std::path::PathBuf, DaemonError> {
    let home = dirs::home_dir().ok_or(DaemonError::HomeDir)?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist")))
}

/// Return the directory used for vtb-daemon log files.
///
/// `~/Library/Logs/vertebrae/`
pub fn log_dir() -> Result<std::path::PathBuf, DaemonError> {
    let home = dirs::home_dir().ok_or(DaemonError::HomeDir)?;
    Ok(home.join("Library").join("Logs").join("vertebrae"))
}

/// Generate the launchd plist XML content for vtb-daemon.
pub fn generate_plist(binary_path: &str) -> String {
    let label = LAUNCHD_LABEL;

    // We use the home directory for log paths; if it can't be resolved
    // we fall back to /tmp which is always writable.
    let home = dirs::home_dir()
        .map(|h| h.display().to_string())
        .unwrap_or_else(|| "/tmp".to_string());

    let log_dir = format!("{home}/Library/Logs/vertebrae");
    let stdout_log = format!("{log_dir}/daemon.log");
    let stderr_log = format!("{log_dir}/daemon.error.log");

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
    <string>{stdout_log}</string>
    <key>StandardErrorPath</key>
    <string>{stderr_log}</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_path_is_under_launch_agents() {
        let path = plist_path().unwrap();
        let path_str = path.to_string_lossy();
        assert!(
            path_str.contains("Library/LaunchAgents"),
            "Expected path to contain Library/LaunchAgents, got: {path_str}"
        );
        assert!(
            path_str.ends_with("com.vertebrae.daemon.plist"),
            "Expected path to end with com.vertebrae.daemon.plist, got: {path_str}"
        );
    }

    #[test]
    fn log_dir_is_under_library_logs() {
        let dir = log_dir().unwrap();
        let dir_str = dir.to_string_lossy();
        assert!(
            dir_str.contains("Library/Logs/vertebrae"),
            "Expected path to contain Library/Logs/vertebrae, got: {dir_str}"
        );
    }

    #[test]
    fn generate_plist_contains_label() {
        let plist = generate_plist("/usr/local/bin/vtb-daemon");
        assert!(
            plist.contains("<string>com.vertebrae.daemon</string>"),
            "Plist should contain the label"
        );
    }

    #[test]
    fn generate_plist_contains_binary_path() {
        let binary = "/opt/homebrew/bin/vtb-daemon";
        let plist = generate_plist(binary);
        assert!(
            plist.contains(&format!("<string>{binary}</string>")),
            "Plist should contain the binary path"
        );
    }

    #[test]
    fn generate_plist_has_run_at_load() {
        let plist = generate_plist("/usr/local/bin/vtb-daemon");
        assert!(
            plist.contains("<key>RunAtLoad</key>"),
            "Plist should have RunAtLoad key"
        );
        assert!(
            plist.contains("<true/>"),
            "Plist should have RunAtLoad set to true"
        );
    }

    #[test]
    fn generate_plist_has_keep_alive() {
        let plist = generate_plist("/usr/local/bin/vtb-daemon");
        assert!(
            plist.contains("<key>KeepAlive</key>"),
            "Plist should have KeepAlive key"
        );
    }

    #[test]
    fn generate_plist_has_log_paths() {
        let plist = generate_plist("/usr/local/bin/vtb-daemon");
        assert!(
            plist.contains("Library/Logs/vertebrae/daemon.log"),
            "Plist should have stdout log path"
        );
        assert!(
            plist.contains("Library/Logs/vertebrae/daemon.error.log"),
            "Plist should have stderr log path"
        );
    }

    #[test]
    fn generate_plist_has_background_process_type() {
        let plist = generate_plist("/usr/local/bin/vtb-daemon");
        assert!(
            plist.contains("<key>ProcessType</key>"),
            "Plist should have ProcessType key"
        );
        assert!(
            plist.contains("<string>Background</string>"),
            "Plist should have Background process type"
        );
    }

    #[test]
    fn generate_plist_is_valid_xml_structure() {
        let plist = generate_plist("/usr/local/bin/vtb-daemon");
        assert!(
            plist.starts_with("<?xml version=\"1.0\""),
            "Plist should start with XML declaration"
        );
        assert!(
            plist.contains("<!DOCTYPE plist"),
            "Plist should contain DOCTYPE"
        );
        assert!(
            plist.contains("<plist version=\"1.0\">"),
            "Plist should contain plist root element"
        );
        assert!(
            plist.contains("</plist>"),
            "Plist should close plist element"
        );
    }

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
    fn daemon_error_display_unsupported_platform() {
        let err = DaemonError::UnsupportedPlatform;
        let msg = err.to_string();
        assert!(
            msg.contains("only supported on macOS"),
            "Expected macOS-only message, got: {msg}"
        );
    }

    #[test]
    fn daemon_error_display_write_plist() {
        let err = DaemonError::WritePlist {
            path: "/tmp/test.plist".to_string(),
            reason: "Permission denied".to_string(),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("/tmp/test.plist"),
            "Expected path in message, got: {msg}"
        );
        assert!(
            msg.contains("Permission denied"),
            "Expected reason in message, got: {msg}"
        );
    }

    #[test]
    fn daemon_error_display_launchctl() {
        let err = DaemonError::Launchctl {
            action: "load".to_string(),
            reason: "Service already loaded".to_string(),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("launchctl load failed"),
            "Expected launchctl action in message, got: {msg}"
        );
    }

    #[test]
    fn daemon_error_display_home_dir() {
        let err = DaemonError::HomeDir;
        let msg = err.to_string();
        assert!(
            msg.contains("home directory"),
            "Expected home directory message, got: {msg}"
        );
    }

    #[test]
    fn daemon_error_display_create_dir() {
        let err = DaemonError::CreateDir {
            path: "/some/dir".to_string(),
            reason: "no such file".to_string(),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("/some/dir") && msg.contains("no such file"),
            "Expected path and reason in message, got: {msg}"
        );
    }

    #[test]
    fn daemon_error_display_remove_plist() {
        let err = DaemonError::RemovePlist {
            path: "/tmp/plist".to_string(),
            reason: "not found".to_string(),
        };
        let msg = err.to_string();
        assert!(
            msg.contains("/tmp/plist") && msg.contains("not found"),
            "Expected path and reason in message, got: {msg}"
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
    fn daemon_command_debug() {
        let cmd = DaemonCommand::Status(DaemonStatusCommand {});
        let dbg = format!("{:?}", cmd);
        assert!(
            dbg.contains("Status"),
            "Debug should contain variant name, got: {dbg}"
        );
    }
}
