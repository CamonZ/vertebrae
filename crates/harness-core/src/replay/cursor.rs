//! Opaque paging cursors bound to one transcript revision.
//!
//! A cursor is only meaningful for the exact `(transcript path, revision,
//! projection key)` identity that produced it; decoding against any other
//! identity fails instead of mixing events from different transcript states.

use crate::HarnessError;

/// Where a page boundary sits relative to the retained event window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CursorBoundary<'a> {
    /// The page ends immediately before this event; the next page is older.
    Event(&'a str),
    /// The transcript end has not been normalized yet (deferred tail page).
    TranscriptEnd,
}

pub(crate) fn encode_event_cursor(cache_key: &str, before_event_id: &str) -> String {
    format!("{cache_key}:event:{before_event_id}")
}

pub(crate) fn encode_deferred_cursor(cache_key: &str) -> String {
    format!("{cache_key}:end")
}

pub(crate) fn decode_cursor<'a>(
    cursor: &'a str,
    expected_cache_key: &str,
) -> Result<CursorBoundary<'a>, HarnessError> {
    let Some(boundary) = cursor
        .strip_prefix(expected_cache_key)
        .and_then(|value| value.strip_prefix(':'))
    else {
        return Err(HarnessError::InvalidRequest(
            "transcript replay cursor no longer matches the transcript revision".into(),
        ));
    };
    if boundary == "end" {
        return Ok(CursorBoundary::TranscriptEnd);
    }
    let Some(event_id) = boundary.strip_prefix("event:") else {
        return Err(HarnessError::InvalidRequest(
            "malformed transcript replay cursor".into(),
        ));
    };
    if event_id.is_empty() {
        return Err(HarnessError::InvalidRequest(
            "malformed transcript replay cursor".into(),
        ));
    }
    Ok(CursorBoundary::Event(event_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip_event_and_deferred_boundaries() {
        let key = "cursor-test-key";
        let event_cursor = encode_event_cursor(key, "evt-1");
        let event = decode_cursor(&event_cursor, key).unwrap();
        assert_eq!(event, CursorBoundary::Event("evt-1"));
        let deferred_cursor = encode_deferred_cursor(key);
        let deferred = decode_cursor(&deferred_cursor, key).unwrap();
        assert_eq!(deferred, CursorBoundary::TranscriptEnd);
    }

    #[test]
    fn cursors_reject_foreign_keys_malformed_and_empty_boundaries() {
        let key = "cursor-test-key";
        assert!(decode_cursor("v1-other:event:evt-1", key).is_err());
        assert!(decode_cursor(&format!("{key}:unknown"), key).is_err());
        assert!(decode_cursor(&format!("{key}:event:"), key).is_err());
    }
}
