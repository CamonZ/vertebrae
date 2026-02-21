//! vtb-daemon - Workflow execution daemon for Vertebrae.
//!
//! Connects to Sacrum via Phoenix WebSocket channels and monitors
//! registered projects for workflow execution events.
//!
//! Runs as a foreground process. Use OS service managers (systemd, launchd)
//! for background operation.

use clap::Parser;
use ractor::Actor;
use std::process;
use tracing_subscriber::EnvFilter;

use vertebrae_daemon::{
    DaemonConfig, DaemonMessage, DaemonSupervisor, ResolvedConfig, load_config_file,
};

/// vtb-daemon - Vertebrae workflow execution daemon
#[derive(Parser, Debug)]
#[command(name = "vtb-daemon")]
#[command(version = "0.1.0")]
#[command(about = "Vertebrae workflow execution daemon")]
struct Args {
    /// Sacrum API base URL (overrides config file)
    #[arg(long, env = "SACRUM_URL")]
    sacrum_url: Option<String>,

    /// Sacrum API token (overrides config file and SACRUM_API_TOKEN env var)
    #[arg(long)]
    api_token: Option<String>,

    /// Project IDs to monitor (can be specified multiple times, overrides config file)
    #[arg(long = "project", short = 'p')]
    project_ids: Vec<String>,
}

/// Initialize structured logging using tracing-subscriber.
///
/// Log level is controlled by the RUST_LOG env var (default: info).
fn init_logging() {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .with_level(true)
        .init();
}

#[tokio::main]
async fn main() {
    init_logging();

    if let Err(e) = run().await {
        eprintln!("error: {e}");
        process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Load config file (optional — returns defaults if missing)
    let file_config = load_config_file()?;

    // Resolve final configuration by merging file, env vars, and CLI args
    let config = ResolvedConfig::resolve(
        &file_config,
        args.sacrum_url.as_deref(),
        args.api_token.as_deref(),
        &args.project_ids,
    )?;

    tracing::info!(
        sacrum_url = %config.sacrum_url,
        project_count = config.project_ids.len(),
        "Starting vtb-daemon"
    );

    // Spawn the DaemonSupervisor actor
    let daemon_config = DaemonConfig {
        base_url: config.sacrum_url.clone(),
        api_token: config.api_token.clone(),
    };

    let (actor_ref, actor_handle) = Actor::spawn(
        Some("daemon-supervisor".to_string()),
        DaemonSupervisor,
        daemon_config,
    )
    .await
    .map_err(|e| format!("Failed to start DaemonSupervisor: {e}"))?;

    // Register each configured project
    for project_id in &config.project_ids {
        tracing::info!(project_id = %project_id, "Registering project");
        actor_ref.cast(DaemonMessage::AddProject {
            project_id: project_id.clone(),
        })?;
    }

    tracing::info!("vtb-daemon is running. Press Ctrl+C to stop.");

    // Wait for SIGTERM or SIGINT
    wait_for_shutdown_signal().await;

    tracing::info!("Shutdown signal received, stopping daemon");

    // Send shutdown message and wait for the actor to stop
    actor_ref.cast(DaemonMessage::Shutdown)?;
    actor_handle.await?;

    tracing::info!("vtb-daemon stopped");
    Ok(())
}

/// Wait for either SIGTERM or SIGINT (Ctrl+C).
///
/// On Unix, listens for both signals. On other platforms, only Ctrl+C.
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm =
            signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
        let mut sigint = signal(SignalKind::interrupt()).expect("failed to install SIGINT handler");

        tokio::select! {
            _ = sigterm.recv() => {
                tracing::info!("Received SIGTERM");
            }
            _ = sigint.recv() => {
                tracing::info!("Received SIGINT");
            }
        }
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
        tracing::info!("Received Ctrl+C");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== CLI argument parsing tests =====

    #[test]
    fn parse_no_args() {
        let args = Args::try_parse_from(["vtb-daemon"]).unwrap();
        assert!(args.sacrum_url.is_none());
        assert!(args.api_token.is_none());
        assert!(args.project_ids.is_empty());
    }

    #[test]
    fn parse_sacrum_url() {
        let args =
            Args::try_parse_from(["vtb-daemon", "--sacrum-url", "http://custom:5000"]).unwrap();
        assert_eq!(args.sacrum_url.as_deref(), Some("http://custom:5000"));
    }

    #[test]
    fn parse_api_token() {
        let args = Args::try_parse_from(["vtb-daemon", "--api-token", "my-secret-token"]).unwrap();
        assert_eq!(args.api_token.as_deref(), Some("my-secret-token"));
    }

    #[test]
    fn parse_single_project() {
        let args =
            Args::try_parse_from(["vtb-daemon", "--project", "proj-1", "--api-token", "tok"])
                .unwrap();
        assert_eq!(args.project_ids, vec!["proj-1"]);
    }

    #[test]
    fn parse_multiple_projects() {
        let args = Args::try_parse_from([
            "vtb-daemon",
            "-p",
            "proj-1",
            "-p",
            "proj-2",
            "-p",
            "proj-3",
            "--api-token",
            "tok",
        ])
        .unwrap();
        assert_eq!(args.project_ids, vec!["proj-1", "proj-2", "proj-3"]);
    }

    #[test]
    fn parse_all_args() {
        let args = Args::try_parse_from([
            "vtb-daemon",
            "--sacrum-url",
            "https://sacrum.example.com",
            "--api-token",
            "secret",
            "-p",
            "proj-a",
            "-p",
            "proj-b",
        ])
        .unwrap();

        assert_eq!(
            args.sacrum_url.as_deref(),
            Some("https://sacrum.example.com")
        );
        assert_eq!(args.api_token.as_deref(), Some("secret"));
        assert_eq!(args.project_ids, vec!["proj-a", "proj-b"]);
    }

    #[test]
    fn parse_help_flag() {
        let result = Args::try_parse_from(["vtb-daemon", "--help"]);
        // --help causes a special error (not a real error, but clap exits)
        assert!(result.is_err());
    }

    #[test]
    fn parse_version_flag() {
        let result = Args::try_parse_from(["vtb-daemon", "--version"]);
        assert!(result.is_err());
    }

    #[test]
    fn parse_short_project_flag() {
        let args =
            Args::try_parse_from(["vtb-daemon", "-p", "my-project", "--api-token", "tok"]).unwrap();
        assert_eq!(args.project_ids, vec!["my-project"]);
    }

    #[test]
    fn parse_unknown_arg_fails() {
        let result = Args::try_parse_from(["vtb-daemon", "--unknown-flag"]);
        assert!(result.is_err());
    }
}
