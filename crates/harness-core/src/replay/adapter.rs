//! Helpers shared by provider adapters implementing the replay contract.
//!
//! Transcript discovery and record decoding are adapter-owned, but the safety
//! checks around provider-supplied identifiers and the durable record
//! timestamp convention are provider-neutral: one copy lives here so a fix in
//! one adapter cannot drift from the other.

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, Utc};
use serde_json::Value;

/// True when a provider-supplied resume identifier is a plain filename and
/// cannot traverse outside the provider transcript root.
pub fn safe_filename(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Canonicalize a discovered transcript and confine it to `root`, rejecting
/// symlinks and traversal that escape the provider transcript tree.
pub fn validated_file(root: &Path, candidate: &Path) -> Option<PathBuf> {
    if !candidate.is_file() {
        return None;
    }
    let canonical_root = fs::canonicalize(root).ok()?;
    let canonical_candidate = fs::canonicalize(candidate).ok()?;
    canonical_candidate
        .starts_with(canonical_root)
        .then_some(canonical_candidate)
}

/// Durable record timestamp: RFC 3339 when the provider wrote one, epoch when
/// the record is malformed or undated, so ordering never depends on parse
/// success.
pub fn record_timestamp(value: &Value) -> DateTime<Utc> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or(DateTime::UNIX_EPOCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filenames_reject_traversal_and_absolute_paths() {
        assert!(safe_filename("session-1"));
        assert!(!safe_filename(""));
        assert!(!safe_filename("../escape"));
        assert!(!safe_filename("/abs"));
        assert!(!safe_filename(".."));
        // Multi-segment relative ids pass the component check; confinement is
        // enforced later by `validated_file`, which canonicalizes and rejects
        // anything outside the provider transcript root.
        assert!(safe_filename("a/b"));
    }

    #[test]
    fn record_timestamps_parse_rfc3339_and_fall_back_to_epoch() {
        let dated = serde_json::json!({"timestamp": "2026-01-01T00:00:00Z"});
        assert_eq!(
            record_timestamp(&dated),
            DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc)
        );
        assert_eq!(
            record_timestamp(&serde_json::json!({"timestamp": "invalid"})),
            DateTime::UNIX_EPOCH
        );
        assert_eq!(
            record_timestamp(&serde_json::json!({})),
            DateTime::UNIX_EPOCH
        );
    }
}
