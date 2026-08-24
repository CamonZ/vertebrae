use std::time::Duration;

use async_trait::async_trait;

use super::DockerCompose;
use crate::local_backend::command::ProcessRunner;
use crate::local_backend::state::{
    ApiToken, LocalBackendError, ManagedStackPaths, ManagedStackState,
};

pub(super) const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(2);

#[async_trait]
pub trait HealthProbe: Send + Sync {
    async fn is_healthy(&self, url: &str) -> bool;

    async fn authenticate(&self, url: &str, api_token: &ApiToken) -> Result<(), LocalBackendError>;
}

#[derive(Clone)]
pub struct ReqwestHealthProbe {
    client: reqwest::Client,
}

impl Default for ReqwestHealthProbe {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("valid health probe client"),
        }
    }
}

#[async_trait]
impl HealthProbe for ReqwestHealthProbe {
    async fn is_healthy(&self, url: &str) -> bool {
        self.client
            .get(url)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }

    async fn authenticate(&self, url: &str, api_token: &ApiToken) -> Result<(), LocalBackendError> {
        let response = self
            .client
            .post(format!("{url}/graphql"))
            .bearer_auth(api_token.as_str())
            .json(&serde_json::json!({
                "query": "query VerifyBackendToken { projects { id } }"
            }))
            .send()
            .await
            .map_err(|error| LocalBackendError::BackendAuthenticationFailed {
                status: "network error".to_string(),
                message: error.to_string(),
            })?;
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            LocalBackendError::BackendAuthenticationFailed {
                status: status.to_string(),
                message: error.to_string(),
            }
        })?;
        let redacted_body = api_token.redact(&body);
        let parsed = serde_json::from_str::<serde_json::Value>(&body).map_err(|error| {
            LocalBackendError::BackendAuthenticationFailed {
                status: status.to_string(),
                message: format!("backend returned invalid JSON: {error}"),
            }
        })?;
        let has_graphql_errors = parsed
            .get("errors")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|errors| !errors.is_empty());
        if !status.is_success() || has_graphql_errors || parsed.get("data").is_none() {
            return Err(LocalBackendError::BackendAuthenticationFailed {
                status: status.to_string(),
                message: truncate_authentication_detail(&redacted_body),
            });
        }
        Ok(())
    }
}

fn truncate_authentication_detail(detail: &str) -> String {
    const MAX_DETAIL_BYTES: usize = 512;
    if detail.len() <= MAX_DETAIL_BYTES {
        detail.to_string()
    } else {
        format!(
            "{}…",
            detail.chars().take(MAX_DETAIL_BYTES).collect::<String>()
        )
    }
}

impl<R, H> DockerCompose<R, H>
where
    R: ProcessRunner,
    H: HealthProbe,
{
    pub async fn wait_until_healthy(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        self.revalidate_context().await?;
        let secrets = self.validate_stack_files(paths, state)?;
        let url = format!("{}/healthz", state.backend_url());
        let started = tokio::time::Instant::now();
        loop {
            if self.health_probe.is_healthy(&url).await {
                return Ok(());
            }
            if started.elapsed() >= self.health_timeout {
                let logs = self
                    .checked_stack(
                        self.compose_request(
                            paths,
                            state,
                            "read local backend logs",
                            ["logs", "--no-color", "--tail", "80", "postgres", "sacrum"],
                            self.quick_timeout,
                        ),
                        &secrets,
                    )
                    .await
                    .map(|output| output.summary())
                    .unwrap_or_else(|error| format!("Could not read logs: {error}"));
                return Err(LocalBackendError::HealthTimedOut {
                    url,
                    timeout_seconds: self.health_timeout.as_secs(),
                    logs,
                });
            }
            tokio::time::sleep(self.health_poll_interval).await;
        }
    }

    pub async fn authenticate_backend(
        &self,
        state: &ManagedStackState,
        api_token: &ApiToken,
    ) -> Result<(), LocalBackendError> {
        self.health_probe
            .authenticate(&state.backend_url(), api_token)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use crate::local_backend::command::CommandOutput;
    use crate::local_backend::state::StackKind;
    #[tokio::test]
    async fn health_timeout_returns_bounded_service_logs() {
        let (_temp, paths, state) = stack_fixture(StackKind::Managed);
        let runner = MockRunner::with_outputs([
            CommandOutput::success("unix:///tmp/docker.sock"),
            CommandOutput::success(
                "postgres-password-0123456789abcdef0123456789abcdef\nsecret-key-base-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ),
        ]);
        let controller = controller(runner, MockHealth::with_results([false, false]))
            .with_timeouts(
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_millis(1),
                Duration::from_millis(1),
            );

        let error = controller
            .wait_until_healthy(&paths, &state)
            .await
            .expect_err("health should time out");

        let LocalBackendError::HealthTimedOut { url, logs, .. } = error else {
            panic!("expected health timeout");
        };
        assert_eq!(url, "http://127.0.0.1:4400/healthz");
        assert_eq!(logs.matches("[redacted]").count(), 2, "{logs}");
        assert!(!logs.contains("postgres-password"), "{logs}");
        assert!(!logs.contains("secret-key-base"), "{logs}");
    }

    #[tokio::test]
    async fn health_polling_stops_after_success() {
        let (_temp, paths, state) = stack_fixture(StackKind::Managed);
        let controller = controller(
            MockRunner::with_outputs([CommandOutput::success("unix:///tmp/docker.sock")]),
            MockHealth::with_results([false, true]),
        )
        .with_timeouts(
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_millis(1),
        );

        controller
            .wait_until_healthy(&paths, &state)
            .await
            .expect("health should succeed");
    }
}
