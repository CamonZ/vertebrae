//! `vtb::notifications`: `send` publishes a Markdown notification to the
//! execution's project, and `escape` makes text safe to place inside one.
//!
//! The message is published exactly as the script composed it; links to
//! entities are ordinary Markdown links to `vtb://<type>/<uuid>` URIs. Each
//! call creates a new notification, so a rerun sends again.

use rhai::{Dynamic, Map, Module};
use vertebrae_core::{Notification, NotificationSeverity, validate_notification_message};

use super::{map_argument, set_host_fn, string_argument, timestamp};
use crate::script_worker::{HostContext, HostError};

const NAMESPACE: &str = "vtb::notifications";

/// Punctuation that can change how inline text, such as a link label,
/// renders: emphasis, code, links, autolinks, images, table cells and
/// strikethrough. Characters that only matter at the start of a line, like
/// `#` or `-`, are left alone.
const MARKDOWN_PUNCTUATION: &str = "\\`*_[]()<>!|~";

pub(super) fn module(host: &HostContext) -> Module {
    let mut module = Module::new();
    set_host_fn(&mut module, host, NAMESPACE, "send", send);
    module.set_native_fn("escape", |text: Dynamic| {
        string_argument(text, "Text")
            .map(|text| Dynamic::from(escape(&text)))
            .map_err(|error| error.in_function(format!("{NAMESPACE}::escape")).into())
    });
    module
}

fn send(host: &HostContext, fields: Dynamic) -> Result<Dynamic, HostError> {
    let (message, severity) = send_fields(fields)?;
    let notification = host.call(|services, _| async move {
        services
            .notifications()
            .publish_notification(&message, severity)
            .await
    })?;
    Ok(notification_value(&notification))
}

fn send_fields(fields: Dynamic) -> Result<(String, NotificationSeverity), HostError> {
    let mut message = None;
    let mut severity = NotificationSeverity::Info;
    for (key, value) in map_argument(fields, "Notification")? {
        let what = format!("Field '{key}'");
        match key.as_str() {
            "message" => message = Some(string_argument(value, &what)?),
            "severity" => {
                severity = string_argument(value, &what)?.parse().map_err(
                    |error: vertebrae_core::ServiceError| HostError::invalid(error.to_string()),
                )?;
            }
            _ => {
                return Err(HostError::invalid(format!(
                    "Unknown field '{key}'; accepted fields are message and severity"
                )));
            }
        }
    }
    let message = message.ok_or_else(|| HostError::invalid("Field 'message' is required"))?;
    validate_notification_message(&message)
        .map_err(|error| HostError::invalid(error.to_string()))?;
    Ok((message, severity))
}

fn notification_value(notification: &Notification) -> Dynamic {
    let mut value = Map::new();
    value.insert("id".into(), notification.id.clone().into());
    value.insert("project_id".into(), notification.project_id.clone().into());
    value.insert("message".into(), notification.message.clone().into());
    value.insert("severity".into(), notification.severity.as_str().into());
    value.insert(
        "inserted_at".into(),
        timestamp(Some(notification.inserted_at)),
    );
    value.insert("read_at".into(), timestamp(notification.read_at));
    value.into()
}

/// Backslash-escape Markdown punctuation so `text` renders literally, for
/// example as a link label.
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if MARKDOWN_PUNCTUATION.contains(character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};
    use wiremock::{MockServer, Request, Respond, ResponseTemplate};

    use super::super::test_support::{self, PROJECT, sacrum_requests};
    use crate::actors::step_executor::StepResult;

    const SELF: &str = "e0000000-0000-4000-8000-000000000001";
    const ARTIFACT: &str = "e0000000-0000-4000-8000-000000000002";
    const NOTIFICATION: &str = "e0000000-0000-4000-8000-0000000000aa";

    /// Echo every publish back as Sacrum would, or fail with `error`.
    struct Publisher {
        error: Option<&'static str>,
        published: Mutex<usize>,
    }

    impl Respond for Publisher {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let variables = &body["variables"];
            if let Some(error) = self.error {
                return ResponseTemplate::new(200).set_body_json(json!({
                    "data": {"publishNotification": null},
                    "errors": [{"message": error, "path": ["publishNotification"]}]
                }));
            }
            *self.published.lock().unwrap() += 1;
            ResponseTemplate::new(200).set_body_json(json!({"data": {"publishNotification": {
                "id": NOTIFICATION,
                "project_id": variables["project_id"],
                "message": variables["message"],
                "severity": variables["severity"],
                "inserted_at": "2026-10-14T20:37:02.698001Z",
                "read_at": null,
            }}}))
        }
    }

    async fn sacrum(error: Option<&'static str>) -> MockServer {
        test_support::sacrum(Publisher {
            error,
            published: Mutex::new(0),
        })
        .await
    }

    async fn run(server: &MockServer, script: &str) -> StepResult {
        test_support::run(server, SELF, &[("ARTIFACT", ARTIFACT)], script).await
    }

    fn caught(result: StepResult, script: &str) -> Value {
        test_support::completed(result, script)
    }

    #[tokio::test]
    async fn send_publishes_the_composed_message_to_the_execution_project() {
        let server = sacrum(None).await;
        let script = r#"
            let title = "Ship [it] *now*";
            let message = "Artifact [report](vtb://artifact/" + $ARTIFACT + ") has been added to task ["
                + vtb::notifications::escape(title) + "](vtb://task/" + task.id + ").";
            vtb::notifications::send(#{ message: message, severity: "success" })
        "#;

        let sent = test_support::completed(run(&server, script).await, script);

        let expected = format!(
            "Artifact [report](vtb://artifact/{ARTIFACT}) has been added to task \
             [Ship \\[it\\] \\*now\\*](vtb://task/{SELF})."
        );
        assert_eq!(
            sacrum_requests(&server, "publishNotification").await,
            vec![json!({"project_id": PROJECT, "message": expected, "severity": "success"})]
        );
        assert_eq!(
            sent,
            json!({
                "id": NOTIFICATION,
                "project_id": PROJECT,
                "message": expected,
                "severity": "success",
                "inserted_at": "2026-10-14T20:37:02.698001+00:00",
                "read_at": null,
            })
        );
    }

    #[tokio::test]
    async fn severity_defaults_to_info_and_each_send_publishes_again() {
        let server = sacrum(None).await;
        let script = r#"
            vtb::notifications::send(#{ message: "Started" });
            vtb::notifications::send(#{ message: "Started" });
            #{}
        "#;

        test_support::completed(run(&server, script).await, script);

        let sent = sacrum_requests(&server, "publishNotification").await;
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|variables| variables["severity"] == "info"));
    }

    #[tokio::test]
    async fn bad_arguments_are_invalid_and_never_publish() {
        let server = sacrum(None).await;
        let oversized = "a".repeat(4097);
        let cases = [
            r#"vtb::notifications::send("Done")"#.to_string(),
            r#"vtb::notifications::send(#{ severity: "info" })"#.to_string(),
            r#"vtb::notifications::send(#{ message: "  " })"#.to_string(),
            format!(r#"vtb::notifications::send(#{{ message: "{oversized}" }})"#),
            r#"vtb::notifications::send(#{ message: 42 })"#.to_string(),
            r#"vtb::notifications::send(#{ message: "Done", severity: "fatal" })"#.to_string(),
            r#"vtb::notifications::send(#{ message: "Done", project_id: "x" })"#.to_string(),
            r#"vtb::notifications::escape(42)"#.to_string(),
        ];

        for call in cases {
            let script = format!(
                "let caught = (); try {{ {call}; }} catch (error) {{ caught = error; }} caught"
            );
            let error = caught(run(&server, &script).await, &script);
            assert_eq!(error["kind"], "invalid", "{call}: {error}");
            assert!(
                error["function"]
                    .as_str()
                    .unwrap()
                    .starts_with("vtb::notifications::"),
                "{call}: {error}"
            );
        }
        assert!(
            sacrum_requests(&server, "publishNotification")
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn backend_rejections_and_outages_use_structured_errors() {
        let server = sacrum(Some("project_id: does not exist")).await;
        let script = r#"let caught = (); try { vtb::notifications::send(#{ message: "Done" }); } catch (error) { caught = error; } caught"#;
        assert_eq!(
            caught(run(&server, script).await, script)["kind"],
            "invalid"
        );

        let server = test_support::sacrum(ResponseTemplate::new(503)).await;
        assert_eq!(
            caught(run(&server, script).await, script)["kind"],
            "transport"
        );
    }

    #[tokio::test]
    async fn an_uncaught_failure_fails_the_step() {
        let server = sacrum(None).await;
        match run(&server, r#"vtb::notifications::send(#{ message: "" })"#).await {
            StepResult::Failed { error, .. } => {
                assert!(error.contains("invalid"), "{error}");
                assert!(error.contains("vtb::notifications::send"), "{error}");
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn escape_backslashes_markdown_punctuation_only() {
        assert_eq!(super::escape("Plain words 42"), "Plain words 42");
        assert_eq!(
            super::escape(r"a_b [c](d) `e` \f"),
            r"a\_b \[c\]\(d\) \`e\` \\f"
        );
        assert_eq!(super::escape("Café — ok"), "Café — ok");
    }
}
