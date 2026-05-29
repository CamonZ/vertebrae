use clap::Parser;

use crate::commands::Command;

/// Vertebrae - A task management CLI tool
#[derive(Parser)]
#[command(name = "vtb")]
#[command(version = "0.1.0")]
#[command(about = "A task management CLI tool", long_about = None)]
pub struct CliArgs {
    /// Output machine-readable JSON instead of human-readable text
    #[arg(long, global = true)]
    pub json: bool,

    /// Subcommand to execute
    #[command(subcommand)]
    pub command: Option<Command>,
}
