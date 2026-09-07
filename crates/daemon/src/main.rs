//! vtb-daemon - Workflow execution daemon for Vertebrae.
//!
//! Connects to Sacrum via Phoenix WebSocket channels and monitors
//! registered projects for workflow execution events.
//!
//! Runs as a foreground process. Use OS service managers (systemd, launchd)
//! for background operation.

use clap::{Parser, Subcommand};
use ractor::Actor;
use std::{
    io::{IsTerminal, Read},
    path::PathBuf,
    process,
    sync::Arc,
};
use tracing_subscriber::EnvFilter;

use vertebrae_daemon::helpers::{
    resolve_all_provider_binaries_with_diagnostics, resolve_shell_path,
};
use vertebrae_daemon::{
    DaemonAuthentication, DaemonCapabilities, DaemonConfig, DaemonEnrollmentClient,
    DaemonEnrollmentStorage, DaemonIdentity, DaemonMessage, DaemonSupervisor, ProjectEntry,
    ResolvedConfig,
};

#[derive(Debug, Parser)]
#[command(name = "vtb-daemon", about = "Vertebrae workflow execution daemon")]
struct DaemonCli {
    #[command(subcommand)]
    command: Option<DaemonCommand>,
}

#[derive(Debug, Subcommand)]
enum DaemonCommand {
    Enroll(EnrollArgs),
}

#[derive(Debug, clap::Args)]
struct EnrollArgs {
    #[arg(long)]
    endpoint: String,
    #[arg(long)]
    daemon_id: String,
    /// Read the bootstrap credential from a pipe or redirected file, never a terminal.
    #[arg(long, required = true)]
    token_stdin: bool,
    #[arg(long)]
    replace_existing: bool,
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
    let cli = DaemonCli::parse();
    if let Some(DaemonCommand::Enroll(args)) = cli.command {
        return enroll(args).await;
    }

    let ResolvedConfig {
        sacrum_url,
        api_token,
        daemon_identity,
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
    let (provider_binaries, provider_diagnostics) =
        resolve_all_provider_binaries_with_diagnostics(&shell_path);
    tracing::info!(
        anthropic_binary = ?provider_binaries.anthropic,
        openai_binary = ?provider_binaries.openai,
        "Resolved provider CLI binaries"
    );

    let compatibility_working_dir = projects
        .first()
        .map(|project| PathBuf::from(&project.path))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let capabilities = Arc::new(DaemonCapabilities::new(
        shell_path,
        provider_binaries,
        provider_diagnostics,
        &compatibility_working_dir,
    ));
    capabilities.log_startup_diagnostics();

    let authentication = match daemon_identity {
        Some(identity) => DaemonAuthentication::Standalone(identity),
        None => DaemonAuthentication::AccountToken(
            api_token
                .ok_or("account authentication disappeared while resolving daemon configuration")?,
        ),
    };
    let standalone = matches!(authentication, DaemonAuthentication::Standalone(_));

    let daemon_config = DaemonConfig {
        base_url: sacrum_url,
        authentication,
        capabilities,
    };

    let (actor_ref, actor_handle) = Actor::spawn(
        Some("daemon-supervisor".to_string()),
        DaemonSupervisor,
        daemon_config,
    )
    .await
    .map_err(|e| format!("Failed to start DaemonSupervisor: {e}"))?;

    if standalone {
        if !projects.is_empty() {
            tracing::warn!(
                project_count = projects.len(),
                "Standalone daemon identity is authenticated, but Sacrum does not yet authorize project execution for daemon principals; preserving projects without opening an unauthorized account channel"
            );
        }
    } else {
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
    }

    tracing::info!("vtb-daemon is running. Press Ctrl+C to stop.");

    supervise_until_shutdown(actor_ref, actor_handle, wait_for_shutdown_signal()).await
}

async fn supervise_until_shutdown(
    actor_ref: ractor::ActorRef<DaemonMessage>,
    mut actor_handle: tokio::task::JoinHandle<()>,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<(), Box<dyn std::error::Error>> {
    tokio::select! {
        result = &mut actor_handle => {
            result?;
            return Err("DaemonSupervisor stopped unexpectedly; see daemon diagnostics".into());
        }
        () = shutdown => {}
    }
    tracing::info!("Shutdown signal received, stopping daemon");
    actor_ref.cast(DaemonMessage::Shutdown)?;
    actor_handle.await?;
    tracing::info!("vtb-daemon stopped");
    Ok(())
}

async fn enroll(args: EnrollArgs) -> Result<(), Box<dyn std::error::Error>> {
    vertebrae_daemon::enrollment::validate_daemon_id(&args.daemon_id)?;
    if std::io::stdin().is_terminal() {
        return Err(
            "bootstrap credentials must be piped or redirected through --token-stdin".into(),
        );
    }
    let mut token = String::new();
    std::io::stdin().take(515).read_to_string(&mut token)?;
    if token.len() > 514 {
        return Err("bootstrap credential exceeds the input limit".into());
    }
    let token = token.trim();
    if token.len() > 512 {
        return Err("bootstrap credential exceeds the input limit".into());
    }
    if token.is_empty() {
        return Err(vertebrae_daemon::EnrollmentError::EmptyToken.into());
    }

    let storage = DaemonEnrollmentStorage::begin(&args.daemon_id, args.replace_existing)?;
    let result = DaemonEnrollmentClient::new()?
        .exchange(&args.endpoint, &args.daemon_id, token)
        .await?;
    let identity = DaemonIdentity {
        endpoint: args.endpoint,
        daemon_id: result.daemon_id,
        reconnect_token: result.reconnect_token,
        expires_at: result.expires_at,
    };
    storage.save(&identity)?;
    println!(
        "Enrolled daemon {}. Reconnect credentials were stored in the protected daemon configuration.",
        identity.daemon_id
    );
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
    use ractor::{ActorProcessingErr, ActorRef};

    struct TestSupervisor;
    impl Actor for TestSupervisor {
        type Msg = DaemonMessage;
        type State = ();
        type Arguments = ();

        async fn pre_start(&self, _: ActorRef<Self::Msg>, _: ()) -> Result<(), ActorProcessingErr> {
            Ok(())
        }

        async fn handle(
            &self,
            myself: ActorRef<Self::Msg>,
            message: Self::Msg,
            _: &mut (),
        ) -> Result<(), ActorProcessingErr> {
            if matches!(message, DaemonMessage::Shutdown) {
                myself.stop(None);
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn supervisor_termination_is_reported_without_an_os_signal() {
        let (actor, handle) = Actor::spawn(None, TestSupervisor, ()).await.unwrap();
        actor.stop(Some("authentication rejected".to_string()));
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            supervise_until_shutdown(actor, handle, std::future::pending()),
        )
        .await
        .unwrap();
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("stopped unexpectedly")
        );
    }

    #[tokio::test]
    async fn requested_shutdown_waits_for_the_supervisor_and_succeeds() {
        let (actor, handle) = Actor::spawn(None, TestSupervisor, ()).await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            supervise_until_shutdown(actor, handle, std::future::ready(())),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[test]
    fn enrollment_requires_explicit_stdin_input() {
        let args = [
            "vtb-daemon",
            "enroll",
            "--endpoint",
            "http://localhost:4000",
            "--daemon-id",
            "33333333-3333-3333-3333-333333333333",
        ];
        assert!(DaemonCli::try_parse_from(args).is_err());
        assert!(DaemonCli::try_parse_from(args.into_iter().chain(["--token-stdin"])).is_ok());
    }
}
