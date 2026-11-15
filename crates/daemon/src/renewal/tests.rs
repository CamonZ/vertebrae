use super::*;
use proptest::prelude::*;
use std::sync::{Arc, Mutex};

const ID: &str = "33333333-3333-3333-3333-333333333333";

fn identity() -> DaemonIdentity {
    DaemonIdentity {
        endpoint: "http://127.0.0.1:1".into(),
        daemon_id: ID.into(),
        access_token: "access-0".into(),
        refresh_token: "refresh-0".into(),
        access_token_expires_at: (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        refresh_token_expires_at: (Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
    }
}

fn fast_policy() -> RenewalPolicy {
    RenewalPolicy {
        initial_retry_delay: Duration::from_millis(1),
        max_retry_delay: Duration::from_millis(2),
        ..Default::default()
    }
}

#[tokio::test]
async fn refresh_posts_only_refresh_token_and_persists_both_tokens() {
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, method, path},
    };
    let server = MockServer::start().await;
    let mut current = identity();
    current.endpoint = server.uri();
    let expiry = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    let refresh_expiry = (Utc::now() + chrono::Duration::days(30)).to_rfc3339();
    Mock::given(method("POST"))
        .and(path("/api/daemon/refresh"))
        .and(body_json(
            serde_json::json!({"daemon_id": ID, "refresh_token": "refresh-0"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "daemon_id": ID, "access_token": "access-1", "access_token_expires_at": expiry,
            "refresh_token": "refresh-1", "refresh_token_expires_at": refresh_expiry
        })))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("daemon.toml");
    crate::config::save_daemon_identity_for_test(&path, &current);
    let renewer = SacrumCredentialRenewer::with_config_path(Some(path.clone())).unwrap();
    let RenewalOutcome::Renewed(next) = renew_with_retry(&renewer, &current, &fast_policy()).await
    else {
        panic!("refresh failed")
    };
    assert_eq!(next.access_token, "access-1");
    assert_eq!(next.refresh_token, "refresh-1");
    assert_eq!(crate::config::load_daemon_identity_for_test(&path), next);
    assert!(
        !server.received_requests().await.unwrap()[0]
            .headers
            .contains_key("authorization")
    );
    let debug = format!("{next:?}");
    assert!(!debug.contains("access-1"));
    assert!(!debug.contains("refresh-1"));
}

#[tokio::test]
async fn rejected_refresh_is_terminal_and_expired_access_can_refresh() {
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers::path};
    let server = MockServer::start().await;
    Mock::given(path("/api/daemon/refresh"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;
    let mut current = identity();
    current.endpoint = server.uri();
    current.access_token_expires_at = (Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
    assert_eq!(
        renew_with_retry(
            &SacrumCredentialRenewer::new().unwrap(),
            &current,
            &fast_policy()
        )
        .await,
        RenewalOutcome::ReenrollmentRequired(ReenrollmentReason::CredentialRejected)
    );
}

#[test]
fn parser_rejects_invalid_pairs_without_echoing_secrets() {
    for body in [
        br#"{"access_token":"private","refresh_token":123}"#.as_slice(),
        b"private",
    ] {
        assert!(
            !parse_renewal(body, Utc::now(), ID)
                .unwrap_err()
                .to_string()
                .contains("private")
        );
    }
    assert_eq!(
        credential_status(
            &(Utc::now() + chrono::Duration::minutes(2)).to_rfc3339(),
            Utc::now(),
            RENEWAL_LEAD
        ),
        CredentialStatus::RenewalDue
    );
}

/// Independent fake Sacrum token ledger. A predecessor survives until the
/// successor is used; refreshing it replaces the unused successor and revokes
/// every previous access token. No real credentials or network are used.
struct Server {
    sequence: usize,
    current: usize,
    predecessor: Option<usize>,
    predecessor_expiry: u64,
    now: u64,
    expiry: u64,
    rejected: bool,
}
impl Server {
    fn refresh(&mut self, token: &str) -> Result<(String, String), RenewalError> {
        let generation: usize = token.strip_prefix("refresh-").unwrap().parse().unwrap();
        let expiry = if generation == self.current {
            self.expiry
        } else if Some(generation) == self.predecessor {
            self.predecessor_expiry
        } else {
            0
        };
        if self.rejected || self.now >= expiry {
            return Err(RenewalError::InvalidCredentials);
        }
        // Using a successor refresh token consumes its predecessor too.
        self.predecessor_expiry = expiry;
        self.sequence += 1;
        self.predecessor = Some(generation);
        self.current = self.sequence;
        self.expiry = self.now + 30 * 86400;
        Ok((
            format!("access-{}", self.current),
            format!("refresh-{}", self.current),
        ))
    }
    fn request(&mut self, token: &str) -> bool {
        if self.rejected || token != format!("access-{}", self.current) {
            return false;
        }
        self.predecessor = None;
        true
    }
    fn accepts_refresh(&self, token: &str) -> bool {
        !self.rejected
            && ((self.now < self.expiry && token == format!("refresh-{}", self.current))
                || (self.now < self.predecessor_expiry
                    && self
                        .predecessor
                        .is_some_and(|p| token == format!("refresh-{p}"))))
    }
}

struct FakeRenewer {
    server: Mutex<Server>,
    saved: Mutex<DaemonIdentity>,
    lose_response: Mutex<bool>,
    fail_write: Mutex<bool>,
}
#[async_trait::async_trait]
impl CredentialRenewer for FakeRenewer {
    async fn renew(&self, current: &DaemonIdentity) -> Result<RenewedCredential, RenewalError> {
        let (access_token, refresh_token) = self
            .server
            .lock()
            .unwrap()
            .refresh(&current.refresh_token)?;
        if std::mem::take(&mut *self.lose_response.lock().unwrap()) {
            return Err(RenewalError::Transient("lost response".into()));
        }
        Ok(RenewedCredential {
            access_token,
            refresh_token,
            access_token_expires_at: (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            refresh_token_expires_at: (Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
        })
    }
    fn persist(&self, previous: &DaemonIdentity, next: &DaemonIdentity) -> Result<(), ConfigError> {
        assert_eq!(*self.saved.lock().unwrap(), *previous);
        if std::mem::take(&mut *self.fail_write.lock().unwrap()) {
            return Err(ConfigError::PersistFailed(
                "simulated crash before persist".into(),
            ));
        }
        *self.saved.lock().unwrap() = next.clone();
        Ok(())
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn command_sequences_preserve_rotation_and_restart_recovery(commands in prop::collection::vec((0u8..9, 0u32..172800), 1..64)) {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let initial = identity();
            let fake = Arc::new(FakeRenewer { server: Mutex::new(Server { sequence: 0, current: 0, predecessor: None, predecessor_expiry: 0, now: 0, expiry: 30*86400, rejected: false }), saved: Mutex::new(initial.clone()), lose_response: Mutex::new(false), fail_write: Mutex::new(false) });
            let mut current = initial; let mut stopped = false; let mut access_expiry = 3600;
            for (command, seconds) in commands {
                let mut refresh = false;
                match command {
                    0 => refresh = fake.server.lock().unwrap().now + 300 >= access_expiry, // timer tick
                    1 => { let mut server = fake.server.lock().unwrap(); server.now += u64::from(seconds); refresh = server.now + 300 >= access_expiry; },
                    2 if !stopped => { // request (or socket connect): access token only
                        let now = fake.server.lock().unwrap().now;
                        let ok = now < access_expiry && fake.server.lock().unwrap().request(&current.access_token);
                        refresh = !ok;
                    }
                    3 => { *fake.lose_response.lock().unwrap() = true; refresh = true; }
                    4 => { fake.server.lock().unwrap().rejected = true; refresh = true; }
                    5 => { // Crash after the server rotates but before local persistence.
                        if !stopped { let _ = fake.server.lock().unwrap().refresh(&current.refresh_token); }
                        current = fake.saved.lock().unwrap().clone(); refresh = true;
                    }
                    6 => { *fake.fail_write.lock().unwrap() = true; refresh = true; }
                    7 => { current = fake.saved.lock().unwrap().clone(); } // crash after persist / restart
                    _ => refresh = true, // explicit 401
                }
                if refresh && !stopped {
                    match renew_with_retry(fake.as_ref(), &current, &fast_policy()).await {
                        RenewalOutcome::Renewed(next) => { current = next; access_expiry = fake.server.lock().unwrap().now + 3600; }
                        RenewalOutcome::ReenrollmentRequired(_) => stopped = true,
                    }
                }
                assert_eq!(*fake.saved.lock().unwrap(), current);
                let server = fake.server.lock().unwrap();
                if !stopped && server.now < server.expiry { assert!(server.accepts_refresh(&current.refresh_token)); }
                if stopped { assert!(!server.accepts_refresh(&current.refresh_token)); }
                assert!(current.access_token.starts_with("access-"));
                assert!(current.refresh_token.starts_with("refresh-"));
            }
        });
    }
}

#[tokio::test]
async fn cancellation_before_persist_and_restart_after_persist_recover_from_disk() {
    let initial = identity();
    let fake = Arc::new(FakeRenewer {
        server: Mutex::new(Server {
            sequence: 0,
            current: 0,
            predecessor: None,
            predecessor_expiry: 0,
            now: 0,
            expiry: 30 * 86400,
            rejected: false,
        }),
        saved: Mutex::new(initial.clone()),
        lose_response: Mutex::new(false),
        fail_write: Mutex::new(true),
    });
    let worker = fake.clone();
    let policy = RenewalPolicy {
        initial_retry_delay: Duration::from_secs(60),
        ..Default::default()
    };
    let attempt =
        tokio::spawn(async move { renew_with_retry(worker.as_ref(), &initial, &policy).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while *fake.fail_write.lock().unwrap() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    attempt.abort();
    assert!(attempt.await.unwrap_err().is_cancelled());
    let stored = fake.saved.lock().unwrap().clone();
    assert_eq!(stored.refresh_token, "refresh-0");
    assert!(
        fake.server
            .lock()
            .unwrap()
            .accepts_refresh(&stored.refresh_token)
    );
    let RenewalOutcome::Renewed(recovered) =
        renew_with_retry(fake.as_ref(), &stored, &fast_policy()).await
    else {
        panic!("restart must recover")
    };
    assert_eq!(recovered.access_token, "access-2");
    // Crash after persist loads the successor, including after its first use.
    assert!(fake.server.lock().unwrap().request(&recovered.access_token));
    let restarted = fake.saved.lock().unwrap().clone();
    assert_eq!(restarted, recovered);
    assert!(
        fake.server
            .lock()
            .unwrap()
            .accepts_refresh(&restarted.refresh_token)
    );
    assert!(!fake.server.lock().unwrap().accepts_refresh("refresh-0"));
}
