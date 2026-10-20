//! Automatic renewal of the enrolled daemon's reconnect credential.
//!
//! Renewal is always enabled. Sacrum issues a fresh 30-day successor through
//! `renewDaemonCredential`; the predecessor stays valid until the successor
//! is first used, so a lost response or failed local write is retried with the
//! credential that is still persisted.
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::StreamExt;
use serde::Deserialize;

use crate::config::{ConfigError, DaemonIdentity};

/// Renew once less than this much credential lifetime remains.
pub const RENEWAL_LEAD: Duration = Duration::from_secs(24 * 60 * 60);
/// Wall-clock recheck period; monotonic timers do not advance while a host sleeps.
pub const RENEWAL_CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);
const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(5);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(15 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024;
const RENEW_MUTATION: &str =
    "mutation RenewDaemonCredential { renewDaemonCredential { reconnectToken expiresAt } }";

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
pub fn credential_status(expires_at: &str, now: DateTime<Utc>, lead: Duration) -> CredentialStatus {
    let Ok(expires_at) = DateTime::parse_from_rfc3339(expires_at) else {
        return CredentialStatus::RenewalDue;
    };
    let remaining = expires_at.with_timezone(&Utc) - now;
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
            Self::Expired => "the reconnect credential has expired",
            Self::CredentialRejected => "Sacrum rejected the reconnect credential",
            Self::IdentityRetired => "the daemon identity was not found or was deregistered",
        })
    }
}

/// Records why the supervisor stopped for re-enrollment so the process can
/// wait for a new credential instead of exiting into a service-manager restart loop.
#[derive(Clone, Debug, Default)]
pub struct ReenrollmentSignal(std::sync::Arc<std::sync::OnceLock<ReenrollmentReason>>);

impl ReenrollmentSignal {
    /// The first reason wins; later reports describe the same stopped daemon.
    pub fn set(&self, reason: ReenrollmentReason) {
        let _ = self.0.set(reason);
    }

    pub fn get(&self) -> Option<ReenrollmentReason> {
        self.0.get().copied()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RenewalError {
    #[error("reconnect credential was rejected")]
    InvalidCredentials,
    #[error("credential renewal is temporarily unavailable: {0}")]
    Transient(String),
}

#[derive(Clone, PartialEq, Eq)]
pub struct RenewedCredential {
    pub reconnect_token: String,
    pub expires_at: String,
}

impl std::fmt::Debug for RenewedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RenewedCredential")
            .field("reconnect_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
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
struct GraphqlEnvelope {
    data: Option<RenewalData>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenewalData {
    renew_daemon_credential: Option<RenewalPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenewalPayload {
    reconnect_token: String,
    expires_at: String,
}

#[derive(Deserialize)]
struct GraphqlError {
    code: Option<String>,
}

#[async_trait::async_trait]
impl CredentialRenewer for SacrumCredentialRenewer {
    async fn renew(&self, current: &DaemonIdentity) -> Result<RenewedCredential, RenewalError> {
        let url = format!("{}/graphql", current.endpoint.trim_end_matches('/'));
        let response = self
            .client
            .post(url)
            .bearer_auth(&current.reconnect_token)
            .header("x-daemon-id", &current.daemon_id)
            .json(&serde_json::json!({ "query": RENEW_MUTATION, "variables": {} }))
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
        parse_renewal(&body, Utc::now())
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
fn parse_renewal(body: &[u8], now: DateTime<Utc>) -> Result<RenewedCredential, RenewalError> {
    let malformed =
        |reason: &str| RenewalError::Transient(format!("malformed renewal response: {reason}"));
    let envelope: GraphqlEnvelope =
        serde_json::from_slice(body).map_err(|_| malformed("invalid JSON"))?;
    if envelope
        .errors
        .iter()
        .any(|error| error.code.as_deref() == Some("invalid_credentials"))
    {
        return Err(RenewalError::InvalidCredentials);
    }
    if !envelope.errors.is_empty() {
        let codes: Vec<_> = envelope
            .errors
            .iter()
            .map(|error| error.code.as_deref().unwrap_or("unknown"))
            .collect();
        return Err(RenewalError::Transient(format!(
            "renewal returned error codes {codes:?}"
        )));
    }
    let payload = envelope
        .data
        .and_then(|data| data.renew_daemon_credential)
        .ok_or_else(|| malformed("missing renewDaemonCredential"))?;
    if payload.reconnect_token.is_empty() || payload.reconnect_token.len() > 512 {
        return Err(malformed("invalid reconnect credential"));
    }
    let expires_at = DateTime::parse_from_rfc3339(&payload.expires_at)
        .map_err(|_| malformed("expiry was not RFC 3339"))?;
    if expires_at.with_timezone(&Utc) <= now {
        return Err(malformed("expiry is not in the future"));
    }
    Ok(RenewedCredential {
        reconnect_token: payload.reconnect_token,
        expires_at: payload.expires_at,
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
    let mut delay = policy.initial_retry_delay;
    loop {
        if credential_status(&current.expires_at, Utc::now(), policy.lead)
            == CredentialStatus::Expired
        {
            return RenewalOutcome::ReenrollmentRequired(ReenrollmentReason::Expired);
        }
        match renewer.renew(current).await {
            Ok(renewed) => {
                let next = DaemonIdentity {
                    reconnect_token: renewed.reconnect_token,
                    expires_at: renewed.expires_at,
                    ..current.clone()
                };
                match renewer.persist(current, &next) {
                    Ok(()) => return RenewalOutcome::Renewed(next),
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
        tokio::time::sleep(jittered(delay).min(time_until_expiry(&current.expires_at))).await;
        delay = crate::connection::next_backoff(delay, policy.max_retry_delay);
    }
}

/// Uniform jitter in `[delay / 2, delay)`, matching socket reconnect backoff.
fn jittered(delay: Duration) -> Duration {
    let half_ms = (delay.as_millis() / 2).max(1);
    Duration::from_millis((half_ms + uuid::Uuid::new_v4().as_u128() % half_ms) as u64)
}

fn time_until_expiry(expires_at: &str) -> Duration {
    DateTime::parse_from_rfc3339(expires_at)
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
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const DAEMON_ID: &str = "33333333-3333-3333-3333-333333333333";

    fn identity(endpoint: &str, token: &str, expires_at: DateTime<Utc>) -> DaemonIdentity {
        DaemonIdentity {
            endpoint: endpoint.to_string(),
            daemon_id: DAEMON_ID.to_string(),
            reconnect_token: token.to_string(),
            expires_at: expires_at.to_rfc3339(),
        }
    }

    fn fast_policy() -> RenewalPolicy {
        RenewalPolicy {
            initial_retry_delay: Duration::from_millis(2),
            max_retry_delay: Duration::from_millis(8),
            ..RenewalPolicy::default()
        }
    }

    #[test]
    fn default_policy_renews_within_the_last_day() {
        assert_eq!(RenewalPolicy::default().lead, Duration::from_secs(86_400));
        let now = Utc::now();
        let lead = RenewalPolicy::default().lead;
        let status = |hours: i64| {
            credential_status(
                &(now + chrono::Duration::hours(hours)).to_rfc3339(),
                now,
                lead,
            )
        };
        assert_eq!(status(30 * 24), CredentialStatus::Valid);
        assert_eq!(status(25), CredentialStatus::Valid);
        assert_eq!(status(23), CredentialStatus::RenewalDue);
        assert_eq!(status(-1), CredentialStatus::Expired);
        assert_eq!(
            credential_status("not-a-date", now, lead),
            CredentialStatus::RenewalDue
        );
    }

    #[test]
    fn response_parsing_classifies_codes_and_never_echoes_the_body() {
        let now = Utc::now();
        let future = (now + chrono::Duration::days(30)).to_rfc3339();
        let renewed = parse_renewal(
            format!(r#"{{"data":{{"renewDaemonCredential":{{"reconnectToken":"next-secret","expiresAt":"{future}"}}}}}}"#)
                .as_bytes(),
            now,
        )
        .unwrap();
        assert_eq!(renewed.reconnect_token, "next-secret");
        assert!(!format!("{renewed:?}").contains("next-secret"));

        assert!(matches!(
            parse_renewal(
                br#"{"data":null,"errors":[{"message":"no","code":"invalid_credentials"}]}"#,
                now
            ),
            Err(RenewalError::InvalidCredentials)
        ));
        assert!(matches!(
            parse_renewal(
                br#"{"data":null,"errors":[{"message":"later","code":"unavailable"}]}"#,
                now
            ),
            Err(RenewalError::Transient(_))
        ));
        let malformed = parse_renewal(br#"{"reconnectToken":"leaky-secret""#, now).unwrap_err();
        assert!(!malformed.to_string().contains("leaky-secret"));
        let past = (now - chrono::Duration::days(1)).to_rfc3339();
        assert!(matches!(
            parse_renewal(
                format!(r#"{{"data":{{"renewDaemonCredential":{{"reconnectToken":"t","expiresAt":"{past}"}}}}}}"#).as_bytes(),
                now
            ),
            Err(RenewalError::Transient(_))
        ));
    }

    async fn sacrum_with(responses: Vec<wiremock::ResponseTemplate>) -> wiremock::MockServer {
        use wiremock::matchers::{header, method, path};
        let server = wiremock::MockServer::start().await;
        let remaining = Mutex::new(responses.into_iter());
        wiremock::Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(header("authorization", "Bearer current-secret"))
            .and(header("x-daemon-id", DAEMON_ID))
            .respond_with(move |_: &wiremock::Request| {
                remaining
                    .lock()
                    .unwrap()
                    .next()
                    .expect("unexpected extra renewal request")
            })
            .mount(&server)
            .await;
        server
    }

    fn renewal_body(token: &str) -> wiremock::ResponseTemplate {
        let expires_at = (Utc::now() + chrono::Duration::days(30)).to_rfc3339();
        wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {"renewDaemonCredential": {"reconnectToken": token, "expiresAt": expires_at}}
        }))
    }

    #[tokio::test]
    async fn transient_failures_back_off_until_renewal_is_persisted() {
        let server = sacrum_with(vec![
            wiremock::ResponseTemplate::new(503)
                .set_body_json(serde_json::json!({"error": "unavailable"})),
            wiremock::ResponseTemplate::new(502),
            wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"data": null, "errors": [{"code": "unavailable"}]}),
            ),
            wiremock::ResponseTemplate::new(200).set_delay(Duration::from_secs(30)),
            renewal_body("renewed-secret"),
        ])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        let current = identity(
            &server.uri(),
            "current-secret",
            Utc::now() + chrono::Duration::hours(2),
        );
        crate::config::save_daemon_identity_for_test(&path, &current);
        let mut renewer = SacrumCredentialRenewer::with_config_path(Some(path.clone())).unwrap();
        renewer.client = reqwest::Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();

        let outcome = renew_with_retry(&renewer, &current, &fast_policy()).await;
        let RenewalOutcome::Renewed(renewed) = outcome else {
            panic!("expected renewal, got {outcome:?}");
        };
        assert_eq!(renewed.reconnect_token, "renewed-secret");
        assert_eq!(
            crate::config::load_daemon_identity_for_test(&path),
            renewed,
            "the renewed credential is what a restart loads"
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 5);
    }

    #[tokio::test]
    async fn rejected_credentials_require_reenrollment_without_retrying() {
        let server = sacrum_with(vec![
            wiremock::ResponseTemplate::new(401)
                .set_body_json(serde_json::json!({"error": "Invalid daemon credentials", "code": "invalid_credentials"})),
        ])
        .await;
        let renewer = SacrumCredentialRenewer::new().unwrap();
        let current = identity(
            &server.uri(),
            "current-secret",
            Utc::now() + chrono::Duration::hours(2),
        );
        assert_eq!(
            renew_with_retry(&renewer, &current, &fast_policy()).await,
            RenewalOutcome::ReenrollmentRequired(ReenrollmentReason::CredentialRejected)
        );
    }

    struct FlakyStorage {
        renewals: AtomicUsize,
        persisted: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl CredentialRenewer for FlakyStorage {
        async fn renew(&self, current: &DaemonIdentity) -> Result<RenewedCredential, RenewalError> {
            assert_eq!(
                current.reconnect_token, "current-secret",
                "retries reuse the predecessor"
            );
            let attempt = self.renewals.fetch_add(1, Ordering::SeqCst);
            Ok(RenewedCredential {
                reconnect_token: format!("successor-{attempt}"),
                expires_at: (Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
            })
        }

        fn persist(&self, _: &DaemonIdentity, renewed: &DaemonIdentity) -> Result<(), ConfigError> {
            if self.renewals.load(Ordering::SeqCst) == 1 {
                return Err(ConfigError::PersistFailed("disk full".to_string()));
            }
            self.persisted
                .lock()
                .unwrap()
                .push(renewed.reconnect_token.clone());
            Ok(())
        }
    }

    #[tokio::test]
    async fn persistence_failure_keeps_the_predecessor_and_retries() {
        let storage = FlakyStorage {
            renewals: AtomicUsize::new(0),
            persisted: Mutex::new(Vec::new()),
        };
        let current = identity(
            "http://127.0.0.1:9",
            "current-secret",
            Utc::now() + chrono::Duration::hours(2),
        );
        let outcome = renew_with_retry(&storage, &current, &fast_policy()).await;
        let RenewalOutcome::Renewed(renewed) = outcome else {
            panic!("expected renewal");
        };
        assert_eq!(renewed.reconnect_token, "successor-1");
        assert_eq!(
            *storage.persisted.lock().unwrap(),
            vec!["successor-1".to_string()]
        );
    }

    #[tokio::test]
    async fn expired_credentials_are_never_sent() {
        let storage = FlakyStorage {
            renewals: AtomicUsize::new(0),
            persisted: Mutex::new(Vec::new()),
        };
        let current = identity(
            "http://127.0.0.1:9",
            "current-secret",
            Utc::now() - chrono::Duration::minutes(1),
        );
        assert_eq!(
            renew_with_retry(&storage, &current, &fast_policy()).await,
            RenewalOutcome::ReenrollmentRequired(ReenrollmentReason::Expired)
        );
        assert_eq!(storage.renewals.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn recovery_instructions_name_the_daemon_without_secrets() {
        let message = reenrollment_instructions("https://sacrum.example.test", DAEMON_ID);
        assert!(message.contains(DAEMON_ID));
        assert!(message.contains("--replace-existing"));
        assert!(message.contains("Re-issue token"));
    }
}
