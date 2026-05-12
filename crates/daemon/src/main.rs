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

use vertebrae_daemon::helpers::{resolve_all_provider_binaries, resolve_shell_path};
use vertebrae_daemon::{
    DaemonConfig, DaemonMessage, DaemonSupervisor, ProjectEntry, ResolvedConfig,
};

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
    let ResolvedConfig {
        sacrum_url,
        api_token,
        projects,
    } = ResolvedConfig::load()?;

    tracing::info!(
        sacrum_url = %sacrum_url,
        project_count = projects.len(),
        "Starting vtb-daemon"
    );

    let shell_path = resolve_shell_path();
    tracing::info!(shell_path = %shell_path, "Resolved user shell PATH");

    // Best-effort: resolve binaries for every known provider so each step
    // can pick the right one. A missing binary only fails the steps that
    // request that provider; the daemon stays up for the others.
    let provider_binaries = resolve_all_provider_binaries(&shell_path);
    tracing::info!(
        anthropic_binary = ?provider_binaries.anthropic,
        openai_binary = ?provider_binaries.openai,
        "Resolved provider CLI binaries"
    );

    let daemon_config = DaemonConfig {
        base_url: sacrum_url,
        api_token,
        provider_binaries,
        shell_path,
    };

    let (actor_ref, actor_handle) = Actor::spawn(
        Some("daemon-supervisor".to_string()),
        DaemonSupervisor,
        daemon_config,
    )
    .await
    .map_err(|e| format!("Failed to start DaemonSupervisor: {e}"))?;

    for ProjectEntry {
        slug,
        project_id,
        path,
    } in projects
    {
        tracing::info!(
            project_id = %project_id,
            slug = %slug,
            path = %path,
            "Registering project"
        );
        actor_ref.cast(DaemonMessage::AddProject {
            project_id,
            project_root: std::path::PathBuf::from(path),
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
