use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum GitHubError {
    #[error("GitHub CLI (gh) is not installed or not on PATH")]
    GhMissing,

    #[error("GitHub authentication expired or unavailable: {message}")]
    AuthExpired { message: String },

    #[error("GitHub CLI failed: {message}")]
    GhFailed { message: String },

    #[error("GitHub access denied: {message}")]
    Forbidden { message: String },

    #[error("GitHub API rate limit reached: {message}")]
    RateLimited {
        retry_after_secs: Option<u64>,
        message: String,
    },

    #[error("GitHub resource not found: {message}")]
    NotFound { message: String },

    #[error("GitHub request failed: {message}")]
    Network { message: String },

    #[error("GitHub GraphQL error: {message}")]
    GraphQl { message: String },

    #[error("GitHub response could not be decoded: {message}")]
    Decode { message: String },

    #[error("Invalid GitHub request input: {message}")]
    InvalidInput { message: String },
}

pub(crate) const MAX_MESSAGE_CHARS: usize = 300;

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
