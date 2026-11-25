//! REST transport with conditional requests. A `304 Not Modified` answer does
//! not count against GitHub's primary rate limit, so polling an unchanged
//! resource is free apart from the round trip.

use crate::{
    client::{header_str, map_transport_error, read_checked_response},
    GitHubClient, GitHubError, GitHubToken,
};
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION, ETAG, IF_NONE_MATCH},
    StatusCode,
};
use serde::de::DeserializeOwned;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

/// Bounds memory for cached bodies; the oldest entry is dropped first.
const MAX_CACHED_RESPONSES: usize = 256;

/// The primary rate-limit window reported with a response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitStatus {
    pub remaining: u32,
    /// Seconds until the window resets (0 when already past).
    pub reset_in_secs: u64,
}

impl RateLimitStatus {
    fn from_headers(headers: &HeaderMap) -> Option<Self> {
        let remaining = header_str(headers, "x-ratelimit-remaining")?.parse().ok()?;
        let reset: u64 = header_str(headers, "x-ratelimit-reset")?.parse().ok()?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        Some(Self {
            remaining,
            reset_in_secs: reset.saturating_sub(now),
        })
    }

    /// The tighter of two windows (fewer requests left).
    pub(crate) fn tightest(a: Option<Self>, b: Option<Self>) -> Option<Self> {
        match (a, b) {
            (Some(a), Some(b)) => Some(if b.remaining < a.remaining { b } else { a }),
            (a, b) => a.or(b),
        }
    }
}

struct CachedBody {
    etag: HeaderValue,
    body: Arc<[u8]>,
    inserted: u64,
}

#[derive(Default)]
struct CacheEntries {
    by_url: HashMap<String, CachedBody>,
    inserted: u64,
}

#[derive(Default)]
pub(crate) struct ConditionalCache {
    entries: Mutex<CacheEntries>,
}

impl std::fmt::Debug for ConditionalCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConditionalCache").finish_non_exhaustive()
    }
}

impl ConditionalCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, CacheEntries> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn etag(&self, url: &str) -> Option<HeaderValue> {
        self.lock()
            .by_url
            .get(url)
            .map(|cached| cached.etag.clone())
    }

    fn body(&self, url: &str) -> Option<Arc<[u8]>> {
        self.lock()
            .by_url
            .get(url)
            .map(|cached| cached.body.clone())
    }

    fn store(&self, url: String, etag: HeaderValue, body: Arc<[u8]>) {
        let mut entries = self.lock();
        entries.inserted += 1;
        let inserted = entries.inserted;
        if entries.by_url.len() >= MAX_CACHED_RESPONSES && !entries.by_url.contains_key(&url) {
            if let Some(oldest) = entries
                .by_url
                .iter()
                .min_by_key(|(_, cached)| cached.inserted)
                .map(|(key, _)| key.clone())
            {
                entries.by_url.remove(&oldest);
            }
        }
        entries.by_url.insert(
            url,
            CachedBody {
                etag,
                body,
                inserted,
            },
        );
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().by_url.len()
    }
}

pub(crate) struct RestResponse<T> {
    pub data: T,
    pub rate_limit: Option<RateLimitStatus>,
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

    /// GET with `If-None-Match`; a 304 is answered from the cached body.
    pub(crate) async fn rest_get<T: DeserializeOwned>(
        &self,
        token: &GitHubToken,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<RestResponse<T>, GitHubError> {
        let url = self.rest_url(segments, query)?;
        let key = url.to_string();
        let mut request = self
            .http
            .get(url)
            .header(AUTHORIZATION, format!("Bearer {}", token.expose()));
        if let Some(etag) = self.conditional.etag(&key) {
            request = request.header(IF_NONE_MATCH, etag);
        }
        let response = request.send().await.map_err(map_transport_error)?;
        let rate_limit = RateLimitStatus::from_headers(response.headers());

        let body = if response.status() == StatusCode::NOT_MODIFIED {
            self.conditional
                .body(&key)
                .ok_or_else(|| GitHubError::Decode {
                    message: "GitHub answered 304 for a response that is not cached".into(),
                })?
        } else {
            let etag = response.headers().get(ETAG).cloned();
            let body: Arc<[u8]> = read_checked_response(response).await?.into();
            if let Some(etag) = etag {
                self.conditional.store(key, etag, body.clone());
            }
            body
        };

        let data = serde_json::from_slice(&body).map_err(|err| GitHubError::Decode {
            message: format!("Invalid GitHub REST response JSON: {err}"),
        })?;
        Ok(RestResponse { data, rate_limit })
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
