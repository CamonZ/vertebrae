use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::DockerCompose;
use crate::local_backend::command::{CommandOutput, CommandRequest, ProcessRunner};
use crate::local_backend::state::{
    ApiToken, DockerTarget, LocalBackendError, ManagedStackPaths, ManagedStackState,
    RuntimeSecrets, SeedAccount,
};

pub(super) const QUICK_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const DOCKER_ENV_REMOVE: [&str; 8] = [
    "DOCKER_API_VERSION",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_AUTH_CONFIG",
];

#[derive(Debug)]
pub(super) struct DockerPrerequisites {
    pub(super) engine_version: String,
    pub(super) engine_major: u64,
}

impl<R, H> DockerCompose<R, H>
where
    R: ProcessRunner,
{
    pub async fn connect(
        runner: R,
        health_probe: H,
        docker_cli: PathBuf,
    ) -> Result<Self, LocalBackendError> {
        if !docker_cli.is_absolute() {
            return Err(LocalBackendError::InvalidState(
                "Docker CLI path must be absolute".to_string(),
            ));
        }
        let target = resolve_docker_target(&runner, &docker_cli, QUICK_COMMAND_TIMEOUT).await?;
        Ok(Self::new(runner, health_probe, docker_cli, target))
    }

    pub(super) async fn check_prerequisites(
        &self,
    ) -> Result<DockerPrerequisites, LocalBackendError> {
        self.revalidate_context().await?;
        let docker = self
            .runner
            .run(self.docker_request(
                "check Docker",
                ["version", "--format", "{{.Server.Version}}"],
                self.quick_timeout,
            ))
            .await?;
        if !docker.success {
            let output = docker.summary();
            let normalized = output.to_ascii_lowercase();
            return if normalized.contains("permission denied")
                || normalized.contains("access is denied")
            {
                Err(LocalBackendError::DockerDaemonPermissionDenied(output))
            } else {
                Err(LocalBackendError::DockerDaemonUnreachable(output))
            };
        }
        let engine_version = docker.stdout.trim().to_string();
        let engine_major = engine_version
            .split('.')
            .next()
            .and_then(|major| major.parse::<u64>().ok())
            .ok_or_else(|| {
                LocalBackendError::DockerDaemonUnreachable(format!(
                    "Docker returned invalid Engine version '{engine_version}'"
                ))
            })?;
        let compose = self
            .runner
            .run(self.docker_request(
                "check Docker Compose",
                ["compose", "version", "--short"],
                self.quick_timeout,
            ))
            .await?;
        if !compose.success {
            return Err(LocalBackendError::ComposeUnavailable(compose.summary()));
        }
        Ok(DockerPrerequisites {
            engine_version,
            engine_major,
        })
    }

    pub(super) async fn revalidate_context(&self) -> Result<(), LocalBackendError> {
        let actual = inspect_docker_target(
            &self.runner,
            &self.docker_cli,
            &self.target.name,
            self.quick_timeout,
        )
        .await?;
        if actual != self.target {
            return Err(LocalBackendError::DockerContextChanged {
                expected_name: self.target.name.clone(),
                expected_endpoint: self.target.endpoint.clone(),
                actual_name: actual.name,
                actual_endpoint: actual.endpoint,
            });
        }
        Ok(())
    }

    pub(super) fn docker_request(
        &self,
        action: &str,
        args: impl IntoIterator<Item = impl Into<OsString>>,
        timeout: Duration,
    ) -> CommandRequest {
        let mut contextual_args = vec![
            OsString::from("--context"),
            OsString::from(&self.target.name),
        ];
        contextual_args.extend(args.into_iter().map(Into::into));
        sanitized_docker_request(action, &self.docker_cli, contextual_args, timeout)
    }

    pub(super) fn compose_request(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        action: &str,
        operation: impl IntoIterator<Item = impl Into<OsString>>,
        timeout: Duration,
    ) -> CommandRequest {
        let project_name = state.project_name();
        let postgres_volume = state.postgres_volume();
        let mut args = vec![
            "compose".into(),
            "--ansi".into(),
            "never".into(),
            "--project-directory".into(),
            paths.root.as_os_str().to_owned(),
            "--project-name".into(),
            project_name.into(),
            "--file".into(),
            paths.compose_file.as_os_str().to_owned(),
            "--env-file".into(),
            paths.secrets_file.as_os_str().to_owned(),
        ];
        args.extend(operation.into_iter().map(Into::into));
        self.docker_request(action, args, timeout)
            .with_env([
                (OsString::from("POSTGRES_VOLUME"), postgres_volume.into()),
                (
                    OsString::from("POSTGRES_VOLUME_EXTERNAL"),
                    state.postgres_volume_is_external().to_string().into(),
                ),
                (
                    OsString::from("POSTGRES_IMAGE_REF"),
                    state.postgres_image_ref().into(),
                ),
                (
                    OsString::from("POSTGRES_DATA_PATH"),
                    state.postgres_data_path().into(),
                ),
                (
                    OsString::from("SACRUM_IMAGE_REF"),
                    state.sacrum_image_ref.clone().into(),
                ),
                (
                    OsString::from("SACRUM_HOST_PORT"),
                    state.host_port.to_string().into(),
                ),
                (
                    OsString::from("SACRUM_BIND_PREFIX"),
                    state.sacrum_bind_prefix().into(),
                ),
                (
                    OsString::from("SEED_SCRIPT_PATH"),
                    paths.seed_file.as_os_str().to_owned(),
                ),
            ])
            .with_env_removed([
                "POSTGRES_PASSWORD",
                "SECRET_KEY_BASE",
                "COMPOSE_PROJECT_NAME",
            ])
    }

    pub(super) fn validate_stack_files(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        state.validate()?;
        if state.docker_target != self.target {
            return Err(LocalBackendError::DockerContextChanged {
                expected_name: state.docker_target.name.clone(),
                expected_endpoint: state.docker_target.endpoint.clone(),
                actual_name: self.target.name.clone(),
                actual_endpoint: self.target.endpoint.clone(),
            });
        }
        for (name, path) in [
            ("Compose asset", paths.compose_file.as_path()),
            ("seeder asset", paths.seed_file.as_path()),
            ("runtime secrets", paths.secrets_file.as_path()),
        ] {
            if !path.is_file() {
                return Err(LocalBackendError::InvalidState(format!(
                    "{name} is missing at {}",
                    path.display()
                )));
            }
        }
        paths.load_runtime_secrets(state.kind)
    }

    pub(super) async fn checked(
        &self,
        request: CommandRequest,
    ) -> Result<CommandOutput, LocalBackendError> {
        let action = request.action.clone();
        let output = self.runner.run(request).await?;
        if output.success {
            Ok(output)
        } else {
            Err(LocalBackendError::CommandFailed {
                action,
                status: output
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "terminated".to_string()),
                output: output.summary(),
            })
        }
    }

    pub(super) async fn checked_stack(
        &self,
        request: CommandRequest,
        secrets: &RuntimeSecrets,
    ) -> Result<CommandOutput, LocalBackendError> {
        let mut output = self
            .checked(request)
            .await
            .map_err(|error| redact_command_error(error, secrets))?;
        output.stdout = secrets.redact(&output.stdout);
        output.stderr = secrets.redact(&output.stderr);
        Ok(output)
    }

    /// Credentials stay in the child process environment and are not persisted.
    pub async fn run_seeder(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        account: &SeedAccount,
        api_token: &ApiToken,
    ) -> Result<(), LocalBackendError> {
        let secrets = self.validate_stack_files(paths, state)?;
        let request = self
            .compose_request(
                paths,
                state,
                "seed local Sacrum account",
                ["run", "--rm", "--no-deps", "seeder"],
                self.reconcile_timeout,
            )
            .with_env([
                ("SEED_EMAIL", account.email()),
                ("SEED_USERNAME", account.username()),
                ("SEED_PASSWORD", account.password()),
                ("SEED_TOKEN", api_token.as_str()),
            ]);

        self.checked_stack(request, &secrets)
            .await
            .map(|_| ())
            .map_err(|error| redact_seed_error(error, account, api_token))
    }
}

async fn resolve_docker_target<R: ProcessRunner>(
    runner: &R,
    docker_cli: &Path,
    timeout: Duration,
) -> Result<DockerTarget, LocalBackendError> {
    let shown = runner
        .run(sanitized_docker_request(
            "resolve Docker context",
            docker_cli,
            ["context", "show"],
            timeout,
        ))
        .await?;
    if !shown.success {
        return Err(LocalBackendError::DockerDaemonUnreachable(shown.summary()));
    }
    let name = shown.stdout.trim();
    if name.is_empty() {
        return Err(LocalBackendError::DockerDaemonUnreachable(
            "Docker returned an empty context name".to_string(),
        ));
    }
    inspect_docker_target(runner, docker_cli, name, timeout).await
}

async fn inspect_docker_target<R: ProcessRunner>(
    runner: &R,
    docker_cli: &Path,
    name: &str,
    timeout: Duration,
) -> Result<DockerTarget, LocalBackendError> {
    let inspected = runner
        .run(sanitized_docker_request(
            "inspect Docker context",
            docker_cli,
            [
                "--context",
                name,
                "context",
                "inspect",
                name,
                "--format",
                "{{.Endpoints.docker.Host}}",
            ],
            timeout,
        ))
        .await?;
    if !inspected.success {
        return Err(LocalBackendError::DockerDaemonUnreachable(
            inspected.summary(),
        ));
    }
    DockerTarget::new(name, inspected.stdout.trim())
}

fn sanitized_docker_request(
    action: &str,
    docker_cli: &Path,
    args: impl IntoIterator<Item = impl Into<OsString>>,
    timeout: Duration,
) -> CommandRequest {
    CommandRequest::new(action, docker_cli.as_os_str(), args, timeout)
        .with_env_removed(DOCKER_ENV_REMOVE)
}

fn redact_command_error(
    mut error: LocalBackendError,
    secrets: &RuntimeSecrets,
) -> LocalBackendError {
    if let LocalBackendError::CommandFailed { output, .. }
    | LocalBackendError::CommandTimedOut { output, .. } = &mut error
    {
        *output = secrets.redact(output);
    }
    error
}

fn redact_seed_error(
    mut error: LocalBackendError,
    account: &SeedAccount,
    api_token: &ApiToken,
) -> LocalBackendError {
    if let LocalBackendError::CommandFailed { output, .. }
    | LocalBackendError::CommandTimedOut { output, .. } = &mut error
    {
        *output = account.redact(&api_token.redact(output));
    }
    error
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use crate::local_backend::state::{ApiToken, SeedAccount, StackKind};
    #[tokio::test]
    async fn controller_resolves_a_local_context_and_neutralizes_ambient_overrides() {
        let runner = MockRunner::with_outputs([
            CommandOutput::success("desktop-linux\n"),
            CommandOutput::success("unix:///tmp/docker.sock\n"),
        ]);

        let connected = DockerCompose::connect(
            runner.clone(),
            MockHealth::default(),
            PathBuf::from("/opt/docker/bin/docker"),
        )
        .await
        .expect("connect controller");

        assert_eq!(connected.target(), &docker_target());
        let requests = runner.requests();
        assert_eq!(requests[0].args_as_strings(), ["context", "show"]);
        assert_eq!(
            requests[1].args_as_strings()[..4],
            ["--context", "desktop-linux", "context", "inspect"]
        );
        for request in requests {
            for name in DOCKER_ENV_REMOVE {
                assert!(request.removes_env(name), "{name} must be sanitized");
            }
        }
    }

    #[tokio::test]
    async fn remote_docker_context_is_rejected_before_daemon_access() {
        let runner = MockRunner::with_outputs([
            CommandOutput::success("remote\n"),
            CommandOutput::success("ssh://builder.example/run/docker.sock\n"),
        ]);

        let result = DockerCompose::connect(
            runner.clone(),
            MockHealth::default(),
            PathBuf::from("/opt/docker/bin/docker"),
        )
        .await;
        let Err(error) = result else {
            panic!("remote context must be rejected");
        };

        assert!(matches!(
            error,
            LocalBackendError::UnsupportedDockerContext { name, endpoint }
                if name == "remote" && endpoint.starts_with("ssh://")
        ));
        assert_eq!(runner.requests().len(), 2);
    }

    #[tokio::test]
    async fn persisted_context_endpoint_is_revalidated() {
        let runner =
            MockRunner::with_outputs([CommandOutput::success("unix:///tmp/different-docker.sock")]);
        let controller = controller(runner.clone(), MockHealth::default());

        let error = controller
            .check_prerequisites()
            .await
            .expect_err("changed context must fail");

        assert!(matches!(
            error,
            LocalBackendError::DockerContextChanged { .. }
        ));
        assert_eq!(runner.requests().len(), 1);
    }

    #[tokio::test]
    async fn prerequisite_failures_are_classified() {
        for (outputs, expected) in [
            (
                vec![
                    CommandOutput::success("unix:///tmp/docker.sock"),
                    CommandOutput::success("28.0.0"),
                    CommandOutput::failure(1, "compose is not a docker command"),
                ],
                "compose",
            ),
            (
                vec![
                    CommandOutput::success("unix:///tmp/docker.sock"),
                    CommandOutput::failure(1, "permission denied while connecting to Docker"),
                ],
                "permission",
            ),
            (
                vec![
                    CommandOutput::success("unix:///tmp/docker.sock"),
                    CommandOutput::failure(1, "Cannot connect to the Docker daemon"),
                ],
                "unreachable",
            ),
        ] {
            let error = controller(MockRunner::with_outputs(outputs), MockHealth::default())
                .check_prerequisites()
                .await
                .expect_err("prerequisite must fail");
            assert!(match expected {
                "compose" => matches!(error, LocalBackendError::ComposeUnavailable(_)),
                "permission" => matches!(error, LocalBackendError::DockerDaemonPermissionDenied(_)),
                _ => matches!(error, LocalBackendError::DockerDaemonUnreachable(_)),
            });
        }
    }

    #[tokio::test]
    async fn compose_failure_redacts_persisted_secrets() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
        let secrets = paths
            .load_runtime_secrets(state.kind)
            .expect("load secrets");
        let postgres_password = secrets.postgres_password();
        let secret_key_base = secrets.secret_key_base();
        let runner = MockRunner::after_prerequisites([
            CommandOutput::success(""),
            CommandOutput::failure(
                1,
                format!("POSTGRES_PASSWORD={postgres_password} SECRET_KEY_BASE={secret_key_base}"),
            ),
        ]);
        let controller = controller(runner, MockHealth::default());

        let error = controller
            .up_detached(&paths, &mut state)
            .await
            .expect_err("config should fail");

        let message = error.to_string();
        assert_eq!(message.matches("[redacted]").count(), 2, "{message}");
        assert!(!message.contains(postgres_password), "{message}");
        assert!(!message.contains(secret_key_base), "{message}");
    }

    #[tokio::test]
    async fn seeder_receives_credentials_only_as_environment_values() {
        let (_temp, paths, state) = stack_fixture(StackKind::Managed);
        let account = SeedAccount::new("person@example.test", "person", "account-password")
            .expect("valid account");
        let token = ApiToken::new(format!("sac_{}", "a".repeat(64))).expect("valid token");
        let runner =
            MockRunner::with_outputs([CommandOutput::success("Local Sacrum account is ready.")]);
        let controller = controller(runner.clone(), MockHealth::default());

        controller
            .run_seeder(&paths, &state, &account, &token)
            .await
            .expect("run one-shot seeder");

        let request = &runner.requests()[0];
        assert!(request.args_as_strings().ends_with(&[
            "run".to_string(),
            "--rm".to_string(),
            "--no-deps".to_string(),
            "seeder".to_string(),
        ]));
        assert_eq!(
            request.env_value("SEED_EMAIL").unwrap(),
            "person@example.test"
        );
        assert_eq!(request.env_value("SEED_USERNAME").unwrap(), "person");
        assert_eq!(
            request.env_value("SEED_PASSWORD").unwrap(),
            "account-password"
        );
        assert_eq!(request.env_value("SEED_TOKEN").unwrap(), token.as_str());
        assert!(request.args_as_strings().iter().all(|argument| {
            !argument.contains("account-password") && !argument.contains(token.as_str())
        }));
    }

    #[tokio::test]
    async fn seeder_failures_redact_account_password_and_api_token() {
        let (_temp, paths, state) = stack_fixture(StackKind::Managed);
        let account = SeedAccount::new("person@example.test", "person", "account-password")
            .expect("valid account");
        let token = ApiToken::new(format!("sac_{}", "b".repeat(64))).expect("valid token");
        let runner = MockRunner::with_outputs([CommandOutput::failure(
            1,
            format!(
                "SEED_PASSWORD={} SEED_TOKEN={}",
                account.password(),
                token.as_str()
            ),
        )]);
        let controller = controller(runner, MockHealth::default());

        let error = controller
            .run_seeder(&paths, &state, &account, &token)
            .await
            .expect_err("seed should fail");
        let message = error.to_string();
        assert!(!message.contains(account.password()), "{message}");
        assert!(!message.contains(token.as_str()), "{message}");
        assert_eq!(message.matches("[redacted]").count(), 2, "{message}");
    }
}
