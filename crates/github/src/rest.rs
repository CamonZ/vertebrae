//! REST writes (Actions re-run and cancel) and the rate-limit window GitHub
//! reports in response headers. Reads go through GraphQL.

use crate::{
    client::{header_str, map_transport_error, read_checked_response},
    GitHubClient, GitHubError, GitHubToken,
};
use reqwest::header::{HeaderMap, AUTHORIZATION};
use std::time::{SystemTime, UNIX_EPOCH};

/// The primary rate-limit window reported with a response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitStatus {
    pub remaining: u32,
    /// Seconds until the window resets (0 when already past).
    pub reset_in_secs: u64,
}

impl RateLimitStatus {
    pub(crate) fn from_headers(headers: &HeaderMap) -> Option<Self> {
        let remaining = header_str(headers, "x-ratelimit-remaining")?.parse().ok()?;
        let reset: u64 = header_str(headers, "x-ratelimit-reset")?.parse().ok()?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        Some(Self {
            remaining,
            reset_in_secs: reset.saturating_sub(now),
        })
    }

    /// The tighter of two windows (fewer requests left).
    pub fn tightest(a: Option<Self>, b: Option<Self>) -> Option<Self> {
        match (a, b) {
            (Some(a), Some(b)) => Some(if b.remaining < a.remaining { b } else { a }),
            (a, b) => a.or(b),
        }
    }
}

impl GitHubClient {
    /// `segments` are percent-encoded individually, so owner, repository and
    /// ref names can never change the path structure.
    fn rest_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Result<url::Url, GitHubError> {
        let mut url = self.base_url.clone();
        url.path_segments_mut()
            .map_err(|()| GitHubError::InvalidInput {
                message: "GitHub API base URL cannot carry a path".into(),
            })?
            .pop_if_empty()
            .extend(segments);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Ok(url)
    }

    /// POST without a body; any 2xx counts as accepted.
    pub(crate) async fn rest_post_empty(
        &self,
        token: &GitHubToken,
        segments: &[&str],
    ) -> Result<(), GitHubError> {
        let url = self.rest_url(segments, &[])?;
        let response = self
            .http
            .post(url)
            .header(AUTHORIZATION, format!("Bearer {}", token.expose()))
            .send()
            .await
            .map_err(map_transport_error)?;
        read_checked_response(response).await.map(|_| ())
    }
}
