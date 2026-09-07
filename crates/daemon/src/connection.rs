//! Connection attempts and recovery policy for both daemon authentication modes.
use crate::actors::DaemonAuthentication;
use crate::phoenix::{PhoenixError, PhoenixSocket};
use std::time::Duration;

pub(crate) const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(100);
pub(crate) const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

pub(crate) async fn connect_with_auth(
    base_url: &str,
    authentication: &DaemonAuthentication,
) -> Result<PhoenixSocket, crate::phoenix::PhoenixError> {
    match authentication {
        DaemonAuthentication::AccountToken(token) => PhoenixSocket::connect(base_url, token).await,
        DaemonAuthentication::Standalone(identity) => {
            PhoenixSocket::connect_daemon(base_url, &identity.daemon_id, &identity.reconnect_token)
                .await
        }
    }
}

/// Compute the next backoff delay by doubling `current`, capped at `max`.
pub(crate) fn next_backoff(current: Duration, max: Duration) -> Duration {
    // Saturating mul avoids overflow; min caps at the ceiling.
    current.saturating_mul(2).min(max)
}

/// Transient outages have no attempt limit. Each connection attempt has its own
/// transport timeout; dropping this future cancels the next attempt/backoff.
pub(crate) async fn reconnect(
    base_url: &str,
    authentication: &DaemonAuthentication,
    initial_delay: Duration,
    max_delay: Duration,
) -> Result<PhoenixSocket, PhoenixError> {
    let mut delay = initial_delay;
    loop {
        let half_ms = (delay.as_millis() / 2).max(1);
        let jittered =
            Duration::from_millis((half_ms + uuid::Uuid::new_v4().as_u128() % half_ms) as u64);
        tokio::time::sleep(jittered).await;
        match connect_with_auth(base_url, authentication).await {
            Ok(socket) => return Ok(socket),
            Err(
                error @ (PhoenixError::AuthenticationRejected
                | PhoenixError::Url(_)
                | PhoenixError::Protocol(_)),
            ) => return Err(error),
            Err(error) => {
                tracing::warn!(%error, "Connection failed; retrying with capped backoff");
                delay = next_backoff(delay, max_delay);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // A local HTTP peer exercises the real WebSocket handshake/error mapping.
    async fn reject(listener: &tokio::net::TcpListener, status: &str) {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 4096];
        stream.read(&mut request).await.unwrap();
        stream
            .write_all(
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        stream.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn reconnect_survives_more_than_ten_transient_failures() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for _ in 0..12 {
                reject(&listener, "503 Service Unavailable").await;
            }
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        });
        let socket = tokio::time::timeout(
            Duration::from_secs(5),
            reconnect(
                &endpoint,
                &DaemonAuthentication::AccountToken("test-token".to_string()),
                Duration::from_millis(2),
                Duration::from_millis(4),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let peer = server.await.unwrap();
        socket.close().await;
        drop(peer);
    }

    #[tokio::test]
    async fn rejected_credentials_stop_retries() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            reject(&listener, "401 Unauthorized").await;
        });
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            reconnect(
                &endpoint,
                &DaemonAuthentication::AccountToken("test-token".to_string()),
                Duration::from_millis(2),
                Duration::from_millis(4),
            ),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(PhoenixError::AuthenticationRejected)));
        server.await.unwrap();
    }

    // ===== next_backoff tests =====

    #[test]
    fn next_backoff_doubles_delay() {
        let max = Duration::from_secs(30);
        assert_eq!(
            next_backoff(Duration::from_millis(100), max),
            Duration::from_millis(200)
        );
    }

    #[test]
    fn next_backoff_caps_at_max() {
        let max = Duration::from_secs(30);
        assert_eq!(next_backoff(Duration::from_secs(20), max), max);
    }

    #[test]
    fn next_backoff_stays_at_max() {
        let max = Duration::from_secs(30);
        assert_eq!(next_backoff(max, max), max);
    }
}
