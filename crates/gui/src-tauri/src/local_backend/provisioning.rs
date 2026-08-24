use super::command::ProcessRunner;
use super::compose::{DockerCompose, HealthProbe, ServiceStatus};
use super::state::{
    ApiToken, LocalBackendError, ManagedStackPaths, ManagedStackState, ProvisioningStage,
    ProvisioningState, RuntimeSecrets, SeedAccount, StackKind,
};

/// Provisioning result without the API token, which is persisted in the canonical config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisioningResult {
    pub backend_url: String,
    pub provisioning_state: ProvisioningState,
    pub services: Vec<ServiceStatus>,
}

impl<R, H> DockerCompose<R, H>
where
    R: ProcessRunner,
    H: HealthProbe,
{
    /// Persist secrets and the API token before starting Docker so retries reuse them.
    pub async fn provision_fresh(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
        account: SeedAccount,
    ) -> Result<ProvisioningResult, LocalBackendError> {
        self.provision_fresh_with_progress(paths, state, account, |_| {})
            .await
    }

    pub async fn provision_fresh_with_progress<F>(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
        account: SeedAccount,
        progress: F,
    ) -> Result<ProvisioningResult, LocalBackendError>
    where
        F: Fn(ProvisioningStage) + Send + Sync,
    {
        if state.kind != StackKind::Managed {
            return Err(LocalBackendError::InvalidState(
                "fresh local provisioning cannot modify an adopted development stack".to_string(),
            ));
        }
        if state.provisioning_state == ProvisioningState::Ready {
            return Err(LocalBackendError::InvalidState(
                "local backend is already provisioned; normal startup must not reseed it"
                    .to_string(),
            ));
        }

        if let Err(error) = paths.install_assets() {
            return Err(record_failed_state(paths, state, error));
        }

        if let Err(error) = ensure_runtime_secrets(paths, state.kind) {
            return Err(record_failed_state(paths, state, error));
        }
        let api_token = match ensure_api_token(paths) {
            Ok(token) => token,
            Err(error) => return Err(record_failed_state(paths, state, error)),
        };

        let services = match self
            .start_and_wait_until_healthy_with_progress(paths, state, &progress)
            .await
        {
            Ok(services) => services,
            Err(error) => return Err(error),
        };

        progress(ProvisioningStage::Seeding);
        let seed_result = self.run_seeder(paths, state, &account, &api_token).await;
        drop(account);
        if let Err(error) = seed_result {
            return Err(record_failed_state(paths, state, error));
        }

        if let Err(error) = persist_local_client_config(&state.backend_url(), &api_token) {
            return Err(record_failed_state(paths, state, error));
        }

        state.provisioning_state = ProvisioningState::Ready;
        if let Err(error) = paths.save_state(state) {
            return Err(record_failed_state(paths, state, error));
        }

        Ok(ProvisioningResult {
            backend_url: state.backend_url(),
            provisioning_state: state.provisioning_state,
            services,
        })
    }

    pub async fn provision_adopted<F>(
        &self,
        paths: &ManagedStackPaths,
        state: &mut ManagedStackState,
        configured_token: ApiToken,
        progress: F,
    ) -> Result<ProvisioningResult, LocalBackendError>
    where
        F: Fn(ProvisioningStage) + Send + Sync,
    {
        if state.kind != StackKind::AdoptedLegacy {
            return Err(LocalBackendError::InvalidState(
                "adoption provisioning requires an adopted development stack".to_string(),
            ));
        }

        state.provisioning_state = ProvisioningState::InProgress;
        paths.save_state(state)?;
        if let Err(error) = ensure_runtime_secrets(paths, state.kind) {
            return Err(record_failed_state(paths, state, error));
        }
        let api_token = match paths.ensure_api_token(&configured_token) {
            Ok(token) => token,
            Err(error) => return Err(record_failed_state(paths, state, error)),
        };

        let result = async {
            progress(ProvisioningStage::Pulling);
            self.up_adopted(paths, state).await?;
            progress(ProvisioningStage::Health);
            self.wait_until_healthy(paths, state).await?;
            let services = self.status(paths, state).await?;
            self.authenticate_backend(state, &api_token).await?;
            persist_local_client_config(&state.backend_url(), &api_token)?;
            state.provisioning_state = ProvisioningState::Ready;
            paths.save_state(state)?;
            Ok(ProvisioningResult {
                backend_url: state.backend_url(),
                provisioning_state: state.provisioning_state,
                services,
            })
        }
        .await;

        match result {
            Ok(result) => Ok(result),
            Err(error) => Err(record_failed_state(paths, state, error)),
        }
    }
}

pub(crate) fn ensure_runtime_secrets(
    paths: &ManagedStackPaths,
    kind: StackKind,
) -> Result<RuntimeSecrets, LocalBackendError> {
    if paths.secrets_file.is_file() {
        paths.load_runtime_secrets(kind)
    } else {
        let proposed = RuntimeSecrets::generate()?;
        paths.ensure_runtime_secrets(&proposed, kind)
    }
}

pub(crate) fn ensure_api_token(paths: &ManagedStackPaths) -> Result<ApiToken, LocalBackendError> {
    if paths.api_token_file.is_file() {
        paths.load_api_token()
    } else {
        let proposed = ApiToken::generate()?;
        paths.ensure_api_token(&proposed)
    }
}

fn record_failed_state(
    paths: &ManagedStackPaths,
    state: &mut ManagedStackState,
    error: LocalBackendError,
) -> LocalBackendError {
    state.provisioning_state = ProvisioningState::Failed;
    match paths.save_state(state) {
        Ok(()) => error,
        Err(save_error) => LocalBackendError::InvalidState(format!(
            "{error}; additionally could not record failed provisioning state: {save_error}"
        )),
    }
}

pub(crate) fn persist_local_client_config(
    backend_url: &str,
    api_token: &ApiToken,
) -> Result<(), LocalBackendError> {
    let mut config = vertebrae_sacrum_client::load_config_file().map_err(|error| {
        LocalBackendError::InvalidState(format!("could not load backend client config: {error}"))
    })?;
    update_connection_config(&mut config, backend_url, api_token)?;
    vertebrae_sacrum_client::save_config_file(&config).map_err(|error| {
        LocalBackendError::InvalidState(format!("could not persist backend client config: {error}"))
    })
}

fn update_connection_config(
    config: &mut vertebrae_sacrum_client::VertebraeConfigFile,
    backend_url: &str,
    api_token: &ApiToken,
) -> Result<(), LocalBackendError> {
    let parsed = url::Url::parse(backend_url).map_err(|error| {
        LocalBackendError::InvalidState(format!("local backend URL is invalid: {error}"))
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(LocalBackendError::InvalidState(
            "local backend URL must include an HTTP(S) scheme and host".to_string(),
        ));
    }

    config.sacrum.url = backend_url.trim_end_matches('/').to_string();
    config.sacrum.token = Some(api_token.as_str().to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::compose::test_support::*;
    use super::*;
    use crate::local_backend::command::CommandOutput;

    #[test]
    fn failed_state_recording_does_not_include_runtime_secrets() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::Managed);
        let error = record_failed_state(
            &paths,
            &mut state,
            LocalBackendError::CommandFailed {
                action: "seed local backend account".to_string(),
                status: "1".to_string(),
                output: "safe diagnostic".to_string(),
            },
        );

        assert!(error.to_string().contains("safe diagnostic"));
        assert_eq!(state.provisioning_state, ProvisioningState::Failed);
        let persisted = paths
            .load_state()
            .expect("load state")
            .expect("state exists");
        assert_eq!(persisted.provisioning_state, ProvisioningState::Failed);
        let json = std::fs::read_to_string(paths.state_file).expect("read state");
        assert!(!json.contains("POSTGRES_PASSWORD"));
        assert!(!json.contains("SECRET_KEY_BASE"));
    }

    #[test]
    fn local_client_config_rejects_non_http_urls_before_persisting() {
        let token = ApiToken::new(format!("sac_{}", "a".repeat(64))).expect("valid token");
        let error = persist_local_client_config("file:///tmp/backend", &token)
            .expect_err("file URL must not be configured");
        assert!(error.to_string().contains("HTTP(S)"));
    }

    #[test]
    fn local_client_config_updates_only_the_connection_fields() {
        let token = ApiToken::new(format!("sac_{}", "a".repeat(64))).expect("valid token");
        let mut config = vertebrae_sacrum_client::VertebraeConfigFile::default();
        config.projects.insert(
            "demo".to_string(),
            vertebrae_sacrum_client::ProjectSection {
                id: "project-id".to_string(),
                path: "/tmp/demo".to_string(),
            },
        );

        update_connection_config(&mut config, "http://127.0.0.1:4400///", &token)
            .expect("update connection config");

        assert_eq!(config.sacrum.url, "http://127.0.0.1:4400");
        assert_eq!(config.sacrum.token.as_deref(), Some(token.as_str()));
        assert_eq!(config.projects["demo"].id, "project-id");
        let serialized = toml::to_string(&config).expect("serialize config");
        assert!(!serialized.contains("local_backend"));
        assert!(!serialized.contains("docker"));
        assert!(!serialized.contains("POSTGRES_PASSWORD"));
        assert!(!serialized.contains("SECRET_KEY_BASE"));
    }

    #[test]
    fn retry_reuses_persisted_runtime_secrets_and_api_token() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let paths = ManagedStackPaths::from_data_dir(temp.path());
        let first_runtime =
            ensure_runtime_secrets(&paths, StackKind::Managed).expect("persist runtime secrets");
        let first_token = ensure_api_token(&paths).expect("persist API token");

        let second_runtime =
            ensure_runtime_secrets(&paths, StackKind::Managed).expect("reuse runtime secrets");
        let second_token = ensure_api_token(&paths).expect("reuse API token");

        assert_eq!(first_runtime, second_runtime);
        assert_eq!(first_token, second_token);
        let runtime_file = std::fs::read_to_string(paths.secrets_file).expect("read runtime file");
        let token_file = std::fs::read_to_string(paths.api_token_file).expect("read token file");
        assert!(!runtime_file.contains("account-password"));
        assert!(!token_file.contains("password"));
        assert!(!runtime_file.contains(first_token.as_str()));
    }

    #[tokio::test]
    async fn adopted_stacks_cannot_enter_the_fresh_provisioning_flow() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::AdoptedLegacy);
        let account =
            SeedAccount::new("person@example.test", "person", "password").expect("valid account");
        let controller = controller(
            MockRunner::with_outputs([CommandOutput::success("unused")]),
            MockHealth::default(),
        );

        let error = controller
            .provision_fresh(&paths, &mut state, account)
            .await
            .expect_err("adopted stack must not be fresh provisioned");

        assert!(error.to_string().contains("adopted development stack"));
        assert_eq!(state.provisioning_state, ProvisioningState::Unverified);
    }

    #[tokio::test]
    async fn adopted_provisioning_reuses_configured_token_without_seeding() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::AdoptedLegacy);
        let volume = state.postgres_volume();
        let mut outputs = prerequisites().to_vec();
        outputs.extend([
            CommandOutput::success(format!("{volume}\n")),
            CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
            CommandOutput::success(""),
            CommandOutput::failure(1, "safe Docker reconciliation failure"),
        ]);
        let runner = MockRunner::with_outputs(outputs);
        let controller = controller(runner.clone(), MockHealth::default());
        let configured_token =
            ApiToken::new(format!("sac_{}", "b".repeat(64))).expect("valid configured token");

        let result = controller
            .provision_adopted(&paths, &mut state, configured_token.clone(), |_| {})
            .await
            .expect_err("reconciliation failure should stop before health");

        assert!(result
            .to_string()
            .contains("safe Docker reconciliation failure"));
        assert_eq!(state.provisioning_state, ProvisioningState::Failed);
        assert_eq!(
            paths.load_api_token().expect("load token"),
            configured_token
        );
        assert_eq!(
            paths
                .load_runtime_secrets(StackKind::AdoptedLegacy)
                .expect("load legacy secrets"),
            RuntimeSecrets::legacy_development()
        );
        assert!(runner.requests().iter().all(|request| {
            !request
                .args_as_strings()
                .iter()
                .any(|argument| matches!(argument.as_str(), "seed" | "init"))
        }));
    }

    #[tokio::test]
    async fn adopted_provisioning_authenticates_before_ready_or_config_persistence() {
        let (_temp, paths, mut state) = stack_fixture(StackKind::AdoptedLegacy);
        let volume = state.postgres_volume();
        let status = r#"[{"Name":"legacy-postgres-1","Service":"postgres","State":"running","Health":"healthy","ExitCode":0},{"Name":"legacy-sacrum-1","Service":"sacrum","State":"running","Health":"healthy","ExitCode":0}]"#;
        let runner = MockRunner::with_outputs(
            prerequisites()
                .into_iter()
                .chain([
                    CommandOutput::success(format!("{volume}\n")),
                    CommandOutput::success(legacy_volume_inspect("vertebrae-dev", "pgdata")),
                    CommandOutput::success(""),
                    CommandOutput::success(""),
                    CommandOutput::success(status),
                ])
                .chain([
                    CommandOutput::success("unix:///tmp/docker.sock"),
                    CommandOutput::success("unix:///tmp/docker.sock"),
                    CommandOutput::success("28.0.0"),
                    CommandOutput::success("2.30.0"),
                    CommandOutput::success(status),
                ]),
        );
        let controller = controller(
            runner.clone(),
            MockHealth::with_results_and_auth([true], [false]),
        );
        let configured_token = ApiToken::new("sac_dev-local-token").expect("legacy token");

        let error = controller
            .provision_adopted(&paths, &mut state, configured_token.clone(), |_| {})
            .await
            .expect_err("wrong token must prevent adoption from becoming ready");

        assert!(
            matches!(error, LocalBackendError::BackendAuthenticationFailed { .. }),
            "unexpected adoption error: {error:?}"
        );
        assert_eq!(state.provisioning_state, ProvisioningState::Failed);
        assert_eq!(
            paths.load_api_token().expect("private token"),
            configured_token
        );
        assert!(runner.requests().iter().all(|request| {
            let args = request.args_as_strings();
            !args.iter().any(|argument| {
                matches!(
                    argument.as_str(),
                    "down" | "rm" | "--volumes" | "seed" | "init"
                )
            })
        }));
        let requests = runner.requests();
        let start = requests
            .iter()
            .find(|request| request.action.contains("start preserved"))
            .expect("preserved start request");
        let args = start.args_as_strings();
        assert!(args.windows(2).any(|pair| pair == ["--pull", "never"]));
        assert!(args.iter().any(|argument| argument == "--no-recreate"));
        assert!(!args.windows(2).any(|pair| pair == ["--pull", "missing"]));
    }
}
