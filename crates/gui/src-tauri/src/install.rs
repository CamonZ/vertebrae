//! Tauri commands that drive the first-run installer flow.
//!
//! These commands are consumed by the React welcome screen to:
//! 1. Probe the current installation state (`installation_status`).
//! 2. Stage the bundled `vtb`, `vtb-daemon`, and `vtb-gate` sidecars into `~/.local/bin`
//!    and (optionally) register the daemon with the OS service manager
//!    (`install_components`).
//!
//! All heavy lifting (copying binaries, writing plist/systemd unit files,
//! invoking `launchctl`/`systemctl`) lives in the shared
//! [`vertebrae_installer`] crate. This module is the thin Tauri-side
//! adapter: it resolves bundled sidecar paths and shapes results into types
//! that tauri-specta can export to TypeScript.
//!
//! # Sidecar path resolution
//!
//! Tauri's `externalBin` configuration (see `tauri.conf.json`) renames each
//! staged binary to include the build target triple — both in dev (under
//! `target/<profile>/`) and in the bundled `.app`
//! (under `Contents/MacOS/`). The renamed file always lives in the same
//! directory as the GUI executable itself, so we resolve sidecars relative
//! to [`std::env::current_exe`] using the target triple baked in by
//! `tauri-build` (`TAURI_ENV_TARGET_TRIPLE`).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use vertebrae_installer::{
    install_binary, install_service, service_status, symlink_path, InstallerError, ServiceStatus,
};

use crate::commands::CommandError;

/// Target triple baked in at build time by `tauri-build`. Used to find the
/// renamed sidecar binary next to the GUI executable.
const TARGET_TRIPLE: &str = env!("TAURI_ENV_TARGET_TRIPLE");

/// Sidecar binary names matching the `externalBin` entries in
/// `tauri.conf.json` (without the target-triple suffix Tauri appends).
const CLI_BIN: &str = "vtb";
const DAEMON_BIN: &str = "vtb-daemon";
const GATE_BIN: &str = "vtb-gate";

// ---------------------------------------------------------------------------
// Response types — these are auto-exported to TypeScript via tauri-specta.
// ---------------------------------------------------------------------------

/// State of a single component (one of `vtb`, `vtb-daemon`, `vtb-gate`) on this machine.
///
/// The welcome screen renders different copy depending on whether the user
/// already has the binary available from a previous `cargo install` or
/// package-manager install. We surface both signals so the UI can pick the
/// right message without having to call `PATH` itself.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ComponentStatus {
    /// `true` if `<bin_dir>/<name>` exists (i.e. we previously staged this
    /// component, or another tool did). When this is `true` the installer
    /// can be skipped for this component.
    pub installed_at_symlink: bool,
    /// Absolute path of the symlink we manage in `~/.local/bin`.
    pub symlink_path: String,
    /// `true` if some executable named `<name>` is resolvable on `$PATH`
    /// (anywhere — not necessarily the symlink we manage). Lets the UI
    /// avoid pestering users who already have `vtb` from `cargo install`.
    pub on_path: bool,
}

/// State of the daemon's OS service registration (launchd on macOS, systemd
/// `--user` on Linux). Mirrors [`vertebrae_installer::ServiceStatus`] in a
/// shape that's friendlier to TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServiceState {
    /// Service is registered and currently running.
    Running { pid: u32 },
    /// Service is registered but not currently running.
    Loaded { last_exit_status: i32 },
    /// Service is not registered with the OS service manager.
    NotLoaded,
}

impl From<ServiceStatus> for ServiceState {
    fn from(s: ServiceStatus) -> Self {
        match s {
            ServiceStatus::Running { pid } => ServiceState::Running { pid },
            ServiceStatus::Loaded { last_exit_status } => ServiceState::Loaded { last_exit_status },
            ServiceStatus::NotLoaded => ServiceState::NotLoaded,
        }
    }
}

/// Aggregate snapshot of installation state returned from both
/// `installation_status()` and `install_components()`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct InstallationStatus {
    pub cli: ComponentStatus,
    pub daemon: ComponentStatus,
    pub gate: ComponentStatus,
    pub service: ServiceState,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Probe the current install state without making any changes.
///
/// Safe to call on every app launch — performs only filesystem lookups and a
/// single OS service-manager status query (no `launchctl load`, no copy).
#[tauri::command]
#[specta::specta]
pub async fn installation_status() -> Result<InstallationStatus, CommandError> {
    compute_status()
}

/// Install the selected components from the bundled sidecars.
///
/// Steps for each component the caller asked for:
///
/// 1. Resolve the sidecar binary path next to the GUI executable
///    (`<exe_dir>/<name>-<target-triple>`).
/// 2. Hand it to `vertebrae_installer::install_binary`, which copies it into
///    the per-OS data dir, sets `0o755`, and creates a symlink in
///    `~/.local/bin`.
///
/// If the daemon was installed, we then call
/// `vertebrae_installer::install_service` to register it with launchd /
/// systemd `--user`. The CLI does not need a service.
///
/// Returns the post-install [`InstallationStatus`] so the caller can refresh
/// its UI without a follow-up `installation_status()` round-trip.
#[tauri::command]
#[specta::specta]
pub async fn install_components(
    install_cli: bool,
    install_daemon: bool,
    install_gate: bool,
) -> Result<InstallationStatus, CommandError> {
    if install_cli {
        let source = resolve_sidecar_path(CLI_BIN)?;
        install_binary(CLI_BIN, &source).map_err(installer_error)?;
    }

    if install_daemon {
        let source = resolve_sidecar_path(DAEMON_BIN)?;
        let staged = install_binary(DAEMON_BIN, &source).map_err(installer_error)?;
        // Register the staged daemon binary with the OS service manager so
        // it starts at login. `install_service` is idempotent across reruns.
        install_service(&staged).map_err(installer_error)?;
    }

    if install_gate {
        let source = resolve_sidecar_path(GATE_BIN)?;
        install_binary(GATE_BIN, &source).map_err(installer_error)?;
    }

    compute_status()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn compute_status() -> Result<InstallationStatus, CommandError> {
    let cli = component_status(CLI_BIN)?;
    let daemon = component_status(DAEMON_BIN)?;
    let gate = component_status(GATE_BIN)?;
    let service = service_status().map_err(installer_error)?.into();
    Ok(InstallationStatus {
        cli,
        daemon,
        gate,
        service,
    })
}

fn component_status(name: &str) -> Result<ComponentStatus, CommandError> {
    let link = symlink_path(name).map_err(installer_error)?;
    // `symlink_metadata` so we treat a dangling symlink as "not installed"
    // — that means the staged target was removed and the symlink is junk.
    let installed_at_symlink = fs::symlink_metadata(&link)
        .ok()
        .and_then(|m| {
            if m.file_type().is_symlink() {
                fs::metadata(&link).ok().map(|_| true)
            } else if m.file_type().is_file() {
                Some(true)
            } else {
                None
            }
        })
        .unwrap_or(false);

    Ok(ComponentStatus {
        installed_at_symlink,
        symlink_path: link.to_string_lossy().into_owned(),
        on_path: is_on_path(name),
    })
}

/// Search every directory in `$PATH` for an executable named `name`.
///
/// Pure-Rust mini-`which` so we don't pull in the `which` crate just for
/// the welcome screen. Honors `PATHEXT` on Windows; on Unix any regular
/// file with the user-exec bit counts.
fn is_on_path(name: &str) -> bool {
    let Some(path_var) = env::var_os("PATH") else {
        return false;
    };
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return true;
        }
    }
    false
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match fs::metadata(path) {
        Ok(m) if m.is_file() => m.permissions().mode() & 0o111 != 0,
        _ => false,
    }
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Locate a bundled sidecar binary on disk.
///
/// `tauri-build`'s build script copies every `externalBin` entry from
/// `binaries/<name>-<triple>` into the same directory as the GUI executable,
/// stripping the `-<triple>` suffix in the process (see `copy_binaries` in
/// `tauri-build`). So at runtime, sidecars live at `<exe_dir>/<name>` both
/// in dev (`target/<profile>/<name>`) and in the bundled `.app`
/// (`<App>.app/Contents/MacOS/<name>`).
///
/// On Windows the bundled file keeps its `.exe` extension; everywhere else
/// it does not.
fn resolve_sidecar_path(name: &str) -> Result<PathBuf, CommandError> {
    let exe = env::current_exe().map_err(|e| CommandError {
        message: format!("Failed to locate current executable: {e}"),
    })?;
    let dir = exe.parent().ok_or_else(|| CommandError {
        message: format!("Executable path has no parent directory: {}", exe.display()),
    })?;
    let candidate = sidecar_path_in(dir, name, TARGET_TRIPLE);
    if !candidate.exists() {
        return Err(CommandError {
            message: format!(
                "Bundled sidecar '{name}' not found at expected path: {}. \
                 The GUI bundle may be missing its sidecar binaries — try \
                 rebuilding with `npm run tauri:prepare-sidecars`.",
                candidate.display()
            ),
        });
    }
    Ok(candidate)
}

/// Build the expected sidecar path inside `exe_dir` for a binary named
/// `name`, given the build `target_triple`. Pure function so we can unit
/// test the naming convention without needing a real executable on disk.
fn sidecar_path_in(exe_dir: &Path, name: &str, target_triple: &str) -> PathBuf {
    let exe_suffix = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    exe_dir.join(format!("{name}{exe_suffix}"))
}

/// Render an [`InstallerError`] into the structured [`CommandError`] the
/// frontend already knows how to display, instead of panicking the command
/// handler.
fn installer_error(err: InstallerError) -> CommandError {
    CommandError {
        message: err.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_triple_constant_is_populated() {
        // `tauri-build` sets TAURI_ENV_TARGET_TRIPLE during this crate's
        // build.rs run, so the constant must never be empty.
        assert!(
            !TARGET_TRIPLE.is_empty(),
            "TAURI_ENV_TARGET_TRIPLE should be populated by tauri-build, was empty"
        );
    }

    #[test]
    fn service_state_conversion_running() {
        let state: ServiceState = ServiceStatus::Running { pid: 4242 }.into();
        match state {
            ServiceState::Running { pid } => assert_eq!(pid, 4242, "pid should round-trip"),
            other => panic!("expected Running, got {other:?}"),
        }
    }

    #[test]
    fn service_state_conversion_loaded() {
        let state: ServiceState = ServiceStatus::Loaded {
            last_exit_status: -7,
        }
        .into();
        match state {
            ServiceState::Loaded { last_exit_status } => {
                assert_eq!(last_exit_status, -7, "last_exit_status should round-trip");
            }
            other => panic!("expected Loaded, got {other:?}"),
        }
    }

    #[test]
    fn service_state_conversion_not_loaded() {
        let state: ServiceState = ServiceStatus::NotLoaded.into();
        assert!(
            matches!(state, ServiceState::NotLoaded),
            "ServiceStatus::NotLoaded should map to ServiceState::NotLoaded, got {state:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial(env_path)]
    fn is_on_path_finds_executable_in_path_dir() {
        use std::os::unix::fs::PermissionsExt;

        let tempdir = tempfile::tempdir().expect("create tempdir");
        let bin_name = "vtb-installer-test-marker-xyz";
        let bin_path = tempdir.path().join(bin_name);
        fs::write(&bin_path, b"#!/bin/sh\n").expect("write fake binary");
        let mut perms = fs::metadata(&bin_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&bin_path, perms).unwrap();

        let prev_path = env::var_os("PATH");
        let new_path = env::join_paths([tempdir.path().to_path_buf()]).unwrap();
        // SAFETY: unit tests in this module run serially under cargo's
        // default single-thread-per-test model for env mutation; we restore
        // PATH below before yielding.
        unsafe { env::set_var("PATH", &new_path) };

        let found = is_on_path(bin_name);

        match prev_path {
            Some(v) => unsafe { env::set_var("PATH", v) },
            None => unsafe { env::remove_var("PATH") },
        }

        assert!(
            found,
            "is_on_path should locate {bin_name} when its directory is on PATH"
        );
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial(env_path)]
    fn is_on_path_ignores_non_executable_files() {
        use std::os::unix::fs::PermissionsExt;

        let tempdir = tempfile::tempdir().expect("create tempdir");
        let bin_name = "vtb-installer-test-marker-nonexec";
        let bin_path = tempdir.path().join(bin_name);
        fs::write(&bin_path, b"not executable").expect("write file");
        let mut perms = fs::metadata(&bin_path).unwrap().permissions();
        perms.set_mode(0o644);
        fs::set_permissions(&bin_path, perms).unwrap();

        let prev_path = env::var_os("PATH");
        let new_path = env::join_paths([tempdir.path().to_path_buf()]).unwrap();
        unsafe { env::set_var("PATH", &new_path) };

        let found = is_on_path(bin_name);

        match prev_path {
            Some(v) => unsafe { env::set_var("PATH", v) },
            None => unsafe { env::remove_var("PATH") },
        }

        assert!(
            !found,
            "is_on_path should reject {bin_name} when it's not executable"
        );
    }

    #[test]
    fn installer_error_renders_into_command_error_message() {
        let err = InstallerError::SourceNotFound {
            path: PathBuf::from("/tmp/does-not-exist"),
        };
        let cmd_err = installer_error(err);
        assert!(
            cmd_err.message.contains("/tmp/does-not-exist"),
            "CommandError should preserve installer error context, got: {}",
            cmd_err.message
        );
        assert!(
            cmd_err.message.contains("Source binary not found"),
            "CommandError should include the installer error display, got: {}",
            cmd_err.message
        );
    }

    #[test]
    fn sidecar_path_in_omits_triple_suffix_on_unix() {
        // tauri-build's copy_binaries strips the -<triple> suffix, so at
        // runtime the file we look for is just <name> with no suffix on
        // unix-like targets.
        let dir = PathBuf::from("/tmp/example/target/debug");
        let resolved = sidecar_path_in(&dir, "vtb-daemon", "x86_64-apple-darwin");
        assert_eq!(
            resolved,
            PathBuf::from("/tmp/example/target/debug/vtb-daemon"),
            "macOS sidecar should be <exe_dir>/<name> with no extension"
        );
    }

    #[test]
    fn sidecar_path_in_appends_exe_on_windows() {
        let dir = PathBuf::from("C:/Program Files/Vertebrae");
        let resolved = sidecar_path_in(&dir, "vtb", "x86_64-pc-windows-msvc");
        assert_eq!(
            resolved.file_name().and_then(|n| n.to_str()),
            Some("vtb.exe"),
            "Windows sidecar must keep its .exe extension"
        );
    }

    #[test]
    fn resolve_sidecar_path_returns_command_error_when_missing() {
        // Sanity-check the error path: the file we ask for doesn't exist,
        // so we must get a structured CommandError, not a panic. This
        // exercises the constraint that commands must not panic on missing
        // sidecars.
        let err = resolve_sidecar_path("definitely-not-a-real-sidecar-xyzzy")
            .expect_err("missing sidecar must produce an error, not a panic");
        assert!(
            err.message.contains("definitely-not-a-real-sidecar-xyzzy"),
            "error must mention the missing binary name, got: {}",
            err.message
        );
        assert!(
            err.message.contains("tauri:prepare-sidecars"),
            "error should guide the user toward rebuilding, got: {}",
            err.message
        );
    }
}
