//! Per-OS location helpers used by the installer.
//!
//! - **Data directory** (`data_dir`) is the single per-OS root every client
//!   shares for app data: staged binaries, GUI app state, etc.
//! - **Staged binary location** (`data_bin_dir`) is `data_dir()/bin`.
//! - **User-facing symlink location** (`bin_dir`) is `~/.local/bin` on every
//!   Unix so the same `PATH` setup works everywhere.
//! - **Daemon log directory** (`log_dir`) is fixed at
//!   `~/Library/Logs/vertebrae/` on macOS (matches the old CLI install) and
//!   `~/.local/state/vertebrae/logs` on Linux.

use std::path::PathBuf;

use crate::error::InstallerError;

fn home() -> Result<PathBuf, InstallerError> {
    dirs::home_dir().ok_or(InstallerError::HomeDir)
}

/// Return the single per-OS data directory shared by every Vertebrae client.
///
/// This is the one place app data (staged binaries, GUI state, ...) lives, so
/// the CLI, daemon, and GUI all agree on it instead of each rolling their own
/// (bundle-id) directory.
///
/// - macOS: `~/Library/Application Support/Vertebrae`
/// - Linux / other Unix: `~/.local/share/vertebrae`
pub fn data_dir() -> Result<PathBuf, InstallerError> {
    let home = home()?;

    #[cfg(target_os = "macos")]
    {
        Ok(home
            .join("Library")
            .join("Application Support")
            .join("Vertebrae"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(home.join(".local").join("share").join("vertebrae"))
    }
}

/// Return the directory where we stage Vertebrae binaries before symlinking
/// them into `~/.local/bin`. Always `data_dir()/bin`.
pub fn data_bin_dir() -> Result<PathBuf, InstallerError> {
    Ok(data_dir()?.join("bin"))
}

/// Return the user-facing `bin` directory we symlink binaries into.
///
/// Always `~/.local/bin` so a single `PATH` entry works across machines.
pub fn bin_dir() -> Result<PathBuf, InstallerError> {
    Ok(home()?.join(".local").join("bin"))
}

/// Return the path of the symlink we will create for `name` in `bin_dir()`.
pub fn symlink_path(name: &str) -> Result<PathBuf, InstallerError> {
    Ok(bin_dir()?.join(name))
}

/// Return the log directory used by the daemon service.
///
/// - macOS: `~/Library/Logs/vertebrae` (kept stable so the launchd plist
///   keeps writing to the same files as previous CLI installs).
/// - Linux: `~/.local/state/vertebrae/logs` (XDG-ish, also where the
///   generated systemd unit points its `StandardOutput`/`StandardError`
///   `append:` paths).
pub fn log_dir() -> Result<PathBuf, InstallerError> {
    let home = home()?;
    #[cfg(target_os = "macos")]
    {
        Ok(home.join("Library").join("Logs").join("vertebrae"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(home
            .join(".local")
            .join("state")
            .join("vertebrae")
            .join("logs"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[serial_test::serial]
    fn bin_dir_is_under_local_bin() {
        let dir = bin_dir().expect("home dir resolvable in tests");
        assert!(
            dir.ends_with(".local/bin"),
            "bin_dir should end with .local/bin, got {dir:?}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn symlink_path_uses_provided_name() {
        let path = symlink_path("vtb-daemon").expect("home dir resolvable in tests");
        assert!(
            path.ends_with("vtb-daemon"),
            "symlink_path should end with the binary name, got {path:?}"
        );
        assert!(
            path.parent()
                .expect("symlink has parent")
                .ends_with(".local/bin"),
            "symlink_path parent should be .local/bin, got {path:?}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn data_bin_dir_is_data_dir_plus_bin() {
        let data = data_dir().expect("home dir resolvable in tests");
        let bin = data_bin_dir().expect("home dir resolvable in tests");
        assert_eq!(
            bin,
            data.join("bin"),
            "data_bin_dir should be data_dir()/bin"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial_test::serial]
    fn data_dir_is_under_application_support_on_macos() {
        let dir = data_dir().expect("home dir resolvable in tests");
        let s = dir.to_string_lossy();
        assert!(
            s.ends_with("Library/Application Support/Vertebrae"),
            "data_dir on macOS should be ~/Library/Application Support/Vertebrae, got {s}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial_test::serial]
    fn data_bin_dir_is_under_application_support_on_macos() {
        let dir = data_bin_dir().expect("home dir resolvable in tests");
        let s = dir.to_string_lossy();
        assert!(
            s.contains("Library/Application Support/Vertebrae/bin"),
            "data_bin_dir on macOS should be under Application Support, got {s}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[serial_test::serial]
    fn data_bin_dir_is_under_xdg_data_on_linux() {
        let dir = data_bin_dir().expect("home dir resolvable in tests");
        let s = dir.to_string_lossy();
        assert!(
            s.contains(".local/share/vertebrae/bin"),
            "data_bin_dir on linux should be under .local/share/vertebrae/bin, got {s}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial_test::serial]
    fn log_dir_is_under_library_logs_on_macos() {
        let dir = log_dir().expect("home dir resolvable in tests");
        let s = dir.to_string_lossy();
        assert!(
            s.contains("Library/Logs/vertebrae"),
            "log_dir on macOS must stay under Library/Logs/vertebrae for idempotent re-install, got {s}"
        );
    }
}
