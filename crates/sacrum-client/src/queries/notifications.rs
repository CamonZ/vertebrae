//! GraphQL operations for durable project notifications.

pub const NOTIFICATION_FIELDS: &str = r#"
    fragment NotificationFields on Notification {
        id
        project_id
        message
        severity
        inserted_at
        read_at
    }
"#;

pub const PUBLISH_NOTIFICATION: &str = r#"
    mutation PublishNotification($project_id: Uuid4!, $message: String!, $severity: String!) {
        publishNotification(project_id: $project_id, message: $message, severity: $severity) { ...NotificationFields }
    }
"#;

pub const LIST_NOTIFICATIONS: &str = r#"
    query ProjectNotifications($project_id: Uuid4!, $after_inserted_at: Datetime, $after_id: Uuid4, $limit: Int, $unread_only: Boolean) {
        projectNotifications(project_id: $project_id, after_inserted_at: $after_inserted_at, after_id: $after_id, limit: $limit, unread_only: $unread_only) {
            has_more
            notifications { ...NotificationFields }
        }
    }
"#;

pub const MARK_NOTIFICATIONS_READ: &str = r#"
    mutation MarkNotificationsRead($ids: [Uuid4!]!) {
        markNotificationsRead(ids: $ids) { ...NotificationFields }
    }
"#;
