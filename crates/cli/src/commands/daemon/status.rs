//! `vtb daemon status` — check whether the vtb-daemon service is loaded /
//! running via the shared [`vertebrae_installer`] crate.

use clap::Args;
use vertebrae_installer as installer;

use super::{DaemonError, LAUNCHD_LABEL};

/// Check the status of the vtb-daemon service.
#[derive(Debug, Args)]
pub struct DaemonStatusCommand {}

impl DaemonStatusCommand {
    pub async fn execute(&self) -> Result<String, DaemonError> {
        let status = installer::service_status()?;
        let mut lines = vec![
            format!("Service: {LAUNCHD_LABEL}"),
            format!("Status:  {status}"),
        ];
        if let Some(service_file_line) = service_file_line()? {
            lines.push(service_file_line);
        }
        Ok(lines.join("\n"))
    }
}

#[cfg(target_os = "macos")]
fn service_file_line() -> Result<Option<String>, DaemonError> {
    let plist = installer::macos::plist_path()?;
    let label = if plist.exists() {
        plist.display().to_string()
    } else {
        "not installed".to_string()
    };
    Ok(Some(format!("Plist:   {label}")))
}

#[cfg(target_os = "linux")]
fn service_file_line() -> Result<Option<String>, DaemonError> {
    let unit = installer::linux::unit_path()?;
    let label = if unit.exists() {
        unit.display().to_string()
    } else {
        "not installed".to_string()
    };
    Ok(Some(format!("Unit:    {label}")))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn service_file_line() -> Result<Option<String>, DaemonError> {
    Ok(None)
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
}
