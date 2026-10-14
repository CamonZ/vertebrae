//! Durable project notifications.
//!
//! A notification is a Markdown message published to a project and owned by
//! the publishing account. Sacrum stores it, broadcasts it on the project
//! channel, serves it as paginated history and keeps its read state. It
//! references nothing else; the message links to entities with
//! `vtb://<type>/<uuid>` URIs.

use std::fmt;
use std::str::FromStr;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{ServiceError, ServiceResult};

/// Sacrum's limit on a notification message, in bytes.
pub const NOTIFICATION_MESSAGE_MAX_BYTES: usize = 4096;

/// Sacrum's limit on a history page and on one mark-read request.
pub const NOTIFICATION_BATCH_MAX: usize = 200;

/// How a notification is styled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationSeverity {
    Info,
    Success,
    Warning,
    Error,
}

impl NotificationSeverity {
    pub const ALL: [Self; 4] = [Self::Info, Self::Success, Self::Warning, Self::Error];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Success => "success",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

impl fmt::Display for NotificationSeverity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for NotificationSeverity {
    type Err = ServiceError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|severity| severity.as_str() == value)
            .ok_or_else(|| {
                ServiceError::InvalidInput(format!(
                    "notification severity must be one of info, success, warning or error, got {value:?}"
                ))
            })
    }
}

/// A published notification as Sacrum stores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    pub project_id: String,
    /// Markdown, exactly as published.
    pub message: String,
    pub severity: NotificationSeverity,
    pub inserted_at: DateTime<Utc>,
    /// When the owner marked it read; `None` while unread.
    pub read_at: Option<DateTime<Utc>>,
}

/// Check a message against Sacrum's rules before sending it.
pub fn validate_notification_message(message: &str) -> ServiceResult<()> {
    if message.trim().is_empty() {
        return Err(ServiceError::InvalidInput(
            "notification message must not be blank".into(),
        ));
    }
    if message.len() > NOTIFICATION_MESSAGE_MAX_BYTES {
        return Err(ServiceError::InvalidInput(format!(
            "notification message must be at most {NOTIFICATION_MESSAGE_MAX_BYTES} bytes, got {}",
            message.len()
        )));
    }
    Ok(())
}

/// Position in a project's notification history, ordered by `inserted_at`
/// and then `id`. A page starts strictly after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationCursor {
    pub inserted_at: DateTime<Utc>,
    pub id: String,
}

/// One history request. `limit` defaults to Sacrum's 50.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationPageQuery {
    pub after: Option<NotificationCursor>,
    pub limit: Option<usize>,
    pub unread_only: bool,
}

/// A page of history, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationPage {
    pub notifications: Vec<Notification>,
    /// True when more notifications follow the last one returned.
    pub has_more: bool,
}

/// Publishing, history and read state for the active project's notifications.
#[async_trait]
pub trait NotificationService: Send + Sync {
    /// Publish a notification to the active project. Each call creates a new
    /// notification.
    async fn publish_notification(
        &self,
        message: &str,
        severity: NotificationSeverity,
    ) -> ServiceResult<Notification>;

    /// Read one page of the active project's notification history.
    async fn list_notifications(
        &self,
        query: NotificationPageQuery,
    ) -> ServiceResult<NotificationPage>;

    /// Mark the caller's notifications among `ids` read and return them.
    /// Unknown IDs are ignored; each notification keeps its first `read_at`.
    async fn mark_notifications_read(&self, ids: &[String]) -> ServiceResult<Vec<Notification>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severities_round_trip_through_their_names() {
        for severity in NotificationSeverity::ALL {
            assert_eq!(
                severity.as_str().parse::<NotificationSeverity>().unwrap(),
                severity
            );
        }
        assert!("fatal".parse::<NotificationSeverity>().is_err());
        assert!("Info".parse::<NotificationSeverity>().is_err());
    }

    #[test]
    fn messages_must_be_present_and_within_the_byte_limit() {
        assert!(validate_notification_message("Task done").is_ok());
        assert!(validate_notification_message(" \n\t").is_err());
        assert!(validate_notification_message(&"a".repeat(NOTIFICATION_MESSAGE_MAX_BYTES)).is_ok());
        // Multibyte characters count by bytes, not characters.
        assert!(validate_notification_message(&"é".repeat(2049)).is_err());
    }
}
