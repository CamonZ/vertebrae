use std::{path::PathBuf, time::Duration};

use super::command::{discover_docker_cli, SystemProcessRunner};
use super::state::{DockerTarget, LocalBackendError};

mod health;
mod legacy;
mod lifecycle;
mod transport;

#[allow(unused_imports)]
pub use health::HealthProbe;
pub use health::ReqwestHealthProbe;
pub type LegacyStackCandidate = legacy::LegacyStackCandidate;
pub type LegacyStackDetection = legacy::LegacyStackDetection;
pub type ServiceStatus = lifecycle::ServiceStatus;

use health::{HEALTH_POLL_INTERVAL, HEALTH_TIMEOUT};
use lifecycle::RECONCILE_TIMEOUT;
use transport::QUICK_COMMAND_TIMEOUT;

pub struct DockerCompose<R, H> {
    runner: R,
    health_probe: H,
    docker_cli: PathBuf,
    target: DockerTarget,
    quick_timeout: Duration,
    reconcile_timeout: Duration,
    health_timeout: Duration,
    health_poll_interval: Duration,
}

impl<R, H> DockerCompose<R, H> {
    pub fn new(runner: R, health_probe: H, docker_cli: PathBuf, target: DockerTarget) -> Self {
        Self {
            runner,
            health_probe,
            docker_cli,
            target,
            quick_timeout: QUICK_COMMAND_TIMEOUT,
            reconcile_timeout: RECONCILE_TIMEOUT,
            health_timeout: HEALTH_TIMEOUT,
            health_poll_interval: HEALTH_POLL_INTERVAL,
        }
    }

    pub fn with_timeouts(
        mut self,
        quick_timeout: Duration,
        reconcile_timeout: Duration,
        health_timeout: Duration,
        health_poll_interval: Duration,
    ) -> Self {
        self.quick_timeout = quick_timeout;
        self.reconcile_timeout = reconcile_timeout;
        self.health_timeout = health_timeout;
        self.health_poll_interval = health_poll_interval;
        self
    }

    pub fn target(&self) -> &DockerTarget {
        &self.target
    }
}

impl DockerCompose<SystemProcessRunner, ReqwestHealthProbe> {
    pub async fn system() -> Result<Self, LocalBackendError> {
        Self::connect(
            SystemProcessRunner,
            ReqwestHealthProbe::default(),
            discover_docker_cli()?,
        )
        .await
    }

    pub fn system_for(target: DockerTarget) -> Result<Self, LocalBackendError> {
        target.validate()?;
        Ok(Self::new(
            SystemProcessRunner,
            ReqwestHealthProbe::default(),
            discover_docker_cli()?,
            target,
        ))
    }
}

#[cfg(test)]
pub(super) mod test_support;

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::super::state::{
        is_valid_backend_image_ref, select_host_port, ApiToken, BackendImageChannel,
        LocalBackendError, ManagedStackPaths, ManagedStackState, ProvisioningState, RuntimeSecrets,
        SeedAccount, StackKind, LOCAL_SACRUM_IMAGE_REF,
    };
    use super::test_support::*;
    use super::*;

    const SMOKE_TIMEOUT: Duration = Duration::from_secs(180);

    fn smoke_image_ref() -> String {
        let image_ref = std::env::var("VERTEBRAE_TEST_SACRUM_IMAGE_REF")
            .unwrap_or_else(|_| LOCAL_SACRUM_IMAGE_REF.to_string());
        assert!(
            is_valid_backend_image_ref(&image_ref),
            "VERTEBRAE_TEST_SACRUM_IMAGE_REF must be an official digest-pinned image"
        );
        image_ref
    }

    async fn smoke_controller(
        target: Option<DockerTarget>,
    ) -> DockerCompose<SystemProcessRunner, ReqwestHealthProbe> {
        let controller = match target {
            Some(target) => DockerCompose::system_for(target).expect("connect to local Docker"),
            None => DockerCompose::system()
                .await
                .expect("connect to local Docker"),
        };
        controller.with_timeouts(
            SMOKE_TIMEOUT,
            SMOKE_TIMEOUT,
            SMOKE_TIMEOUT,
            Duration::from_secs(2),
        )
    }

    async fn graphql_projects(
        state: &ManagedStackState,
        api_token: &ApiToken,
    ) -> Result<serde_json::Value, LocalBackendError> {
        let response = reqwest::Client::new()
            .post(format!("{}/graphql", state.backend_url()))
            .bearer_auth(api_token.as_str())
            .json(&serde_json::json!({
                "query": "query SmokeProjects { projects { id } }"
            }))
            .send()
            .await
            .map_err(|error| {
                LocalBackendError::InvalidState(format!("GraphQL smoke request failed: {error}"))
            })?;
        let status = response.status();
        let body = response
            .json::<serde_json::Value>()
            .await
            .map_err(|error| {
                LocalBackendError::InvalidState(format!(
                    "GraphQL smoke response was invalid: {error}"
                ))
            })?;
        if !status.is_success() || body.get("errors").is_some() {
            return Err(LocalBackendError::InvalidState(format!(
                "GraphQL smoke request returned HTTP {status}: {body}"
            )));
        }
        Ok(body)
    }

    async fn raw_stack_logs(
        controller: &DockerCompose<SystemProcessRunner, ReqwestHealthProbe>,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<String, LocalBackendError> {
        let output = controller
            .checked(controller.compose_request(
                paths,
                state,
                "capture local backend logs",
                ["logs", "--no-color", "--tail", "200", "postgres", "sacrum"],
                Duration::from_secs(30),
            ))
            .await?;
        Ok(output.summary())
    }

    async fn cleanup_managed_stack(
        controller: &DockerCompose<SystemProcessRunner, ReqwestHealthProbe>,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) {
        let request = controller.compose_request(
            paths,
            state,
            "remove smoke-test stack",
            ["down", "--volumes", "--remove-orphans"],
            Duration::from_secs(60),
        );
        let _ = controller.checked(request).await;
    }

    fn run_legacy_script(
        command: &str,
        image_ref: &str,
        host_port: u16,
        account: &SeedAccount,
        api_token: &ApiToken,
    ) -> std::process::Output {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        Command::new(repo_root.join("scripts/dev-backend.sh"))
            .arg(command)
            .current_dir(&repo_root)
            .env("SACRUM_IMAGE_REF", image_ref)
            .env("SACRUM_HOST_PORT", host_port.to_string())
            .env("SEED_EMAIL", account.email())
            .env("SEED_USERNAME", account.username())
            .env("SEED_PASSWORD", account.password())
            .env("SEED_TOKEN", api_token.as_str())
            .output()
            .expect("run scripts/dev-backend.sh")
    }

    #[tokio::test]
    #[ignore = "requires Docker and an official GHCR image; set VERTEBRAE_TEST_SACRUM_UPDATE_IMAGE_REF for update coverage"]
    async fn docker_smoke_fresh_stack_covers_provisioning_persistence_and_updates() {
        let image_ref = smoke_image_ref();
        let update_image_ref = std::env::var("VERTEBRAE_TEST_SACRUM_UPDATE_IMAGE_REF").expect(
            "set VERTEBRAE_TEST_SACRUM_UPDATE_IMAGE_REF to a second official digest-pinned image",
        );
        assert!(
            is_valid_backend_image_ref(&update_image_ref),
            "VERTEBRAE_TEST_SACRUM_UPDATE_IMAGE_REF must be an official digest-pinned image"
        );
        assert_ne!(image_ref, update_image_ref);

        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let first_controller = smoke_controller(None).await;
        let mut state = ManagedStackState::fresh(
            image_ref.clone(),
            select_host_port(0).expect("select host port"),
            BackendImageChannel::BackendRelease,
            first_controller.target().clone(),
        )
        .expect("valid managed state");
        let postgres_volume = state.postgres_volume();
        paths.install_assets().expect("install assets");
        let proposed_secrets = RuntimeSecrets::generate().expect("generate secrets");
        let persisted_secrets = paths
            .ensure_runtime_secrets(&proposed_secrets, state.kind)
            .expect("persist runtime secrets");
        assert_ne!(persisted_secrets, RuntimeSecrets::legacy_development());
        let account = SeedAccount::generated_for_installation(state.installation_id)
            .expect("generate local account");
        let proposed_token = ApiToken::generate().expect("generate local API token");
        let api_token = paths
            .ensure_api_token(&proposed_token)
            .expect("persist local API token");

        let outcome = async {
            let first_status = first_controller
                .start_and_wait_until_healthy(&paths, &mut state)
                .await?;
            let secrets = paths.load_runtime_secrets(state.kind)?;
            first_controller
                .run_seeder(&paths, &state, &account, &api_token)
                .await?;
            state.provisioning_state = ProvisioningState::Ready;
            paths.save_state(&state)?;

            let settings = postgres_exec(
                &first_controller,
                &paths,
                &state,
                &secrets,
                "verify PostgreSQL logical replication",
                &[
                    "-tAc",
                    "SELECT current_setting('server_version_num')::int >= 180000 || current_setting('server_version') LIKE '18.%'; SELECT current_setting('wal_level') || ' ' || current_setting('max_replication_slots') || ' ' || current_setting('max_wal_senders');",
                ],
            )
            .await?;
            let mut settings_lines = settings.stdout.lines();
            assert_eq!(settings_lines.next().unwrap_or_default().trim(), "t");
            assert_eq!(settings_lines.next().unwrap_or_default().trim(), "logical 10 10");

            let users = postgres_exec(
                &first_controller,
                &paths,
                &state,
                &secrets,
                "verify Sacrum migrations and seed",
                &[
                    "-tAc",
                    &format!(
                        "SELECT count(*) FROM users WHERE email = '{}';",
                        account.email()
                    ),
                ],
            )
            .await?;
            assert_eq!(users.stdout.trim(), "1");
            let authenticated = graphql_projects(&state, &api_token).await?;
            assert!(authenticated["data"]["projects"].is_array());

            let logs = raw_stack_logs(&first_controller, &paths, &state).await?;
            assert!(!logs.contains(secrets.postgres_password()));
            assert!(!logs.contains(secrets.secret_key_base()));
            assert!(!logs.contains(account.password()));
            assert!(!logs.contains(api_token.as_str()));

            postgres_exec(
                &first_controller,
                &paths,
                &state,
                &secrets,
                "write smoke-test sentinel",
                &[
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-c",
                    "CREATE TABLE IF NOT EXISTS vertebrae_smoke_sentinel (value text PRIMARY KEY); INSERT INTO vertebrae_smoke_sentinel VALUES ('survived') ON CONFLICT DO NOTHING;",
                ],
            )
            .await?;

            let second_controller = smoke_controller(Some(state.docker_target.clone())).await;
            second_controller.up_detached(&paths, &mut state).await?;
            second_controller.wait_until_healthy(&paths, &state).await?;
            let second_status = second_controller.status(&paths, &state).await?;
            let reused_token = paths.load_api_token()?;
            let reused_secrets = paths.load_runtime_secrets(state.kind)?;
            let sentinel = postgres_exec(
                &second_controller,
                &paths,
                &state,
                &secrets,
                "read smoke-test sentinel",
                &[
                    "-tAc",
                    "SELECT value FROM vertebrae_smoke_sentinel WHERE value = 'survived';",
                ],
            )
                .await?;
            assert_eq!(reused_token, api_token);
            assert_eq!(reused_secrets, secrets);
            let authenticated_after_restart = graphql_projects(&state, &reused_token).await?;
            assert!(authenticated_after_restart["data"]["projects"].is_array());

            let updated_status = second_controller
                .update_sacrum_image(
                    &paths,
                    &state,
                    &update_image_ref,
                    Some("smoke-update"),
                    Some("smoke-update"),
                    None,
                )
                .await?;
            assert!(updated_status.iter().any(|service| {
                service.service == "sacrum"
                    && service.state == "running"
                    && service.health.as_deref() == Some("healthy")
            }));
            let updated_state = paths.load_state()?.expect("updated state");
            assert_eq!(updated_state.sacrum_image_ref, update_image_ref);
            assert_eq!(paths.load_api_token()?, api_token);
            assert_eq!(paths.load_runtime_secrets(updated_state.kind)?, secrets);
            let sentinel_after_update = postgres_exec(
                &second_controller,
                &paths,
                &updated_state,
                &secrets,
                "verify database after image update",
                &[
                    "-tAc",
                    "SELECT value FROM vertebrae_smoke_sentinel WHERE value = 'survived';",
                ],
            )
            .await?;
            let volume = second_controller
                .checked(second_controller.docker_request(
                    "inspect smoke-test volume",
                    ["volume", "inspect", postgres_volume.as_str()],
                    Duration::from_secs(30),
                ))
                .await?;
            Ok::<_, LocalBackendError>((
                first_status,
                second_status,
                sentinel.stdout,
                sentinel_after_update.stdout,
                volume.success,
            ))
        }
        .await;

        let cleanup_state = paths.load_state().ok().flatten().unwrap_or(state.clone());
        cleanup_managed_stack(
            &smoke_controller(Some(cleanup_state.docker_target.clone())).await,
            &paths,
            &cleanup_state,
        )
        .await;

        let (first_status, second_status, sentinel, sentinel_after_update, volume_exists) =
            outcome.expect("run Docker smoke test");
        let mut first_names: Vec<_> = first_status
            .iter()
            .filter(|service| matches!(service.service.as_str(), "postgres" | "sacrum"))
            .map(|service| service.name.clone())
            .collect();
        let mut second_names: Vec<_> = second_status
            .iter()
            .filter(|service| matches!(service.service.as_str(), "postgres" | "sacrum"))
            .map(|service| service.name.clone())
            .collect();
        first_names.sort();
        second_names.sort();
        assert_eq!(first_names.len(), 2);
        assert_eq!(first_names, second_names);
        assert!(second_status.iter().all(|service| {
            service.state == "running" && service.health.as_deref() == Some("healthy")
        }));
        assert_eq!(sentinel.trim(), "survived");
        assert_eq!(sentinel_after_update.trim(), "survived");
        assert!(volume_exists);
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires Docker, an official GHCR image, and VERTEBRAE_TEST_ALLOW_LEGACY_STACK=1"]
    async fn docker_smoke_adopts_dev_backend_without_reseeding_or_replacing_v17_volume() {
        if std::env::var("VERTEBRAE_TEST_ALLOW_LEGACY_STACK").as_deref() != Ok("1") {
            eprintln!(
                "skipping legacy-stack smoke test; set VERTEBRAE_TEST_ALLOW_LEGACY_STACK=1 explicitly"
            );
            return;
        }

        let image_ref = smoke_image_ref();
        let controller = smoke_controller(None).await;
        match controller
            .detect_legacy_stack()
            .await
            .expect("inspect existing legacy stack")
        {
            LegacyStackDetection::Absent => {}
            detection => panic!(
                "refusing to modify an existing vertebrae-dev stack or volume: {detection:?}"
            ),
        }

        let host_port = select_host_port(0).expect("select host port");
        let account = SeedAccount::new(
            "smoke-adoption@example.test",
            "smoke_adoption",
            "smoke-adoption-password",
        )
        .expect("valid legacy smoke account");
        let api_token = ApiToken::generate().expect("generate legacy smoke token");
        let started = run_legacy_script("up", &image_ref, host_port, &account, &api_token);
        if !started.status.success() {
            let cleanup = run_legacy_script("destroy", &image_ref, host_port, &account, &api_token);
            panic!(
                "legacy backend failed to start (cleanup status {}): {}",
                cleanup.status,
                String::from_utf8_lossy(&started.stderr)
            );
        }
        let seeded = run_legacy_script("seed", &image_ref, host_port, &account, &api_token);
        if !seeded.status.success() {
            let cleanup = run_legacy_script("destroy", &image_ref, host_port, &account, &api_token);
            panic!(
                "legacy backend failed to seed (cleanup status {}): {}",
                cleanup.status,
                String::from_utf8_lossy(&seeded.stderr)
            );
        }
        assert!(!String::from_utf8_lossy(&seeded.stdout).contains(api_token.as_str()));
        assert!(!String::from_utf8_lossy(&seeded.stdout).contains(account.password()));
        assert!(!String::from_utf8_lossy(&seeded.stderr).contains(api_token.as_str()));
        assert!(!String::from_utf8_lossy(&seeded.stderr).contains(account.password()));

        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let outcome = async {
            let detection = match controller.detect_legacy_stack().await? {
                LegacyStackDetection::Compatible(candidate) => candidate,
                _ => {
                    return Err(LocalBackendError::UnsafeLegacyStack(
                        "legacy smoke stack was not detected as compatible".to_string(),
                    ));
                }
            };
            let mut state = controller
                .adopt_legacy_stack(
                    &paths,
                    &LegacyStackDetection::Compatible(detection),
                    BackendImageChannel::BackendMaster,
                    true,
                )
                .await?;
            assert_eq!(state.kind, StackKind::AdoptedLegacy);
            assert_eq!(state.postgres_image_ref(), "postgres:17-alpine");
            assert_eq!(state.postgres_volume(), "vertebrae-dev_pgdata");
            let saved_token = paths.ensure_api_token(&api_token)?;
            assert_eq!(saved_token, api_token);
            controller.up_adopted(&paths, &mut state).await?;
            controller.wait_until_healthy(&paths, &state).await?;
            let status = controller.status(&paths, &state).await?;
            controller.authenticate_backend(&state, &api_token).await?;
            let settings = postgres_exec(
                &controller,
                &paths,
                &state,
                &RuntimeSecrets::legacy_development(),
                "verify adopted PostgreSQL contract",
                &[
                    "-tAc",
                    "SELECT current_setting('server_version') LIKE '17.%'; SELECT current_setting('wal_level') || ' ' || current_setting('max_replication_slots') || ' ' || current_setting('max_wal_senders');",
                ],
            )
            .await?;
            let mut settings_lines = settings.stdout.lines();
            assert_eq!(settings_lines.next().unwrap_or_default().trim(), "t");
            assert_eq!(settings_lines.next().unwrap_or_default().trim(), "logical 10 10");
            let authenticated = graphql_projects(&state, &api_token).await?;
            assert!(authenticated["data"]["projects"].is_array());
            Ok::<_, LocalBackendError>(status)
        }
        .await;

        let cleanup = run_legacy_script("destroy", &image_ref, host_port, &account, &api_token);
        assert!(
            cleanup.status.success(),
            "legacy backend cleanup failed: {}",
            String::from_utf8_lossy(&cleanup.stderr)
        );
        let status = outcome.expect("run legacy adoption smoke test");
        assert!(status.iter().all(|service| {
            matches!(service.service.as_str(), "postgres" | "sacrum")
                && service.state == "running"
                && service.health.as_deref() == Some("healthy")
        }));
    }
}
