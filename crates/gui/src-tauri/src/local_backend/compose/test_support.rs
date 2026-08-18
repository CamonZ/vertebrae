use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use super::{DockerCompose, HealthProbe, LegacyStackDetection, ReqwestHealthProbe};
use crate::local_backend::command::{
    CommandOutput, CommandRequest, ProcessRunner, SystemProcessRunner,
};
use crate::local_backend::state::{
    BackendImageChannel, DockerTarget, LocalBackendError, ManagedStackPaths, ManagedStackState,
    RuntimeSecrets, StackKind,
};

pub(crate) const DIGEST_IMAGE: &str =
    "ghcr.io/camonz/sacrum@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[derive(Clone, Default)]
pub(crate) struct MockRunner {
    requests: Arc<Mutex<Vec<CommandRequest>>>,
    outputs: Arc<Mutex<VecDeque<CommandOutput>>>,
}

impl MockRunner {
    pub(crate) fn with_outputs(outputs: impl IntoIterator<Item = CommandOutput>) -> Self {
        Self {
            requests: Arc::default(),
            outputs: Arc::new(Mutex::new(outputs.into_iter().collect())),
        }
    }

    pub(crate) fn after_prerequisites(outputs: impl IntoIterator<Item = CommandOutput>) -> Self {
        Self::with_outputs(prerequisites().into_iter().chain(outputs))
    }

    pub(crate) fn requests(&self) -> Vec<CommandRequest> {
        self.requests.lock().expect("requests lock").clone()
    }

    pub(crate) fn push_outputs(&self, outputs: impl IntoIterator<Item = CommandOutput>) {
        self.outputs.lock().expect("outputs lock").extend(outputs);
    }
}

#[async_trait]
impl ProcessRunner for MockRunner {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput, LocalBackendError> {
        self.requests.lock().expect("requests lock").push(request);
        Ok(self
            .outputs
            .lock()
            .expect("outputs lock")
            .pop_front()
            .expect("mock output"))
    }
}

#[derive(Clone, Default)]
pub(crate) struct MockHealth {
    results: Arc<Mutex<VecDeque<bool>>>,
}

impl MockHealth {
    pub(crate) fn with_results(results: impl IntoIterator<Item = bool>) -> Self {
        Self {
            results: Arc::new(Mutex::new(results.into_iter().collect())),
        }
    }
}

#[async_trait]
impl HealthProbe for MockHealth {
    async fn is_healthy(&self, _url: &str) -> bool {
        self.results
            .lock()
            .expect("health lock")
            .pop_front()
            .unwrap_or(false)
    }
}

pub(crate) fn docker_target() -> DockerTarget {
    DockerTarget::new("desktop-linux", "unix:///tmp/docker.sock").expect("local target")
}

pub(crate) fn controller(
    runner: MockRunner,
    health: MockHealth,
) -> DockerCompose<MockRunner, MockHealth> {
    DockerCompose::new(
        runner,
        health,
        PathBuf::from("/opt/docker/bin/docker"),
        docker_target(),
    )
}

pub(crate) fn stack_fixture(
    kind: StackKind,
) -> (tempfile::TempDir, ManagedStackPaths, ManagedStackState) {
    let temp = tempfile::tempdir().expect("temp dir");
    let paths = ManagedStackPaths::from_data_dir(temp.path());
    let (state, secrets) = match kind {
        StackKind::Managed => (
            ManagedStackState::fresh(
                DIGEST_IMAGE,
                4400,
                BackendImageChannel::BackendRelease,
                docker_target(),
            ),
            RuntimeSecrets::new(
                "postgres-password-0123456789abcdef0123456789abcdef",
                "secret-key-base-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ),
        ),
        StackKind::AdoptedLegacy => (
            ManagedStackState::adopted_legacy(
                DIGEST_IMAGE,
                4400,
                "",
                BackendImageChannel::BackendRelease,
                docker_target(),
            ),
            Ok(RuntimeSecrets::legacy_development()),
        ),
    };
    let state = state.expect("valid state");
    paths.install_assets().expect("install assets");
    paths
        .ensure_runtime_secrets(&secrets.expect("valid secrets"), state.kind)
        .expect("persist secrets");
    (temp, paths, state)
}

pub(crate) fn prerequisites() -> [CommandOutput; 3] {
    [
        CommandOutput::success("unix:///tmp/docker.sock"),
        CommandOutput::success("28.0.0"),
        CommandOutput::success("2.30.0"),
    ]
}

pub(crate) fn legacy_outputs(inspect: Option<String>) -> Vec<CommandOutput> {
    let mut outputs = prerequisites().to_vec();
    if let Some(inspect) = inspect {
        outputs.extend([
            CommandOutput::success("postgres-id\nsacrum-id\n"),
            CommandOutput::success(inspect),
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
        ]);
    } else {
        outputs.extend([
            CommandOutput::success(""),
            CommandOutput::success("vertebrae-dev_pgdata\n"),
            CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
        ]);
    }
    outputs
}

pub(crate) async fn detect_legacy(
    outputs: impl IntoIterator<Item = CommandOutput>,
) -> Result<LegacyStackDetection, LocalBackendError> {
    controller(
        MockRunner::after_prerequisites(outputs),
        MockHealth::default(),
    )
    .detect_legacy_stack()
    .await
}

pub(crate) async fn postgres_exec(
    controller: &DockerCompose<SystemProcessRunner, ReqwestHealthProbe>,
    paths: &ManagedStackPaths,
    state: &ManagedStackState,
    secrets: &RuntimeSecrets,
    action: &str,
    psql_args: &[&str],
) -> Result<CommandOutput, LocalBackendError> {
    let mut args = "exec --no-TTY postgres psql -U postgres -d sacrum_prod"
        .split_whitespace()
        .map(OsString::from)
        .collect::<Vec<_>>();
    args.extend(psql_args.iter().map(OsString::from));
    controller
        .checked_stack(
            controller.compose_request(paths, state, action, args, Duration::from_secs(30)),
            secrets,
        )
        .await
}

pub(crate) fn legacy_inspect_json(postgres_image: &str, volume: &str) -> String {
    legacy_inspect_json_with(postgres_image, volume, "")
}

pub(crate) fn legacy_inspect_json_with(
    postgres_image: &str,
    volume: &str,
    host_ip: &str,
) -> String {
    let postgres = serde_json::json!({
        "Image": postgres_image,
        "Project": "vertebrae-dev",
        "Service": "postgres",
        "PortBindings": {},
        "Mounts": [{
            "Type": "volume",
            "Name": volume,
            "Destination": "/var/lib/postgresql/data"
        }]
    });
    let sacrum = serde_json::json!({
        "Image": "ghcr.io/camonz/sacrum:latest",
        "Project": "vertebrae-dev",
        "Service": "sacrum",
        "PortBindings": {
            "4000/tcp": [{ "HostIp": host_ip, "HostPort": "4400" }]
        },
        "Mounts": []
    });
    format!("{postgres}\n{sacrum}\n")
}

pub(crate) fn legacy_volume_inspect(project: &str, volume: &str) -> String {
    format!(r#"{{"Name":"vertebrae-dev_pgdata","Project":"{project}","Volume":"{volume}"}}"#)
}
