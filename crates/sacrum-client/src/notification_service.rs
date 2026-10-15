use crate::client::{GraphqlClient, with_fragments};
use crate::queries::notifications;
use async_trait::async_trait;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::str::FromStr;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::notification_service::{
    NOTIFICATION_BATCH_MAX, Notification, NotificationPage, NotificationPageQuery,
    NotificationService, NotificationSeverity, validate_notification_message,
};

pub struct SacrumNotificationService {
    client: GraphqlClient,
}

#[derive(Debug, Deserialize)]
struct NotificationPageResponse {
    notifications: Vec<Notification>,
    has_more: bool,
}

impl SacrumNotificationService {
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }

    fn id(id: &str, field: &str) -> ServiceResult<String> {
        uuid::Uuid::from_str(id)
            .map(|_| id.to_owned())
            .map_err(|e| ServiceError::InvalidInput(format!("invalid {field}: {e}")))
    }

    fn active_project_id(&self) -> ServiceResult<String> {
        Self::id(self.client.project_id(), "active project id")
    }
}

#[async_trait]
impl NotificationService for SacrumNotificationService {
    async fn publish_notification(
        &self,
        message: &str,
        severity: NotificationSeverity,
    ) -> ServiceResult<Notification> {
        validate_notification_message(message)?;
        let project_id = self.active_project_id()?;
        self.client
            .execute(
                &with_fragments(
                    notifications::PUBLISH_NOTIFICATION,
                    &[notifications::NOTIFICATION_FIELDS],
                ),
                json!({
                    "project_id": project_id,
                    "message": message,
                    "severity": severity.as_str(),
                }),
                "publishNotification",
            )
            .await
            .map_err(ServiceError::from)
    }

    async fn list_notifications(
        &self,
        query: NotificationPageQuery,
    ) -> ServiceResult<NotificationPage> {
        if let Some(limit) = query.limit
            && !(1..=NOTIFICATION_BATCH_MAX).contains(&limit)
        {
            return Err(ServiceError::InvalidInput(format!(
                "notification page limit must be between 1 and {NOTIFICATION_BATCH_MAX}, got {limit}"
            )));
        }
        let mut variables = Map::new();
        variables.insert("project_id".into(), json!(self.active_project_id()?));
        variables.insert("unread_only".into(), json!(query.unread_only));
        // Omitted rather than null: Sacrum treats an explicit null cursor
        // argument as supplied.
        if let Some(cursor) = query.after {
            variables.insert(
                "after_inserted_at".into(),
                json!(
                    cursor
                        .inserted_at
                        .to_rfc3339_opts(SecondsFormat::Micros, true)
                ),
            );
            variables.insert(
                "after_id".into(),
                json!(Self::id(&cursor.id, "notification cursor id")?),
            );
        }
        if let Some(limit) = query.limit {
            variables.insert("limit".into(), json!(limit));
        }
        let page: NotificationPageResponse = self
            .client
            .execute(
                &with_fragments(
                    notifications::LIST_NOTIFICATIONS,
                    &[notifications::NOTIFICATION_FIELDS],
                ),
                Value::Object(variables),
                "projectNotifications",
            )
            .await
            .map_err(ServiceError::from)?;
        Ok(NotificationPage {
            notifications: page.notifications,
            has_more: page.has_more,
        })
    }

    async fn mark_notifications_read(&self, ids: &[String]) -> ServiceResult<Vec<Notification>> {
        if ids.is_empty() || ids.len() > NOTIFICATION_BATCH_MAX {
            return Err(ServiceError::InvalidInput(format!(
                "mark read takes between 1 and {NOTIFICATION_BATCH_MAX} notification IDs, got {}",
                ids.len()
            )));
        }
        let ids = ids
            .iter()
            .map(|id| Self::id(id, "notification id"))
            .collect::<ServiceResult<Vec<_>>>()?;
        self.client
            .execute(
                &with_fragments(
                    notifications::MARK_NOTIFICATIONS_READ,
                    &[notifications::NOTIFICATION_FIELDS],
                ),
                json!({ "ids": ids }),
                "markNotificationsRead",
            )
            .await
            .map_err(ServiceError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SacrumConfig;
    use chrono::{TimeZone, Utc};
    use vertebrae_core::notification_service::NotificationCursor;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const PROJECT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const NOTIFICATION_ID: &str = "0aec77c7-319d-449d-a3b3-d6d8cdb6ffad";
    const MESSAGE: &str =
        "Task [Ship *it*](vtb://task/3f1d9f6e-5c1b-4f8e-9f55-0b6f0c7d2a11) has completed.";

    fn service(server: &MockServer) -> SacrumNotificationService {
        SacrumNotificationService::new(GraphqlClient::new(SacrumConfig::new(
            server.uri(),
            "test-token".into(),
            PROJECT_ID.into(),
        )))
    }

    fn notification_json(read_at: Value) -> Value {
        json!({
            "id": NOTIFICATION_ID,
            "project_id": PROJECT_ID,
            "message": MESSAGE,
            "severity": "success",
            "inserted_at": "2026-10-14T20:37:02.698001Z",
            "read_at": read_at,
        })
    }

    async fn respond(server: &MockServer, field: &str, data: Value) {
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": {field: data}})))
            .mount(server)
            .await;
    }

    async fn sent_variables(server: &MockServer) -> Value {
        let requests: Vec<Request> = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        requests[0].body_json::<Value>().unwrap()["variables"].clone()
    }

    #[tokio::test]
    async fn publish_sends_the_active_project_and_returns_the_notification() {
        let server = MockServer::start().await;
        respond(
            &server,
            "publishNotification",
            notification_json(Value::Null),
        )
        .await;

        let published = service(&server)
            .publish_notification(MESSAGE, NotificationSeverity::Success)
            .await
            .unwrap();

        assert_eq!(
            sent_variables(&server).await,
            json!({"project_id": PROJECT_ID, "message": MESSAGE, "severity": "success"})
        );
        assert_eq!(published.id, NOTIFICATION_ID);
        assert_eq!(published.message, MESSAGE);
        assert_eq!(published.severity, NotificationSeverity::Success);
        assert_eq!(
            published.inserted_at,
            Utc.with_ymd_and_hms(2026, 10, 14, 20, 37, 2).unwrap()
                + chrono::Duration::microseconds(698_001)
        );
        assert_eq!(published.read_at, None);
    }

    #[tokio::test]
    async fn publish_rejects_invalid_messages_before_any_request() {
        let server = MockServer::start().await;
        let service = service(&server);

        for message in [String::from("  "), "a".repeat(4097)] {
            let error = service
                .publish_notification(&message, NotificationSeverity::Info)
                .await
                .unwrap_err();
            assert!(matches!(error, ServiceError::InvalidInput(_)), "{error:?}");
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn publish_surfaces_a_foreign_project_as_invalid_input() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {"publishNotification": null},
                "errors": [{"message": "project_id: does not exist", "path": ["publishNotification"]}]
            })))
            .mount(&server)
            .await;

        let error = service(&server)
            .publish_notification(MESSAGE, NotificationSeverity::Info)
            .await
            .unwrap_err();

        assert!(
            matches!(&error, ServiceError::InvalidInput(message) if message.contains("does not exist")),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn the_first_page_omits_the_cursor_and_limit() {
        let server = MockServer::start().await;
        respond(
            &server,
            "projectNotifications",
            json!({"has_more": true, "notifications": [notification_json(Value::Null)]}),
        )
        .await;

        let page = service(&server)
            .list_notifications(NotificationPageQuery::default())
            .await
            .unwrap();

        assert_eq!(
            sent_variables(&server).await,
            json!({"project_id": PROJECT_ID, "unread_only": false})
        );
        assert!(page.has_more);
        assert_eq!(page.notifications.len(), 1);
    }

    #[tokio::test]
    async fn a_later_page_sends_the_cursor_with_microseconds() {
        let server = MockServer::start().await;
        respond(
            &server,
            "projectNotifications",
            json!({"has_more": false, "notifications": [notification_json(json!("2026-10-14T21:00:00.000000Z"))]}),
        )
        .await;
        let inserted_at = Utc.with_ymd_and_hms(2026, 10, 14, 20, 37, 2).unwrap();

        let page = service(&server)
            .list_notifications(NotificationPageQuery {
                after: Some(NotificationCursor {
                    inserted_at,
                    id: NOTIFICATION_ID.into(),
                }),
                limit: Some(200),
                unread_only: true,
            })
            .await
            .unwrap();

        assert_eq!(
            sent_variables(&server).await,
            json!({
                "project_id": PROJECT_ID,
                "unread_only": true,
                "after_inserted_at": "2026-10-14T20:37:02.000000Z",
                "after_id": NOTIFICATION_ID,
                "limit": 200,
            })
        );
        assert!(!page.has_more);
        assert!(page.notifications[0].read_at.is_some());
    }

    #[tokio::test]
    async fn out_of_range_limits_and_id_counts_fail_before_any_request() {
        let server = MockServer::start().await;
        let service = service(&server);

        for limit in [0, 201] {
            let error = service
                .list_notifications(NotificationPageQuery {
                    limit: Some(limit),
                    ..Default::default()
                })
                .await
                .unwrap_err();
            assert!(matches!(error, ServiceError::InvalidInput(_)), "{error:?}");
        }
        let too_many = vec![NOTIFICATION_ID.to_string(); 201];
        for ids in [&[][..], &too_many[..], &["not-a-uuid".to_string()][..]] {
            let error = service.mark_notifications_read(ids).await.unwrap_err();
            assert!(matches!(error, ServiceError::InvalidInput(_)), "{error:?}");
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn mark_read_returns_the_read_notifications() {
        let server = MockServer::start().await;
        respond(
            &server,
            "markNotificationsRead",
            json!([notification_json(json!("2026-10-14T21:00:00Z"))]),
        )
        .await;

        let read = service(&server)
            .mark_notifications_read(&[NOTIFICATION_ID.to_string()])
            .await
            .unwrap();

        assert_eq!(
            sent_variables(&server).await,
            json!({"ids": [NOTIFICATION_ID]})
        );
        assert_eq!(read.len(), 1);
        assert_eq!(
            read[0].read_at,
            Some(Utc.with_ymd_and_hms(2026, 10, 14, 21, 0, 0).unwrap())
        );
    }
}
