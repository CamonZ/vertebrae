//! vtb-daemon - Workflow execution daemon for Vertebrae.
//!
//! Connects to Sacrum via Phoenix WebSocket channels and monitors
//! registered projects for workflow execution events.
//!
//! Configuration is loaded from `~/.config/vertebrae/config.toml` — the same
//! config file used by the CLI and GUI.
//!
//! Runs as a foreground process. Use OS service managers (systemd, launchd)
//! for background operation.

use ractor::Actor;
use std::process;
use tracing_subscriber::EnvFilter;

use vertebrae_daemon::{DaemonConfig, DaemonMessage, DaemonSupervisor, ResolvedConfig};

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
    let config = ResolvedConfig::load()?;

    tracing::info!(
        sacrum_url = %config.sacrum_url,
        project_count = config.projects.len(),
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
    for project in &config.projects {
        tracing::info!(
            project_id = %project.project_id,
            slug = %project.slug,
            path = %project.path,
            "Registering project"
        );
        actor_ref.cast(DaemonMessage::AddProject {
            project_id: project.project_id.clone(),
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
