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
    time::Duration,
};
use tracing_subscriber::EnvFilter;

use vertebrae_daemon::helpers::{
    resolve_all_provider_binaries_with_diagnostics, resolve_shell_path,
};
use vertebrae_daemon::renewal::{
    CredentialStatus, RENEWAL_LEAD, ReenrollmentReason, ReenrollmentSignal, credential_status,
    reenrollment_instructions,
};
use vertebrae_daemon::{
    ConfigError, DaemonCapabilities, DaemonConfig, DaemonEnrollmentClient, DaemonEnrollmentStorage,
    DaemonIdentity, DaemonMessage, DaemonSupervisor, ProjectEntry, ResolvedConfig,
};
use vertebrae_harness::HarnessFactoryConfig;

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
        daemon_identity,
        projects,
        typesafe_api_key,
        typesafe_api_key_secret,
        typesafe_url,
        provider_profiles,
        ..
    } = match ResolvedConfig::load() {
        Ok(config) => config,
        Err(ConfigError::Retired) => {
            tracing::info!(
                "Standalone daemon identity is retired; re-enrollment is required before startup"
            );
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };

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
    let typesafe_factory_config =
        HarnessFactoryConfig::from_environment_with_typesafe_configured_settings(
            typesafe_api_key,
            typesafe_url,
        );
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
    let capabilities = Arc::new(
        DaemonCapabilities::new(
            shell_path,
            provider_binaries,
            provider_diagnostics,
            &compatibility_working_dir,
            typesafe_factory_config.typesafe_api_key,
            typesafe_factory_config.typesafe_base_url,
            typesafe_factory_config.typesafe_url,
        )
        .with_provider_profiles(provider_profiles)
        .with_typesafe_api_key_secret(typesafe_api_key_secret)
        .with_provider_config_path(vertebrae_sacrum_client::config_path()),
    );
    capabilities.log_startup_diagnostics();

    let mut identity = daemon_identity.ok_or(
        "vtb-daemon requires standalone enrollment; run `vtb-daemon enroll` before starting it",
    )?;

    let shutdown = wait_for_shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        let reason = if credential_status(&identity.expires_at, chrono::Utc::now(), RENEWAL_LEAD)
            == CredentialStatus::Expired
        {
            // An expired credential cannot be renewed: do not attempt a connection.
            ReenrollmentReason::Expired
        } else {
            let daemon_config = DaemonConfig::new(
                identity.endpoint.clone(),
                identity.clone(),
                capabilities.clone(),
            );
            let signal = daemon_config.reenrollment.clone();
            match run_supervisor(daemon_config, &projects, &signal, &mut shutdown).await? {
                SupervisorExit::Shutdown => return Ok(()),
                SupervisorExit::Stopped => signal
                    .get()
                    .ok_or("DaemonSupervisor stopped unexpectedly; see daemon diagnostics")?,
            }
        };
        if reason == ReenrollmentReason::IdentityRetired {
            // A retired identity cannot be renewed or rotated. Exit successfully
            // so the service manager does not relaunch it.
            tracing::error!(
                daemon_id = %identity.daemon_id,
                "Standalone daemon identity is retired; enroll a new daemon from the Vertebrae GUI"
            );
            return Ok(());
        }
        tracing::error!(
            daemon_id = %identity.daemon_id,
            %reason,
            "Daemon re-enrollment required; not connecting. {}",
            reenrollment_instructions(&identity.endpoint, &identity.daemon_id)
        );
        match wait_for_reenrollment(&identity, &mut shutdown).await {
            Some(reenrolled) => {
                tracing::info!(
                    daemon_id = %reenrolled.daemon_id,
                    "Daemon re-enrolled; connecting with the new credential"
                );
                identity = reenrolled;
            }
            None => return Ok(()),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SupervisorExit {
    Shutdown,
    Stopped,
}

async fn run_supervisor(
    daemon_config: DaemonConfig,
    projects: &[ProjectEntry],
    signal: &ReenrollmentSignal,
    shutdown: impl std::future::Future<Output = ()> + Unpin,
) -> Result<SupervisorExit, Box<dyn std::error::Error>> {
    let mut shutdown = shutdown;
    // Startup retries an unreachable backend, so a shutdown must interrupt it.
    let spawned = tokio::select! {
        spawned = Actor::spawn(
            Some("daemon-supervisor".to_string()),
            DaemonSupervisor,
            daemon_config,
        ) => spawned,
        () = &mut shutdown => return Ok(SupervisorExit::Shutdown),
    };
    let (actor_ref, actor_handle) = match spawned {
        Ok(spawned) => spawned,
        Err(_) if signal.get().is_some() => return Ok(SupervisorExit::Stopped),
        Err(error) => return Err(format!("Failed to start DaemonSupervisor: {error}").into()),
    };

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
            project_id: project_id.clone(),
            project_root: std::path::PathBuf::from(path),
        })?;
    }

    tracing::info!("vtb-daemon is running. Press Ctrl+C to stop.");

    supervise_until_shutdown(actor_ref, actor_handle, shutdown).await
}

async fn supervise_until_shutdown(
    actor_ref: ractor::ActorRef<DaemonMessage>,
    mut actor_handle: tokio::task::JoinHandle<()>,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<SupervisorExit, Box<dyn std::error::Error>> {
    tokio::select! {
        result = &mut actor_handle => {
            result?;
            return Ok(SupervisorExit::Stopped);
        }
        () = shutdown => {}
    }
    tracing::info!("Shutdown signal received, stopping daemon");
    actor_ref.cast(DaemonMessage::Shutdown)?;
    actor_handle.await?;
    tracing::info!("vtb-daemon stopped");
    Ok(SupervisorExit::Shutdown)
}

const REENROLLMENT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Stay running without connecting until `daemon.toml` holds a different,
/// unexpired credential for the same daemon (written by
/// `vtb-daemon enroll --replace-existing`). Returns `None` on shutdown.
async fn wait_for_reenrollment(
    rejected: &DaemonIdentity,
    shutdown: impl std::future::Future<Output = ()> + Unpin,
) -> Option<DaemonIdentity> {
    let mut shutdown = shutdown;
    let mut interval = tokio::time::interval(REENROLLMENT_POLL_INTERVAL);
    loop {
        tokio::select! {
            _ = interval.tick() => {}
            () = &mut shutdown => return None,
        }
        if let Ok(Some(candidate)) = vertebrae_daemon::load_daemon_identity()
            && is_reenrolled(rejected, &candidate)
        {
            return Some(candidate);
        }
    }
}

fn is_reenrolled(rejected: &DaemonIdentity, candidate: &DaemonIdentity) -> bool {
    candidate.daemon_id == rejected.daemon_id
        && candidate.reconnect_token != rejected.reconnect_token
        && credential_status(&candidate.expires_at, chrono::Utc::now(), RENEWAL_LEAD)
            != CredentialStatus::Expired
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
        assert_eq!(result.unwrap(), SupervisorExit::Stopped);
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

    fn identity(token: &str, expires_at: chrono::DateTime<chrono::Utc>) -> DaemonIdentity {
        DaemonIdentity {
            endpoint: "http://127.0.0.1:4000".to_string(),
            daemon_id: "33333333-3333-3333-3333-333333333333".to_string(),
            reconnect_token: token.to_string(),
            expires_at: expires_at.to_rfc3339(),
        }
    }

    #[test]
    fn reenrollment_requires_a_new_unexpired_credential_for_the_same_daemon() {
        let now = chrono::Utc::now();
        let rejected = identity("rejected-secret", now - chrono::Duration::hours(1));
        let fresh = identity("fresh-secret", now + chrono::Duration::days(30));
        assert!(is_reenrolled(&rejected, &fresh));
        assert!(!is_reenrolled(&rejected, &rejected));
        assert!(!is_reenrolled(
            &rejected,
            &identity("stale-secret", now - chrono::Duration::minutes(1))
        ));
        let other = DaemonIdentity {
            daemon_id: "44444444-4444-4444-4444-444444444444".to_string(),
            ..fresh
        };
        assert!(!is_reenrolled(&rejected, &other));
    }

    #[tokio::test]
    async fn reenrollment_wait_ends_on_shutdown() {
        let rejected = identity("rejected-secret", chrono::Utc::now());
        let waited = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            wait_for_reenrollment(&rejected, std::future::ready(())),
        )
        .await
        .unwrap();
        assert!(waited.is_none());
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
