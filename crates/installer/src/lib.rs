//! Shared installer logic for staging Vertebrae binaries (`vtb`, `vtb-daemon`,
//! the GUI shell) into a per-OS data directory, exposing them under
//! `~/.local/bin`, and registering the daemon with the OS service manager
//! (launchd on macOS, systemd `--user` on Linux).
//!
//! Both the CLI (`vtb daemon install/uninstall/status`) and the Tauri GUI
//! installer flow call into this crate. The public API is **sync** on purpose
//! so it can run from a Tauri command handler without dragging tokio into the
//! installer.
//!
//! ## High-level flow
//!
//! ```text
//! install_binary("vtb-daemon", &my_path)
//!   -> ~/Library/Application Support/Vertebrae/bin/vtb-daemon   (copy)
//!   -> ~/.local/bin/vtb-daemon                                  (symlink)
//!
//! install_service(symlink_path)
//!   -> ~/Library/LaunchAgents/com.vertebrae.daemon.plist
//!   -> launchctl load
//! ```
//!
//! macOS service identity (label `com.vertebrae.daemon`, logs under
//! `~/Library/Logs/vertebrae/`) is unchanged from the previous CLI-only
//! implementation so that re-installing over an existing CLI install is
//! idempotent.

mod binary;
mod error;
mod paths;
mod service;

#[cfg(any(target_os = "linux", test))]
pub mod linux;
#[cfg(any(target_os = "macos", test))]
pub mod macos;

pub use binary::{install_binary, uninstall_binary};
pub use error::InstallerError;
pub use paths::{bin_dir, data_bin_dir, log_dir, symlink_path};
pub use service::{
    LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, ServiceInstallReport, ServiceStatus, install_service,
    service_status, uninstall_service,
};
