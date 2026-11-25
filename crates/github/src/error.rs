use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum GitHubError {
    /// Neither `GH_TOKEN`/`GITHUB_TOKEN` is set nor is the `gh` CLI installed.
    #[error("GitHub CLI (gh) is not installed or not on PATH")]
    GhMissing,

    /// Authentication is missing, invalid, or expired (`gh auth token` failed or HTTP 401).
    #[error("GitHub authentication expired or unavailable: {message}")]
    AuthExpired { message: String },

    /// `gh` CLI failed due to a non-authentication OS/process/timeout/decode error.
    #[error("GitHub CLI failed: {message}")]
    GhFailed { message: String },

    /// GitHub denied access to the requested resource (HTTP 403 without rate limit).
    #[error("GitHub access denied: {message}")]
    Forbidden { message: String },

    /// GitHub API rate limit reached (HTTP 403/429 with rate limit headers).
    #[error("GitHub API rate limit reached: {message}")]
    RateLimited {
        /// From `retry-after`, else derived from `x-ratelimit-reset`.
        retry_after_secs: Option<u64>,
        message: String,
    },

    #[error("GitHub resource not found: {message}")]
    NotFound { message: String },

    /// Network, TLS, timeout, or unexpected HTTP status (including 5xx) error.
    #[error("GitHub request failed: {message}")]
    Network { message: String },

    /// GraphQL returned an application-level `errors` array even on HTTP 200.
    #[error("GitHub GraphQL error: {message}")]
    GraphQl { message: String },

    /// Response exceeded the size limit or failed JSON decoding.
    #[error("GitHub response could not be decoded: {message}")]
    Decode { message: String },

    #[error("Invalid GitHub request input: {message}")]
    InvalidInput { message: String },
}

const MAX_MESSAGE_CHARS: usize = 300;

/// Trims and truncates untrusted text (GitHub messages, `gh` stderr) so error
/// values stay bounded regardless of what the other side sends.
pub(crate) fn bounded_message(text: &str) -> String {
    let trimmed = text.trim();
    match trimmed.char_indices().nth(MAX_MESSAGE_CHARS) {
        Some((cut, _)) => format!("{}…", &trimmed[..cut]),
        None => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_message_truncates_on_char_boundaries() {
        assert_eq!(bounded_message("  short  "), "short");
        let long = "é".repeat(MAX_MESSAGE_CHARS + 50);
        let bounded = bounded_message(&long);
        assert_eq!(bounded.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert!(bounded.ends_with('…'));
    }
}
