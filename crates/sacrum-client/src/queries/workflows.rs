/// Fragment for workflow fields matching WorkflowResponse.
/// Absinthe uses snake_case for all field names.
pub const WORKFLOW_FIELDS: &str = r#"
    fragment WorkflowFields on Workflow {
        id
        name
        description
        is_default
        is_final
        display_order
        metadata
        initial_step_id
        kanban_column
        project_id
        inserted_at
        updated_at
        workflow_steps {
            id
            name
            step_type
            step_order
        }
        transitions {
            id
            to_workflow_id
            target_step_id
            label
        }
    }
"#;

/// List all workflows for a project.
/// NOTE: Prepend WORKFLOW_FIELDS when sending.
pub const LIST_WORKFLOWS: &str = r#"
    query ListWorkflows($project_id: Uuid4!) {
        workflows(project_id: $project_id) {
            ...WorkflowFields
        }
    }
"#;

/// Get a single workflow by ID with nested steps and their transitions.
/// NOTE: Prepend WORKFLOW_FIELDS when sending.
pub const GET_WORKFLOW: &str = r#"
    query GetWorkflow($id: Uuid4!) {
        workflow(id: $id) {
            ...WorkflowFields
            workflow_steps {
                id name goal agents skills agent_config step_type
                is_final step_order workflow_id
                transitions { id to_step_id label }
            }
        }
    }
"#;

/// Fetch one workflow plus tasks assigned to it.
/// NOTE: Prepend WORKFLOW_FIELDS and TASK_FIELDS.
pub const GET_WORKFLOW_WITH_TASKS: &str = r#"
    query GetWorkflowWithTasks($project_id: Uuid4!, $workflow_id: Uuid4!) {
        workflow(id: $workflow_id) {
            ...WorkflowFields
        }
        tasks(project_id: $project_id, workflow_id: $workflow_id) {
            ...TaskFields
        }
        workflows(project_id: $project_id) {
            ...WorkflowFields
        }
    }
"#;

/// Resolve a short ID prefix to a full workflow.
/// Mirrors tasks::RESOLVE_SHORT_ID — selects only `id` to keep the
/// round-trip minimal (sacrum has known perf concerns on prefix lookups).
pub const RESOLVE_WORKFLOW_SHORT_ID: &str = r#"
    query ResolveWorkflowShortId($project_id: Uuid4!, $prefix: String!) {
        resolve_workflow_short_id(project_id: $project_id, prefix: $prefix) {
            id
        }
    }
"#;

pub const CREATE_WORKFLOW: &str = r#"
    mutation CreateWorkflow(
        $project_id: Uuid4!,
        $name: String!,
        $description: String,
        $display_order: Int,
        $is_default: Boolean,
        $is_final: Boolean,
        $kanban_column: String
    ) {
        create_workflow(
            project_id: $project_id,
            name: $name,
            description: $description,
            display_order: $display_order,
            is_default: $is_default,
            is_final: $is_final,
            kanban_column: $kanban_column
        ) {
            id
        }
    }
"#;

pub const UPDATE_WORKFLOW: &str = r#"
    mutation UpdateWorkflow(
        $id: Uuid4!,
        $name: String,
        $description: String,
        $display_order: Int,
        $is_default: Boolean,
        $is_final: Boolean,
        $initial_step_id: Uuid4,
        $kanban_column: String
    ) {
        update_workflow(
            id: $id,
            name: $name,
            description: $description,
            display_order: $display_order,
            is_default: $is_default,
            is_final: $is_final,
            initial_step_id: $initial_step_id,
            kanban_column: $kanban_column
        ) {
            id
        }
    }
"#;

pub const DELETE_WORKFLOW: &str = r#"
    mutation DeleteWorkflow($id: Uuid4!) {
        delete_workflow(id: $id) {
            id
        }
    }
"#;

pub const CREATE_WORKFLOW_TRANSITION: &str = r#"
    mutation CreateWorkflowTransition(
        $from_workflow_id: Uuid4!,
        $to_workflow_id: Uuid4!,
        $label: String,
        $target_step_id: Uuid4
    ) {
        create_workflow_transition(
            from_workflow_id: $from_workflow_id,
            to_workflow_id: $to_workflow_id,
            label: $label,
            target_step_id: $target_step_id
        ) {
            id to_workflow_id target_step_id label
        }
    }
"#;

pub const DELETE_WORKFLOW_TRANSITION: &str = r#"
    mutation DeleteWorkflowTransition($id: Uuid4!) {
        delete_workflow_transition(id: $id) {
            id
        }
    }
"#;

pub const SYNC_WORKFLOW_TRANSITIONS: &str = r#"
    mutation SyncWorkflowTransitions(
        $id: Uuid4!,
        $transitions: [WorkflowTransitionInput!]!
    ) {
        sync_workflow_transitions(id: $id, transitions: $transitions) {
            id
            transitions {
                id to_workflow_id target_step_id label
            }
        }
    }
"#;
