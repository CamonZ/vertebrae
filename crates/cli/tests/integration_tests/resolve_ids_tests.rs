//! Integration tests for `Command::resolve_ids` short-ID resolution.
//!
//! Verifies that List, Execution::Create/List, and Workflow::Unassign commands
//! correctly resolve 8-character hex prefixes to full UUIDs before execution.

use super::mock::{mock_services, mock_services_with_seeder};
use vertebrae_cli::commands::Command;
use vertebrae_cli::commands::execution::{
    ExecutionCommand, ExecutionCreateCommand, ExecutionListCommand,
};
use vertebrae_cli::commands::list::ListCommand;
use vertebrae_cli::commands::workflow::{WorkflowCommand, WorkflowUnassignCommand};
use vertebrae_core::{CreateTaskOptions, Step};

const TASK_FULL: &str = "abcd1234-0000-4000-8000-000000000001";
const TASK_PREFIX: &str = "abcd1234";

const WF_FULL: &str = "deadbeef-0000-4000-8000-000000000002";
const WF_PREFIX: &str = "deadbeef";

const STEP_FULL: &str = "cafef00d-0000-4000-8000-000000000003";
const STEP_PREFIX: &str = "cafef00d";

async fn seed_task(services: &vertebrae_core::VertebraeServices, id: &str, title: &str) {
    services
        .tasks()
        .create_task(CreateTaskOptions {
            id: Some(id.to_string()),
            title: title.to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            workflow_id: None,
            depends_on: vec![],
            needs_review: false,
        })
        .await
        .unwrap();
}

async fn seed_step(services: &vertebrae_core::VertebraeServices, id: &str, workflow_id: &str) {
    let step = Step::new("step", workflow_id);
    services
        .steps()
        .create_step_with_id(id, &step)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_resolve_ids_list_resolves_parent_workflow_step_short_ids() {
    let (services, seeder) = mock_services_with_seeder();

    seed_task(&services, TASK_FULL, "parent task").await;
    seeder.insert_workflow(WF_FULL, "wf");
    seed_step(&services, STEP_FULL, WF_FULL).await;

    let mut command = Command::List(ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        workflow: Some(WF_PREFIX.to_string()),
        step: Some(STEP_PREFIX.to_string()),
        root: false,
        parent: Some(TASK_PREFIX.to_string()),
        all: false,
        include_archived: false,
        search: None,
        flat: false,
    });

    command
        .resolve_ids(&services)
        .await
        .expect("resolve_ids should succeed for valid short IDs");

    match command {
        Command::List(cmd) => {
            assert_eq!(cmd.parent.as_deref(), Some(TASK_FULL));
            assert_eq!(cmd.workflow.as_deref(), Some(WF_FULL));
            assert_eq!(cmd.step.as_deref(), Some(STEP_FULL));
        }
        _ => panic!("expected Command::List"),
    }
}

#[tokio::test]
async fn test_resolve_ids_list_passes_full_uuid_through_unchanged() {
    let services = mock_services();
    seed_task(&services, TASK_FULL, "parent").await;

    let mut command = Command::List(ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        workflow: None,
        step: None,
        root: false,
        parent: Some(TASK_FULL.to_string()),
        all: false,
        include_archived: false,
        search: None,
        flat: false,
    });

    command.resolve_ids(&services).await.unwrap();

    match command {
        Command::List(cmd) => assert_eq!(cmd.parent.as_deref(), Some(TASK_FULL)),
        _ => panic!("expected Command::List"),
    }
}

#[tokio::test]
async fn test_resolve_ids_list_unknown_short_id_returns_error() {
    let services = mock_services();
    // No tasks seeded with this prefix.

    let mut command = Command::List(ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        workflow: None,
        step: None,
        root: false,
        parent: Some("ffffffff".to_string()),
        all: false,
        include_archived: false,
        search: None,
        flat: false,
    });

    let err = command
        .resolve_ids(&services)
        .await
        .expect_err("expected error for unknown short ID");
    let msg = err.to_string();
    assert!(
        msg.contains("ffffffff") || msg.contains("not found"),
        "error should reference the prefix or 'not found', got: {msg}"
    );
}

#[tokio::test]
async fn test_resolve_ids_execution_create_resolves_task_short_id() {
    let services = mock_services();
    seed_task(&services, TASK_FULL, "task").await;

    let mut command = Command::Execution(ExecutionCommand::Create(ExecutionCreateCommand {
        task_id: TASK_PREFIX.to_string(),
        context: None,
        prompt: None,
    }));

    command.resolve_ids(&services).await.unwrap();

    match command {
        Command::Execution(ExecutionCommand::Create(c)) => {
            assert_eq!(c.task_id, TASK_FULL);
        }
        _ => panic!("expected Execution::Create"),
    }
}

#[tokio::test]
async fn test_resolve_ids_execution_list_preserves_task_target_for_command_execution() {
    let services = mock_services();
    seed_task(&services, TASK_FULL, "task").await;

    let mut command = Command::Execution(ExecutionCommand::List(ExecutionListCommand {
        task_id: Some(TASK_PREFIX.to_string()),
        task_run_id: None,
    }));

    command.resolve_ids(&services).await.unwrap();

    match command {
        Command::Execution(ExecutionCommand::List(c)) => {
            assert_eq!(c.task_id.as_deref(), Some(TASK_PREFIX));
            assert!(c.task_run_id.is_none());
        }
        _ => panic!("expected Execution::List"),
    }
}

#[tokio::test]
async fn test_resolve_ids_workflow_unassign_resolves_task_short_id() {
    let services = mock_services();
    seed_task(&services, TASK_FULL, "task").await;

    let mut command = Command::Workflow(WorkflowCommand::Unassign(WorkflowUnassignCommand {
        task_id: TASK_PREFIX.to_string(),
    }));

    command.resolve_ids(&services).await.unwrap();

    match command {
        Command::Workflow(WorkflowCommand::Unassign(c)) => {
            assert_eq!(c.task_id, TASK_FULL);
        }
        _ => panic!("expected Workflow::Unassign"),
    }
}
