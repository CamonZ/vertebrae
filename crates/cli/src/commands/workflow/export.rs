use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use clap::Args;
use vertebrae_core::{ServiceError, ServiceResult, WorkflowService};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Args)]
pub struct WorkflowExportCommand {
    /// Export this workflow as a closed bundle.
    #[arg(
        long,
        value_name = "WORKFLOW_ID",
        value_parser = crate::commands::parse_uuid("workflow ID"),
        conflicts_with = "all"
    )]
    pub workflow: Option<String>,

    /// Export every workflow in the active project.
    #[arg(long, conflicts_with = "workflow")]
    pub all: bool,

    /// Write the bundle to this file instead of stdout.
    #[arg(short = 'o', long, alias = "file", value_name = "PATH")]
    pub output: Option<PathBuf>,
}

impl WorkflowExportCommand {
    /// `Some(bytes)` is returned for stdout mode. File mode writes the fully
    /// validated bytes atomically and returns `None`, so a successful file
    /// export does not contaminate stdout with diagnostics or prose.
    pub async fn execute(&self, service: &dyn WorkflowService) -> ServiceResult<Option<String>> {
        let workflow_id = self.selection()?;
        let bundle = service.export_workflow_bundle(workflow_id).await?;
        bundle.validate().map_err(|error| {
            ServiceError::invalid_input(format!("workflow export validation failed: {error}"))
        })?;
        let bytes = bundle.canonical_json().map_err(|error| {
            ServiceError::validation_failed(format!("failed to serialize workflow export: {error}"))
        })?;

        if let Some(path) = &self.output {
            write_atomically(path, bytes.as_bytes())?;
            Ok(None)
        } else {
            Ok(Some(bytes))
        }
    }

    fn selection(&self) -> ServiceResult<Option<&str>> {
        match (self.workflow.as_deref(), self.all) {
            (Some(workflow_id), false) => Ok(Some(workflow_id)),
            (None, true) => Ok(None),
            _ => Err(ServiceError::invalid_input(
                "choose exactly one workflow export selection: --workflow WORKFLOW_ID or --all",
            )),
        }
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> ServiceResult<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        ServiceError::invalid_input(format!(
            "cannot write workflow export to {}: output path has no file name",
            path.display()
        ))
    })?;
    let suffix = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_path = parent.join(format!(
        ".{}.vtb-export-{}-{}",
        file_name.to_string_lossy(),
        std::process::id(),
        suffix
    ));

    let result = (|| {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| output_error("create temporary output", path, error))?;
        temporary
            .write_all(bytes)
            .map_err(|error| output_error("write output", path, error))?;
        temporary
            .sync_all()
            .map_err(|error| output_error("flush output", path, error))?;
        fs::rename(&temporary_path, path)
            .map_err(|error| output_error("replace output", path, error))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn output_error(operation: &str, path: &Path, error: std::io::Error) -> ServiceError {
    ServiceError::invalid_input(format!(
        "failed to {operation} for workflow export {}: {error}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Debug, Parser)]
    struct TestCli {
        #[command(flatten)]
        command: WorkflowExportCommand,
    }

    #[test]
    fn selection_flags_are_mutually_exclusive() {
        let parsed = TestCli::try_parse_from(["test", "--workflow", "deadbeef"]);
        assert!(parsed.is_ok());
        let parsed = TestCli::try_parse_from(["test", "--all"]);
        assert!(parsed.is_ok());
        let parsed = TestCli::try_parse_from(["test", "--all", "--workflow", "deadbeef"]);
        assert!(parsed.is_err());
    }

    #[test]
    fn missing_selection_is_rejected_before_service_use() {
        let command = WorkflowExportCommand {
            workflow: None,
            all: false,
            output: None,
        };
        let error = command.selection().unwrap_err();
        assert!(error.to_string().contains("exactly one"));
    }

    #[test]
    fn failed_atomic_write_preserves_existing_destination() {
        let root = std::env::temp_dir().join(format!(
            "vertebrae-export-test-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("bundle.json");
        fs::write(&destination, b"existing").unwrap();
        let error = write_atomically(&destination.join("child"), b"new").unwrap_err();
        assert!(error.to_string().contains("workflow export"));
        assert_eq!(fs::read(&destination).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
    }
}
