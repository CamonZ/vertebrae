use super::*;
use crate::local_backend::compose::test_support::{MockRunner, DIGEST_IMAGE};
use crate::local_backend::state::{BackendImageChannel, ProvisioningState};
use serde_json::json;

fn target() -> PodmanTarget {
    PodmanTarget {
        endpoint: "unix:///run/user/1000/podman/podman.sock".into(),
        storage_root: "/home/person/.local/share/containers/storage".into(),
        provider: "/usr/local/bin/docker-compose".into(),
        provider_kind: ComposeProviderKind::DockerCompose,
        machine: None,
    }
}
fn info(rootless: bool, root: &str) -> String {
    serde_json::json!({"host":{"security":{"rootless":rootless}},"store":{"graphRoot":root},"version":{"Version":"5.6.2"}}).to_string()
}
fn runtime(runner: MockRunner) -> PodmanRuntime<MockRunner> {
    PodmanRuntime {
        runner,
        cli: "/usr/local/bin/podman".into(),
        target: target(),
    }
}
fn fixture() -> (tempfile::TempDir, ManagedStackPaths, ManagedStackState) {
    let temp = tempfile::tempdir().unwrap();
    let paths = ManagedStackPaths::from_data_dir(temp.path());
    paths.install_assets().unwrap();
    let state = ManagedStackState::fresh_podman(
        DIGEST_IMAGE,
        4400,
        BackendImageChannel::BackendRelease,
        target(),
    )
    .unwrap();
    paths
        .ensure_runtime_secrets(&RuntimeSecrets::generate().unwrap(), StackKind::Managed)
        .unwrap();
    (temp, paths, state)
}

#[test]
fn refuses_remote_relative_and_invalid_saved_targets() {
    let mut saved = target();
    for endpoint in [
        "ssh://example.test/run/podman.sock",
        "tcp://127.0.0.1:1234",
        "unix://relative",
        "unix:///",
    ] {
        saved.endpoint = endpoint.into();
        assert!(saved.validate().is_err());
    }
    saved = target();
    saved.provider = "docker-compose".into();
    assert!(saved.validate().is_err());
    assert!(target().validate().is_ok());
}

#[test]
fn schema_two_roundtrips_and_cannot_be_misread_as_docker_or_adopted() {
    let (_temp, paths, mut state) = fixture();
    paths.save_state(&state).unwrap();
    assert_eq!(paths.load_state().unwrap().unwrap(), state);
    let json = serde_json::to_value(&state).unwrap();
    assert_eq!(json["schema_version"], 2);
    assert_eq!(json["runtime"], "podman");
    assert!(json.get("docker_target").is_none());
    assert!(state.docker_target().is_err());
    state.schema_version = 1;
    assert!(state.validate().is_err());
    state.schema_version = 2;
    state.kind = StackKind::AdoptedLegacy;
    state.postgres_volume_initialized = true;
    assert!(state.validate().is_err());
    for mutation in [
        serde_json::json!({"runtime":null}),
        serde_json::json!({"runtime":"other"}),
        serde_json::json!({"podman_target":null}),
    ] {
        let mut value = json.clone();
        for (name, value_to_set) in mutation.as_object().unwrap() {
            value[name] = value_to_set.clone();
        }
        let parsed = serde_json::from_value::<ManagedStackState>(value);
        assert!(parsed.is_err() || parsed.unwrap().validate().is_err());
    }
}

#[test]
fn provider_and_socket_are_pinned_with_no_engine_or_environment_fallback() {
    let (_temp, paths, state) = fixture();
    let adapter = runtime(MockRunner::default());
    let request = adapter.compose(&paths, &state, "start Podman backend", ["up", "--detach"]);
    assert_eq!(request.program, target().provider.as_os_str());
    assert_eq!(
        request.env_value("DOCKER_HOST"),
        Some(std::ffi::OsStr::new(&target().endpoint))
    );
    assert!(!request.removes_env("DOCKER_HOST"));
    for name in [
        "DOCKER_CONTEXT",
        "DOCKER_TLS_VERIFY",
        "PODMAN_COMPOSE_PROVIDER",
        "CONTAINER_HOST",
        "COMPOSE_FILE",
        "COMPOSE_PROFILES",
    ] {
        assert!(
            request.removes_env(name),
            "{name} must not override saved selection"
        );
    }
    assert!(!request.args_as_strings().contains(&"--context".to_string()));
    assert!(!request.args_as_strings().contains(&"compose".to_string()));
    let native = adapter.native("inspect", ["info", "--format", "json"]);
    assert_eq!(
        &native.args_as_strings()[..3],
        ["--remote", "--url", &target().endpoint]
    );
    assert!(native.removes_env("CONTAINER_CONNECTION"));
}

#[tokio::test]
async fn changed_storage_or_rootful_engine_is_rejected_before_starting_services() {
    let (_temp, paths, state) = fixture();
    for output in [
        info(false, &target().storage_root),
        info(true, "/different/storage"),
    ] {
        let runner = MockRunner::with_outputs([CommandOutput::success(output)]);
        let adapter = runtime(runner.clone());
        assert!(adapter
            .prepare_start(&paths, &state, StartMode::Reconcile)
            .await
            .is_err());
        assert_eq!(runner.requests().len(), 1);
        assert!(runner.requests()[0]
            .args_as_strings()
            .contains(&"info".into()));
    }
}

#[tokio::test]
async fn unsupported_provider_is_rejected_and_explicit_path_is_used() {
    for (version, accepted) in [
        ("2.23.0", false),
        ("1.29.2", false),
        ("garbage", false),
        ("2.24.0", true),
        ("5.5.1", true),
    ] {
        let runner = MockRunner::with_outputs([CommandOutput::success(version)]);
        let adapter = runtime(runner.clone());
        assert_eq!(adapter.check_provider().await.is_ok(), accepted);
        assert_eq!(runner.requests()[0].program, target().provider.as_os_str());
    }
}

#[tokio::test]
async fn missing_and_foreign_volumes_are_distinguished_without_mutation() {
    let (_temp, _paths, state) = fixture();
    let runner = MockRunner::with_outputs([CommandOutput::success("")]);
    assert_eq!(
        runtime(runner)
            .inspect_database_volume(&state)
            .await
            .unwrap(),
        DatabaseVolumeStatus::Absent
    );
    for (project, expected) in [
        (state.project_name(), DatabaseVolumeStatus::Present),
        (
            "other-project".into(),
            DatabaseVolumeStatus::Unsafe(
                "Podman database volume has unexpected ownership metadata".into(),
            ),
        ),
    ] {
        let metadata = serde_json::json!([{"Name":state.postgres_volume(),"Labels":{"com.docker.compose.project":project,"com.docker.compose.volume":"pgdata"}}]);
        let runner = MockRunner::with_outputs([
            CommandOutput::success(state.postgres_volume()),
            CommandOutput::success(metadata.to_string()),
        ]);
        assert_eq!(
            runtime(runner)
                .inspect_database_volume(&state)
                .await
                .unwrap(),
            expected
        );
    }
}

#[tokio::test]
async fn wildcard_and_wrong_port_publishing_are_rejected() {
    let (_temp, paths, state) = fixture();
    let secrets = paths.load_runtime_secrets(state.kind).unwrap();
    for (ip, port, accepted) in [
        ("127.0.0.1", "4400", true),
        ("0.0.0.0", "4400", false),
        ("::", "4400", false),
        ("127.0.0.1", "4401", false),
    ] {
        let metadata = serde_json::json!({"4000/tcp":[{"HostIp":ip,"HostPort":port}]});
        let runner = MockRunner::with_outputs([
            CommandOutput::success("container-id"),
            CommandOutput::success(metadata.to_string()),
        ]);
        assert_eq!(
            runtime(runner)
                .verify_loopback(&paths, &state, &secrets)
                .await
                .is_ok(),
            accepted
        );
    }
}

#[tokio::test]
async fn seeder_environment_and_failure_redaction_preserve_credentials() {
    let (_temp, paths, state) = fixture();
    let account = SeedAccount::new("person@example.test", "person", "password123").unwrap();
    let token = ApiToken::generate().unwrap();
    let secrets = paths.load_runtime_secrets(state.kind).unwrap();
    let runner = MockRunner::with_outputs([
        CommandOutput::success(info(true, &target().storage_root)),
        CommandOutput::failure(
            1,
            format!(
                "{} {} {}",
                account.password(),
                token.as_str(),
                secrets.postgres_password()
            ),
        ),
    ]);
    let error = runtime(runner.clone())
        .run_seeder(&paths, &state, &account, &token)
        .await
        .unwrap_err();
    for secret in [
        account.password(),
        token.as_str(),
        secrets.postgres_password(),
    ] {
        assert!(!error.to_string().contains(secret));
    }
    let requests = runner.requests();
    let request = requests.last().unwrap();
    assert_eq!(
        request.env_value("SEED_TOKEN"),
        Some(std::ffi::OsStr::new(token.as_str()))
    );
    assert!(!request.args_as_strings().join(" ").contains(token.as_str()));
}

#[tokio::test]
async fn shared_manager_refuses_missing_saved_podman_volume_without_reseeding() {
    let (_temp, paths, mut state) = fixture();
    state.postgres_volume_initialized = true;
    state.provisioning_state = ProvisioningState::Ready;
    let runner = MockRunner::with_outputs([
        CommandOutput::success(info(true, &target().storage_root)),
        CommandOutput::success("2.24.0"),
        CommandOutput::success(""),
    ]);
    let manager = crate::local_backend::manager::LocalBackendManager::with_runtime(
        runtime(runner.clone()),
        crate::local_backend::compose::test_support::MockHealth::default(),
    );
    assert!(matches!(
        manager.up_detached(&paths, &mut state).await,
        Err(LocalBackendError::PersistentVolumeUnavailable { .. })
    ));
    assert_eq!(runner.requests().len(), 3);
    assert!(runner
        .requests()
        .iter()
        .all(|r| !r.args_as_strings().contains(&"up".to_string())));
}

#[test]
fn podman_versions_and_rootless_information_are_required() {
    assert!(
        inspect_store(&serde_json::from_str(&info(true, &target().storage_root)).unwrap()).is_ok()
    );
    for version in ["4.9.0", "5.5.9", "unknown", "bad.5.6"] {
        let mut value: Value = serde_json::from_str(&info(true, &target().storage_root)).unwrap();
        value["version"]["Version"] = version.into();
        assert!(inspect_store(&value).is_err());
    }
}

fn machine_outputs(uri: &str, rootful: bool, running: bool, default: bool) -> Vec<CommandOutput> {
    vec![
        CommandOutput::success(serde_json::json!([
            {"Name":"dev", "URI":uri, "Identity":"/keys/dev", "Default":default},
            {"Name":"elsewhere", "URI":"ssh://person@example.test/run/podman.sock", "Identity":"/keys/elsewhere", "Default":!default}
        ]).to_string()),
        CommandOutput::success(serde_json::json!([{"Name":"dev"}]).to_string()),
        CommandOutput::success(serde_json::json!([{
            "Name":"dev", "State":if running {"running"} else {"stopped"}, "Rootful":rootful,
            "ConnectionInfo":{"PodmanSocket":{"Path":"/tmp/dev-api.sock"}},
            "SSHConfig":{"Port":12345,"IdentityPath":"/keys/dev","RemoteUsername":"core"}
        }]).to_string()),
    ]
}

#[tokio::test]
async fn saved_machine_ignores_new_default_but_revalidates_registered_identity() {
    let uri = "ssh://core@127.0.0.1:12345/run/user/1000/podman/podman.sock";
    let runner = MockRunner::with_outputs(machine_outputs(uri, false, true, false));
    let (socket, saved) = inspect_machine(&runner, std::path::Path::new("/usr/bin/podman"), "dev")
        .await
        .unwrap();
    assert_eq!(socket, "unix:///tmp/dev-api.sock");
    assert_eq!(saved.connection, "dev");
    assert_eq!(saved.uri, uri);
    for (uri, rootful, running) in [
        (
            "ssh://core@example.test:12345/run/user/1000/podman/podman.sock",
            false,
            true,
        ),
        (
            "ssh://core@127.0.0.1:12346/run/user/1000/podman/podman.sock",
            false,
            true,
        ),
        (
            "ssh://root@127.0.0.1:12345/run/podman/podman.sock",
            true,
            true,
        ),
        (uri, false, false),
    ] {
        let runner = MockRunner::with_outputs(machine_outputs(uri, rootful, running, true));
        assert!(
            inspect_machine(&runner, std::path::Path::new("/usr/bin/podman"), "dev")
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn unregistered_default_remote_connection_is_never_treated_as_a_local_machine() {
    let mut outputs = machine_outputs(
        "ssh://core@127.0.0.1:12345/run/user/1000/podman/podman.sock",
        false,
        true,
        false,
    );
    outputs.pop();
    let runner = MockRunner::with_outputs(outputs);
    assert!(
        inspect_machine(&runner, std::path::Path::new("/usr/bin/podman"), "")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn failed_publication_stops_only_sacrum_and_keeps_volume() {
    let (_temp, paths, state) = fixture();
    let secrets = paths.load_runtime_secrets(state.kind).unwrap();
    let metadata = serde_json::json!({"4000/tcp":[{"HostIp":"0.0.0.0","HostPort":"4400"}]});
    let runner = MockRunner::with_outputs([
        CommandOutput::success(""),
        CommandOutput::success(""),
        CommandOutput::success("container-id"),
        CommandOutput::success(metadata.to_string()),
        CommandOutput::success(""),
    ]);
    assert!(runtime(runner.clone())
        .start_services(&paths, &state, &secrets, StartMode::Reconcile)
        .await
        .is_err());
    let requests = runner.requests();
    assert_eq!(
        &requests
            .last()
            .unwrap()
            .args_as_strings()
            .into_iter()
            .rev()
            .take(2)
            .collect::<Vec<_>>(),
        &["sacrum", "stop"]
    );
    assert!(requests
        .iter()
        .all(|r| !r.args_as_strings().contains(&"down".to_string())));
}

#[tokio::test]
async fn bounded_progress_does_not_fail_successful_pulls_but_inspection_requires_complete_output() {
    let mut output = CommandOutput::success("{\"partial\":true}");
    output.truncated = true;
    let runner = MockRunner::with_outputs([output]);
    let request = runtime(runner.clone()).native("pull Podman backend image", ["pull", "example"]);
    let progress = checked(&runner, request)
        .await
        .expect("successful pull with bounded progress");
    assert!(parse::<Value>(&progress).is_err());
}

fn podman_runtime(runner: MockRunner) -> PodmanRuntime<MockRunner> {
    let mut adapter = runtime(runner);
    adapter.target.provider_kind = ComposeProviderKind::PodmanCompose;
    adapter.target.provider = "/usr/local/bin/podman-compose".into();
    adapter
}

#[test]
fn discovery_prefers_podman_compose_and_supports_docker_only_installations() {
    for (podman, docker, expected) in [
        (true, false, Some(ComposeProviderKind::PodmanCompose)),
        (true, true, Some(ComposeProviderKind::PodmanCompose)),
        (false, true, Some(ComposeProviderKind::DockerCompose)),
        (false, false, None),
    ] {
        let result = discover_provider(|name| {
            if (name == "podman-compose" && podman) || (name == "docker-compose" && docker) {
                Ok(PathBuf::from("/tools with spaces").join(name))
            } else {
                Err(problem("not installed"))
            }
        });
        assert_eq!(result.as_ref().ok().map(|(kind, _)| *kind), expected);
        if let Ok((kind, path)) = result {
            assert_eq!(path, PathBuf::from("/tools with spaces").join(kind.name()));
        }
    }
}

#[test]
fn legacy_provider_identity_is_docker_and_invalid_supplied_identity_is_rejected() {
    let mut json = serde_json::to_value(target()).unwrap();
    json.as_object_mut().unwrap().remove("provider_kind");
    assert_eq!(
        serde_json::from_value::<PodmanTarget>(json.clone()).unwrap(),
        target()
    );
    for value in [Value::Null, json!("unknown"), json!(23)] {
        json["provider_kind"] = value;
        assert!(serde_json::from_value::<PodmanTarget>(json.clone()).is_err());
    }
    json["provider_kind"] = json!("podman_compose");
    assert_eq!(
        serde_json::from_value::<PodmanTarget>(json)
            .unwrap()
            .provider_kind,
        ComposeProviderKind::PodmanCompose
    );
}

#[test]
fn podman_provider_uses_pinned_cli_socket_and_its_own_command_dialect() {
    let (_temp, paths, state) = fixture();
    let mut adapter = podman_runtime(MockRunner::default());
    adapter.cli = "/tools with spaces/podman".into();
    let request = adapter.compose(
        &paths,
        &state,
        "update",
        ["up", "--detach", "--no-deps", "--pull", "never", "sacrum"],
    );
    let args = request.args_as_strings();
    assert!(args
        .windows(2)
        .any(|p| p == ["--podman-path", "/tools with spaces/podman"]));
    assert!(!args.contains(&"--podman-args=--remote".into()));
    assert!(args.contains(&"--podman-run-args=--pull=never".into()));
    assert!(args.contains(&"--force-recreate".into()));
    assert!(!args.contains(&"--project-directory".into()));
    assert!(!args.contains(&"--ansi".into()));
    assert!(!args.contains(&"--pull".into()));
    assert_eq!(
        request.env_value("CONTAINER_HOST"),
        Some(std::ffi::OsStr::new(&target().endpoint))
    );
    assert!(!request.removes_env("CONTAINER_HOST"));
    assert!(request.removes_env("CONTAINER_CONNECTION"));
    assert!(request.removes_env("PODMAN_COMPOSE_PROVIDER"));
}

#[tokio::test]
async fn podman_provider_version_floor_and_native_status_are_validated() {
    for (version, accepted) in [
        ("1.4.0", false),
        ("1.5.0", true),
        ("2.0.0", true),
        ("garbage", false),
    ] {
        let runner = MockRunner::with_outputs([CommandOutput::success(version)]);
        assert_eq!(
            podman_runtime(runner.clone())
                .check_provider()
                .await
                .is_ok(),
            accepted
        );
        assert!(runner.requests()[0]
            .args_as_strings()
            .contains(&"--podman-path".into()));
    }
    let (_temp, _paths, state) = fixture();
    let runner = MockRunner::with_outputs([
        CommandOutput::success("abc\ndef"),
        CommandOutput::success(
            r#"{"name":"db","service":"postgres","state":"running","health":"healthy","exit_code":0}
{"name":"api","service":"sacrum","state":"running","health":"healthy","exit_code":0}"#,
        ),
    ]);
    let services = podman_runtime(runner).native_status(&state).await.unwrap();
    assert_eq!(services.len(), 2);
    assert!(services
        .iter()
        .all(|s| s.health.as_deref() == Some("healthy")));
}

#[tokio::test]
async fn podman_volume_requires_both_project_labels_and_exact_generated_name() {
    let (_temp, _paths, state) = fixture();
    for (name, project, accepted) in [
        (state.postgres_volume(), state.project_name(), true),
        (state.postgres_volume(), "foreign".into(), false),
        ("foreign".into(), state.project_name(), false),
    ] {
        let metadata = json!([{"Name":name,"Labels":{"com.docker.compose.project":state.project_name(),"io.podman.compose.project":project}}]);
        let runner = MockRunner::with_outputs([
            CommandOutput::success(state.postgres_volume()),
            CommandOutput::success(metadata.to_string()),
        ]);
        assert_eq!(
            podman_runtime(runner)
                .inspect_database_volume(&state)
                .await
                .unwrap()
                == DatabaseVolumeStatus::Present,
            accepted
        );
    }
}

#[tokio::test]
async fn podman_update_pulls_then_recreates_only_sacrum_without_replacing_provider() {
    let (_temp, paths, mut current) = fixture();
    let metadata = json!([{"Name":current.postgres_volume(),"Labels":{
        "com.docker.compose.project":current.project_name(),"io.podman.compose.project":current.project_name()
    }}]);
    let binding = json!({"4000/tcp":[{"HostIp":"127.0.0.1","HostPort":"4400"}]});
    let runner = MockRunner::with_outputs([
        CommandOutput::success(info(true, &target().storage_root)),
        CommandOutput::success("1.5.0"),
        CommandOutput::success(current.postgres_volume()),
        CommandOutput::success(metadata.to_string()),
        CommandOutput::success(""),
        CommandOutput::success(""),
        CommandOutput::success("container-id"),
        CommandOutput::success(binding.to_string()),
    ]);
    let adapter = podman_runtime(runner.clone());
    current.podman_target = Some(adapter.target.clone());
    let mut updated = current.clone();
    updated.sacrum_image_ref = format!("ghcr.io/camonz/sacrum@sha256:{}", "b".repeat(64));
    adapter
        .replace_sacrum_image(&paths, &current, &updated)
        .await
        .unwrap();
    let requests = runner.requests();
    assert_eq!(requests.len(), 8);
    assert!(requests[4]
        .args_as_strings()
        .ends_with(&["pull".into(), "sacrum".into()]));
    let recreate = requests[5].args_as_strings();
    assert!(recreate.contains(&"--force-recreate".into()));
    assert!(recreate.contains(&"--no-deps".into()));
    assert!(recreate.contains(&"--podman-run-args=--pull=never".into()));
    assert_eq!(recreate.last().map(String::as_str), Some("sacrum"));
    assert!(requests
        .iter()
        .all(|r| !r.args_as_strings().contains(&"down".into())));
}

#[tokio::test]
async fn saved_podman_compose_installation_never_recreates_a_missing_volume() {
    let (_temp, paths, mut state) = fixture();
    let runner = MockRunner::with_outputs([
        CommandOutput::success(info(true, &target().storage_root)),
        CommandOutput::success("1.5.0"),
        CommandOutput::success(""),
    ]);
    let adapter = podman_runtime(runner.clone());
    state.podman_target = Some(adapter.target.clone());
    state.postgres_volume_initialized = true;
    state.provisioning_state = ProvisioningState::Ready;
    let manager = crate::local_backend::manager::LocalBackendManager::with_runtime(
        adapter,
        crate::local_backend::compose::test_support::MockHealth::default(),
    );
    assert!(matches!(
        manager.up_detached(&paths, &mut state).await,
        Err(LocalBackendError::PersistentVolumeUnavailable { .. })
    ));
    assert_eq!(runner.requests().len(), 3);
    assert!(runner
        .requests()
        .iter()
        .all(|r| !r.args_as_strings().contains(&"create".into())));
}

#[tokio::test]
async fn initial_podman_volume_creation_is_checked_before_starting_services() {
    let (_temp, paths, mut state) = fixture();
    let runner = MockRunner::with_outputs([
        CommandOutput::success(""), // config validates before mutation
        CommandOutput::success(""), // initial volume absent
        CommandOutput::success(state.postgres_volume()), // native create
        CommandOutput::success(state.postgres_volume()),
        // A foreign volume won a race for the same name: do not start containers.
        CommandOutput::success(json!([{"Name":state.postgres_volume(),"Labels":{}}]).to_string()),
    ]);
    let adapter = podman_runtime(runner.clone());
    state.podman_target = Some(adapter.target.clone());
    let secrets = paths.load_runtime_secrets(state.kind).unwrap();
    let error = adapter
        .start_services(&paths, &state, &secrets, StartMode::Reconcile)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("ownership metadata"));
    assert_eq!(runner.requests().len(), 5);
    assert!(runner
        .requests()
        .iter()
        .all(|r| !r.args_as_strings().contains(&"up".into())));
}
