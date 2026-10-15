//! Rhai notification steps: execute scripts publish Markdown notifications
//! with `vtb::notifications::send`, and the stored notifications are read
//! back, paged and marked read through Sacrum. The report sample comes from
//! the execute agent docs.

use cucumber::gherkin::Step;
use cucumber::{given, then, when};
use serde_json::{Value, json};
use vertebrae_core::{
    Notification, NotificationCursor, NotificationPageQuery, NotificationService,
};
use vertebrae_sacrum_client::{SacrumArtifactService, SacrumNotificationService};

use super::execute::fenced_block;
use super::host_reads::{docstring, id, install_rhai_step, substitute};
use crate::DaemonWorld;
use vertebrae_core::ArtifactService;

const DOC: &str =
    include_str!("../../../../docs/agent-context/workflows/steps/execute/host-notifications.md");

fn service(world: &DaemonWorld) -> SacrumNotificationService {
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured");
    SacrumNotificationService::new((**client).clone())
}

async fn page(world: &DaemonWorld, query: NotificationPageQuery) -> (Vec<Notification>, bool) {
    let page = service(world)
        .list_notifications(query)
        .await
        .unwrap_or_else(|error| panic!("list notifications: {error}"));
    (page.notifications, page.has_more)
}

/// Every notification in the scenario's project, oldest first.
async fn notifications(world: &DaemonWorld) -> Vec<Notification> {
    let (notifications, has_more) = page(
        world,
        NotificationPageQuery {
            limit: Some(200),
            ..Default::default()
        },
    )
    .await;
    assert!(!has_more, "more notifications than one page");
    notifications
}

/// The doc's first `rhai` block.
#[given("the documented report sample running on SELF")]
async fn documented_report(world: &mut DaemonWorld) {
    let sample = fenced_block(DOC, "host-notifications.md", "rhai");
    install_rhai_step(world, sample).await;
}

#[then(expr = "{word}'s {string} artifact is known as {word}")]
async fn artifact_role(world: &mut DaemonWorld, subject: String, name: String, role: String) {
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured");
    let artifacts = SacrumArtifactService::new((**client).clone())
        .list_task_artifacts(&id(world, &subject))
        .await
        .unwrap_or_else(|error| panic!("list {subject} artifacts: {error}"));
    let artifact = artifacts
        .into_iter()
        .find(|artifact| artifact.logical_name.as_deref() == Some(name.as_str()))
        .unwrap_or_else(|| panic!("{subject} has no artifact named {name}"));
    world.fixture_ids.insert(role, artifact.id);
}

#[then("the script's notification_id is the ID of the project's only notification")]
async fn returned_id(world: &mut DaemonWorld) {
    let output = world
        .last_execution
        .as_ref()
        .and_then(|execution| execution.output.as_deref())
        .expect("execute output");
    let output: Value = serde_json::from_str(output).expect("execute output JSON");
    let stored = notifications(world).await;
    assert_eq!(stored.len(), 1, "{stored:?}");
    assert_eq!(output["result"]["notification_id"], json!(stored[0].id));
}

/// The docstring is a JSON list of `[message, severity, read]`, oldest first.
/// `$ROLE` in a message stands for a fixture ID, without quotes.
#[then("the project's notifications are:")]
async fn notifications_are(world: &mut DaemonWorld, step: &Step) {
    let mut text = docstring(step).to_owned();
    for (role, fixture) in &world.fixture_ids {
        text = text.replace(
            &format!("vtb://task/${role}"),
            &format!("vtb://task/{fixture}"),
        );
        text = text.replace(
            &format!("vtb://artifact/${role}"),
            &format!("vtb://artifact/{fixture}"),
        );
    }
    let expected: Value = serde_json::from_str(&substitute(world, &text))
        .unwrap_or_else(|error| panic!("expected notifications are not JSON ({error}): {text}"));
    let project = world.project_id.clone().expect("scenario project");
    let stored = notifications(world).await;
    assert!(
        stored
            .iter()
            .all(|notification| notification.project_id == project)
    );
    let actual: Vec<Value> = stored
        .iter()
        .map(|notification| {
            json!([
                notification.message,
                notification.severity.as_str(),
                notification.read_at.is_some()
            ])
        })
        .collect();
    assert_eq!(Value::Array(actual), expected);
}

#[then(expr = "paging the project's notifications one at a time returns the same {int} in order")]
async fn paged_one_at_a_time(world: &mut DaemonWorld, count: usize) {
    let all = notifications(world).await;
    assert_eq!(all.len(), count);
    let mut paged = Vec::new();
    let mut after = None;
    loop {
        let (mut notifications, has_more) = page(
            world,
            NotificationPageQuery {
                after: after.clone(),
                limit: Some(1),
                unread_only: false,
            },
        )
        .await;
        assert!(notifications.len() <= 1, "{notifications:?}");
        let Some(last) = notifications.pop() else {
            break;
        };
        after = Some(NotificationCursor {
            inserted_at: last.inserted_at,
            id: last.id.clone(),
        });
        paged.push(last);
        if !has_more {
            break;
        }
    }
    assert_eq!(paged, all);
}

#[when("I mark the project's notifications read")]
async fn mark_read(world: &mut DaemonWorld) {
    let ids: Vec<String> = notifications(world)
        .await
        .into_iter()
        .map(|notification| notification.id)
        .collect();
    let read = service(world)
        .mark_notifications_read(&ids)
        .await
        .unwrap_or_else(|error| panic!("mark read: {error}"));
    let mut returned: Vec<_> = read
        .iter()
        .map(|notification| notification.id.clone())
        .collect();
    returned.sort();
    let mut expected = ids;
    expected.sort();
    assert_eq!(returned, expected);
}

#[then("every project notification is read and no unread notification remains")]
async fn all_read(world: &mut DaemonWorld) {
    let stored = notifications(world).await;
    assert!(!stored.is_empty());
    assert!(
        stored
            .iter()
            .all(|notification| notification.read_at.is_some()),
        "{stored:?}"
    );
    let (unread, has_more) = page(
        world,
        NotificationPageQuery {
            unread_only: true,
            ..Default::default()
        },
    )
    .await;
    assert!(unread.is_empty() && !has_more, "{unread:?}");
}

#[then("marking them read again keeps their first read time")]
async fn mark_read_again(world: &mut DaemonWorld) {
    let before = notifications(world).await;
    let ids: Vec<String> = before
        .iter()
        .map(|notification| notification.id.clone())
        .collect();
    service(world)
        .mark_notifications_read(&ids)
        .await
        .unwrap_or_else(|error| panic!("mark read again: {error}"));
    assert_eq!(notifications(world).await, before);
}

#[then("the project has no notifications")]
async fn no_notifications(world: &mut DaemonWorld) {
    let stored = notifications(world).await;
    assert!(stored.is_empty(), "{stored:?}");
}
