use super::*;
use crate::types::{Notification, NotificationPage};
use vertebrae_core::{NotificationCursor, NotificationPageQuery};

/// Read one page of the active project's notification history, oldest first,
/// starting strictly after the `(after_inserted_at, after_id)` cursor.
#[tauri::command]
#[specta::specta]
pub async fn list_project_notifications(
    state: State<'_, AppState>,
    after_inserted_at: Option<String>,
    after_id: Option<String>,
    limit: Option<u32>,
    unread_only: bool,
) -> Result<NotificationPage, CommandError> {
    let after = match (after_inserted_at, after_id) {
        (Some(inserted_at), Some(id)) => Some(NotificationCursor {
            inserted_at: chrono::DateTime::parse_from_rfc3339(&inserted_at)
                .map_err(|error| CommandError {
                    message: format!("Invalid notification cursor timestamp: {error}"),
                })?
                .to_utc(),
            id,
        }),
        (None, None) => None,
        _ => {
            return Err(CommandError {
                message: "afterInsertedAt and afterId must be provided together".into(),
            });
        }
    };
    let services = state.services.read().await;
    let service = services
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let page = service
        .notifications()
        .list_notifications(NotificationPageQuery {
            after,
            limit: limit.map(|limit| limit as usize),
            unread_only,
        })
        .await?;
    Ok(NotificationPage {
        notifications: page.notifications.into_iter().map(Into::into).collect(),
        has_more: page.has_more,
    })
}

/// Mark notifications read in Sacrum and return the ones that are now read.
#[tauri::command]
#[specta::specta]
pub async fn mark_notifications_read(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Vec<Notification>, CommandError> {
    let services = state.services.read().await;
    let service = services
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .notifications()
        .mark_notifications_read(&ids)
        .await
        .map(|notifications| notifications.into_iter().map(Into::into).collect())
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{
        assert_no_project_error, build_app_with_services, build_app_without_services,
    };
    use crate::types::NotificationSeverity;
    use tauri::Manager;

    async fn publish(app: &tauri::App<tauri::test::MockRuntime>, messages: &[&str]) {
        let app_state = app.state::<AppState>();
        let services = app_state.services.read().await;
        let services = services.as_ref().expect("services initialized");
        for message in messages {
            services
                .notifications()
                .publish_notification(message, vertebrae_core::NotificationSeverity::Success)
                .await
                .expect("publish notification");
        }
    }

    #[tokio::test]
    async fn notification_commands_require_a_selected_project() {
        let app = build_app_without_services();
        assert_no_project_error(
            list_project_notifications(app.state(), None, None, None, false).await,
        );
        assert_no_project_error(mark_notifications_read(app.state(), vec!["id".into()]).await);
    }

    #[tokio::test]
    async fn history_pages_after_a_cursor_and_marks_read() {
        let app = build_app_with_services();
        publish(&app, &["Task [one](vtb://task/1) done", "two", "three"]).await;

        let first = list_project_notifications(app.state(), None, None, Some(2), false)
            .await
            .expect("first page");
        assert!(first.has_more);
        assert_eq!(first.notifications.len(), 2);
        assert_eq!(
            first.notifications[0].message,
            "Task [one](vtb://task/1) done"
        );
        assert_eq!(
            first.notifications[0].severity,
            NotificationSeverity::Success
        );

        let last = &first.notifications[1];
        let rest = list_project_notifications(
            app.state(),
            Some(last.inserted_at.clone()),
            Some(last.id.clone()),
            None,
            false,
        )
        .await
        .expect("next page");
        assert!(!rest.has_more);
        assert_eq!(rest.notifications.len(), 1);

        let read = mark_notifications_read(app.state(), vec![last.id.clone()])
            .await
            .expect("mark read");
        assert_eq!(read.len(), 1);
        assert!(read[0].read_at.is_some());

        let unread = list_project_notifications(app.state(), None, None, None, true)
            .await
            .expect("unread page");
        assert_eq!(unread.notifications.len(), 2);
    }

    #[tokio::test]
    async fn a_half_cursor_is_rejected() {
        let app = build_app_with_services();
        let error = list_project_notifications(app.state(), None, Some("id".into()), None, false)
            .await
            .unwrap_err();
        assert!(error.message.contains("together"), "{}", error.message);
    }
}
