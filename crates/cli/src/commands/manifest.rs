use std::path::PathBuf;

use clap::{Args, Subcommand};

use crate::manifest;

/// CLI command manifest and documentation validation
#[derive(Debug, Subcommand)]
pub enum ManifestCommand {
    /// Print the source-of-truth CLI command manifest as JSON
    Print(ManifestPrintCommand),
    /// Validate CLI docs and skills against the source-of-truth manifest
    #[command(name = "validate-docs")]
    ValidateDocs(ManifestValidateDocsCommand),
}

impl ManifestCommand {
    pub fn execute(&self) -> Result<String, String> {
        match self {
            ManifestCommand::Print(cmd) => cmd.execute(),
            ManifestCommand::ValidateDocs(cmd) => cmd.execute(),
        }
    }
}

/// Print the source-of-truth CLI command manifest as JSON
#[derive(Debug, Args)]
pub struct ManifestPrintCommand {}

impl ManifestPrintCommand {
    fn execute(&self) -> Result<String, String> {
        manifest::manifest_json().map_err(|e| e.to_string())
    }
}

/// Validate CLI docs and skills against the source-of-truth manifest
#[derive(Debug, Args)]
pub struct ManifestValidateDocsCommand {
    /// Repository root containing docs/ and skills/
    #[arg(long, default_value = ".")]
    pub repo_root: PathBuf,
}

impl ManifestValidateDocsCommand {
    fn execute(&self) -> Result<String, String> {
        let report = manifest::validate_docs(&self.repo_root);
        if report.is_ok() {
            Ok(report.render())
        } else {
            Err(report.render())
        }
    }
}
