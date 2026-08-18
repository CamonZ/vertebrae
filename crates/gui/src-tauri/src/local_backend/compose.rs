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
mod test_support;

#[cfg(test)]
mod tests {
    use super::super::state::{
        select_host_port, BackendImageChannel, LocalBackendError, ManagedStackPaths,
        ManagedStackState, RuntimeSecrets,
    };
    use super::test_support::*;
    use super::*;

    #[tokio::test]
    #[ignore = "requires Docker and VERTEBRAE_TEST_SACRUM_IMAGE_REF"]
    async fn docker_smoke_stack_survives_controller_recreation_and_reuses_volume() {
        let image_ref = std::env::var("VERTEBRAE_TEST_SACRUM_IMAGE_REF")
            .expect("set VERTEBRAE_TEST_SACRUM_IMAGE_REF to an official digest-pinned image");
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let first_controller = DockerCompose::system()
            .await
            .expect("connect to local Docker")
            .with_timeouts(
                Duration::from_secs(180),
                Duration::from_secs(180),
                Duration::from_secs(180),
                Duration::from_secs(2),
            );
        let mut state = ManagedStackState::fresh(
            image_ref,
            select_host_port(0).expect("select host port"),
            BackendImageChannel::BackendRelease,
            first_controller.target().clone(),
        )
        .expect("valid managed state");
        let postgres_volume = state.postgres_volume();
        paths.install_assets().expect("install assets");
        paths
            .ensure_runtime_secrets(
                &RuntimeSecrets::generate().expect("generate secrets"),
                state.kind,
            )
            .expect("persist runtime secrets");

        let outcome = async {
            first_controller.up_detached(&paths, &mut state).await?;
            first_controller.wait_until_healthy(&paths, &state).await?;
            let first_status = first_controller.status(&paths, &state).await?;
            let secrets = paths.load_runtime_secrets(state.kind)?;
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

            let second_controller = DockerCompose::system_for(state.docker_target.clone())?
                .with_timeouts(
                    Duration::from_secs(180),
                    Duration::from_secs(180),
                    Duration::from_secs(180),
                    Duration::from_secs(2),
                );
            second_controller.up_detached(&paths, &mut state).await?;
            second_controller.wait_until_healthy(&paths, &state).await?;
            let second_status = second_controller.status(&paths, &state).await?;
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
                volume.success,
            ))
        }
        .await;

        if let Ok(cleanup) = DockerCompose::system_for(state.docker_target.clone()) {
            let request = cleanup.compose_request(
                &paths,
                &state,
                "remove smoke-test stack",
                ["down", "--volumes", "--remove-orphans"],
                Duration::from_secs(60),
            );
            let _ = cleanup.checked(request).await;
        }

        let (first_status, second_status, sentinel, volume_exists) =
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
        assert!(volume_exists);
    }
}
