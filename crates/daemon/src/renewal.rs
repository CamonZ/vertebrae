//! Access-token refresh and crash-safe refresh-token rotation.
//!
//! Renewal is always enabled. Sacrum issues a fresh pair through
//! `POST /api/daemon/refresh`; the predecessor refresh token stays valid until its successor
//! is first used, so a lost response or failed local write is retried with the
//! credential that is still persisted.
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::StreamExt;
use serde::Deserialize;

use crate::config::{ConfigError, DaemonIdentity};

/// Renew once less than this much credential lifetime remains.
pub const RENEWAL_LEAD: Duration = Duration::from_secs(5 * 60);
/// Wall-clock recheck period; monotonic timers do not advance while a host sleeps.
pub const RENEWAL_CHECK_INTERVAL: Duration = Duration::from_secs(60);
const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(5);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(15 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024;
/// Renewal timing. The default applies to every enrolled daemon; there is no
/// setting that disables renewal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenewalPolicy {
    pub lead: Duration,
    pub check_interval: Duration,
    pub initial_retry_delay: Duration,
    pub max_retry_delay: Duration,
}

impl Default for RenewalPolicy {
    fn default() -> Self {
        Self {
            lead: RENEWAL_LEAD,
            check_interval: RENEWAL_CHECK_INTERVAL,
            initial_retry_delay: INITIAL_RETRY_DELAY,
            max_retry_delay: MAX_RETRY_DELAY,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialStatus {
    Valid,
    RenewalDue,
    Expired,
}

/// Classify a persisted expiry. An unreadable expiry is renewed so Sacrum,
/// which owns validity, decides whether the credential is still usable.
pub fn credential_status(
    access_token_expires_at: &str,
    now: DateTime<Utc>,
    lead: Duration,
) -> CredentialStatus {
    let Ok(access_token_expires_at) = DateTime::parse_from_rfc3339(access_token_expires_at) else {
        return CredentialStatus::RenewalDue;
    };
    let remaining = access_token_expires_at.with_timezone(&Utc) - now;
    if remaining <= chrono::Duration::zero() {
        CredentialStatus::Expired
    } else if remaining.to_std().is_ok_and(|remaining| remaining < lead) {
        CredentialStatus::RenewalDue
    } else {
        CredentialStatus::Valid
    }
}

/// Why the daemon stopped connecting and is waiting for re-enrollment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReenrollmentReason {
    Expired,
    CredentialRejected,
    IdentityRetired,
}

impl std::fmt::Display for ReenrollmentReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Expired => "the refresh credential has expired",
            Self::CredentialRejected => "Sacrum rejected the refresh credential",
            Self::IdentityRetired => "the daemon identity was not found or was deregistered",
        })
    }
}

/// Records why the supervisor stopped for re-enrollment so the process can
/// wait for a new credential instead of exiting into a service-manager restart loop.
#[derive(Clone, Debug, Default)]
pub struct ReenrollmentSignal(
    std::sync::Arc<std::sync::OnceLock<(ReenrollmentReason, Option<DaemonIdentity>)>>,
);

impl ReenrollmentSignal {
    /// The first reason wins; later reports describe the same stopped daemon.
    pub fn set(&self, reason: ReenrollmentReason) {
        let _ = self.0.set((reason, None));
    }

    /// Preserve the last rejected pair, so a supervisor that refreshed during
    /// its lifetime cannot mistake its own saved pair for a new enrollment.
    pub fn set_with_identity(&self, reason: ReenrollmentReason, identity: &DaemonIdentity) {
        let _ = self.0.set((reason, Some(identity.clone())));
    }

    pub fn rejected_identity(&self) -> Option<DaemonIdentity> {
        self.0.get().and_then(|(_, identity)| identity.clone())
    }

    pub fn get(&self) -> Option<ReenrollmentReason> {
        self.0.get().map(|(reason, _)| *reason)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RenewalError {
    #[error("refresh credential was rejected")]
    InvalidCredentials,
    #[error("credential renewal is temporarily unavailable: {0}")]
    Transient(String),
}

#[derive(Clone, PartialEq, Eq)]
pub struct RenewedCredential {
    pub access_token: String,
    pub refresh_token: String,
    pub refresh_token_expires_at: String,
    pub access_token_expires_at: String,
}

impl std::fmt::Debug for RenewedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RenewedCredential")
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("access_token_expires_at", &"<redacted>")
            .field("refresh_token_expires_at", &"<redacted>")
            .finish()
    }
}

/// Obtains and stores successor credentials. Production renews through
/// Sacrum and persists to `daemon.toml`; tests substitute both halves.
#[async_trait::async_trait]
pub trait CredentialRenewer: Send + Sync {
    async fn renew(&self, current: &DaemonIdentity) -> Result<RenewedCredential, RenewalError>;
    fn persist(
        &self,
        previous: &DaemonIdentity,
        renewed: &DaemonIdentity,
    ) -> Result<(), ConfigError>;
}

pub struct SacrumCredentialRenewer {
    client: reqwest::Client,
    config_path: Option<PathBuf>,
}

impl Default for SacrumCredentialRenewer {
    fn default() -> Self {
        Self::new().expect("default renewal client must have valid settings")
    }
}

impl SacrumCredentialRenewer {
    pub fn new() -> Result<Self, RenewalError> {
        Self::with_config_path(None)
    }

    fn with_config_path(config_path: Option<PathBuf>) -> Result<Self, RenewalError> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| RenewalError::Transient(error.to_string()))?;
        Ok(Self {
            client,
            config_path,
        })
    }
}

#[derive(Deserialize)]
struct RenewalPayload {
    daemon_id: String,
    access_token: String,
    access_token_expires_at: String,
    refresh_token: String,
    refresh_token_expires_at: String,
}

#[async_trait::async_trait]
impl CredentialRenewer for SacrumCredentialRenewer {
    async fn renew(&self, current: &DaemonIdentity) -> Result<RenewedCredential, RenewalError> {
        let url = format!(
            "{}/api/daemon/refresh",
            current.endpoint.trim_end_matches('/')
        );
        let response = self
            .client
            .post(url)
            .json(&serde_json::json!({ "daemon_id": current.daemon_id, "refresh_token": current.refresh_token }))
            .send()
            .await
            .map_err(|error| RenewalError::Transient(error.without_url().to_string()))?;
        let status = response.status();
        if matches!(status.as_u16(), 401 | 403) {
            return Err(RenewalError::InvalidCredentials);
        }
        if !status.is_success() {
            return Err(RenewalError::Transient(format!("HTTP status {status}")));
        }
        let body = read_bounded(response).await?;
        parse_renewal(&body, Utc::now(), &current.daemon_id)
    }

    fn persist(
        &self,
        previous: &DaemonIdentity,
        renewed: &DaemonIdentity,
    ) -> Result<(), ConfigError> {
        match &self.config_path {
            Some(path) => crate::config::persist_renewed_credential_at(path, previous, renewed),
            None => crate::config::persist_renewed_credential(previous, renewed),
        }
    }
}

async fn read_bounded(response: reqwest::Response) -> Result<Vec<u8>, RenewalError> {
    let too_large = || RenewalError::Transient("renewal response exceeded 16 KiB".to_string());
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| RenewalError::Transient(error.to_string()))?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

// Parser errors never include the body: a successful response carries the secret.
fn parse_renewal(
    body: &[u8],
    now: DateTime<Utc>,
    daemon_id: &str,
) -> Result<RenewedCredential, RenewalError> {
    let malformed =
        |reason: &str| RenewalError::Transient(format!("malformed renewal response: {reason}"));
    let payload: RenewalPayload = serde_json::from_slice(body)
        .map_err(|_| malformed("invalid JSON or missing token pair"))?;
    if payload.daemon_id != daemon_id {
        return Err(malformed("daemon identity mismatch"));
    }
    for token in [&payload.access_token, &payload.refresh_token] {
        if token.is_empty() || token.len() > 512 {
            return Err(malformed("invalid token"));
        }
    }
    for expiry in [
        &payload.access_token_expires_at,
        &payload.refresh_token_expires_at,
    ] {
        let expiry = DateTime::parse_from_rfc3339(expiry)
            .map_err(|_| malformed("expiry was not RFC 3339"))?;
        if expiry.with_timezone(&Utc) <= now {
            return Err(malformed("expiry is not in the future"));
        }
    }
    Ok(RenewedCredential {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        refresh_token_expires_at: payload.refresh_token_expires_at,
        access_token_expires_at: payload.access_token_expires_at,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum RenewalOutcome {
    Renewed(DaemonIdentity),
    ReenrollmentRequired(ReenrollmentReason),
}

/// Renew and persist `current`, retrying transient failures with capped,
/// jittered backoff until success or expiry. Persistence failures keep the
/// previous credential in use; the retry asks Sacrum to replace the unused
/// successor.
pub async fn renew_with_retry(
    renewer: &dyn CredentialRenewer,
    current: &DaemonIdentity,
    policy: &RenewalPolicy,
) -> RenewalOutcome {
    tracing::info!(daemon_id = %current.daemon_id, "Refreshing daemon access credential before expiry");
    let mut delay = policy.initial_retry_delay;
    loop {
        if credential_status(&current.refresh_token_expires_at, Utc::now(), policy.lead)
            == CredentialStatus::Expired
        {
            return RenewalOutcome::ReenrollmentRequired(ReenrollmentReason::Expired);
        }
        match renewer.renew(current).await {
            Ok(renewed) => {
                let next = DaemonIdentity {
                    access_token: renewed.access_token,
                    refresh_token: renewed.refresh_token,
                    refresh_token_expires_at: renewed.refresh_token_expires_at,
                    access_token_expires_at: renewed.access_token_expires_at,
                    ..current.clone()
                };
                match renewer.persist(current, &next) {
                    Ok(()) => {
                        tracing::info!(daemon_id = %current.daemon_id, "Daemon access credential renewed");
                        return RenewalOutcome::Renewed(next);
                    }
                    Err(error) => tracing::warn!(
                        daemon_id = %current.daemon_id,
                        %error,
                        "Renewed credential could not be saved; keeping the current credential and retrying"
                    ),
                }
            }
            Err(RenewalError::InvalidCredentials) => {
                return RenewalOutcome::ReenrollmentRequired(
                    ReenrollmentReason::CredentialRejected,
                );
            }
            Err(error) => tracing::warn!(
                daemon_id = %current.daemon_id,
                %error,
                "Credential renewal failed; retrying with capped backoff"
            ),
        }
        tokio::time::sleep(
            jittered(delay).min(time_until_expiry(&current.refresh_token_expires_at)),
        )
        .await;
        delay = crate::connection::next_backoff(delay, policy.max_retry_delay);
    }
}

/// Uniform jitter in `[delay / 2, delay)`, matching socket reconnect backoff.
fn jittered(delay: Duration) -> Duration {
    let half_ms = (delay.as_millis() / 2).max(1);
    Duration::from_millis((half_ms + uuid::Uuid::new_v4().as_u128() % half_ms) as u64)
}

fn time_until_expiry(access_token_expires_at: &str) -> Duration {
    DateTime::parse_from_rfc3339(access_token_expires_at)
        .ok()
        .and_then(|expiry| (expiry.with_timezone(&Utc) - Utc::now()).to_std().ok())
        .unwrap_or(Duration::ZERO)
}

/// The operator recovery message. It names the daemon but never a credential.
pub fn reenrollment_instructions(identity_endpoint: &str, daemon_id: &str) -> String {
    format!(
        "Open Daemons in the Vertebrae GUI, select daemon {daemon_id}, and choose Re-issue token. \
         Then run `vtb-daemon enroll --endpoint '{identity_endpoint}' --daemon-id '{daemon_id}' \
         --token-stdin --replace-existing < /path/to/protected-bootstrap-token`. \
         This daemon resumes automatically once the new credential is saved."
    )
}

#[cfg(test)]
mod tests;
