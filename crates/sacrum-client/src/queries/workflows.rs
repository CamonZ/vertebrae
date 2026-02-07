/// Fragment for workflow fields matching WorkflowResponse.
/// Absinthe uses snake_case for all field names.
pub const WORKFLOW_FIELDS: &str = r#"
    fragment WorkflowFields on Workflow {
        id
        name
        description
        auto_advance
        is_default
        display_order
        metadata
        initial_step_id
        project_id
        on_done_workflow_id
        on_reject_workflow_id
        inserted_at
        updated_at
        workflow_steps {
            id
            name
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
    query ListWorkflows($project_id: ID!) {
        workflows(project_id: $project_id) {
            ...WorkflowFields
        }
    }
"#;

/// Get a single workflow by ID with nested steps and their transitions.
/// NOTE: Prepend WORKFLOW_FIELDS when sending.
pub const GET_WORKFLOW: &str = r#"
    query GetWorkflow($id: ID!) {
        workflow(id: $id) {
            ...WorkflowFields
            workflow_steps {
                id name goal agents skills agent_config
                is_final step_order workflow_id
                transitions { id to_step_id label }
            }
        }
    }
"#;

pub const CREATE_WORKFLOW: &str = r#"
    mutation CreateWorkflow(
        $project_id: ID!,
        $name: String!,
        $description: String,
        $auto_advance: Boolean,
        $display_order: Int,
        $is_default: Boolean
    ) {
        create_workflow(
            project_id: $project_id,
            name: $name,
            description: $description,
            auto_advance: $auto_advance,
            display_order: $display_order,
            is_default: $is_default
        ) {
            id
        }
    }
"#;

pub const UPDATE_WORKFLOW: &str = r#"
    mutation UpdateWorkflow(
        $id: ID!,
        $name: String,
        $description: String,
        $auto_advance: Boolean,
        $display_order: Int,
        $is_default: Boolean,
        $initial_step_id: ID,
        $on_done_workflow_id: ID,
        $on_reject_workflow_id: ID
    ) {
        update_workflow(
            id: $id,
            name: $name,
            description: $description,
            auto_advance: $auto_advance,
            display_order: $display_order,
            is_default: $is_default,
            initial_step_id: $initial_step_id,
            on_done_workflow_id: $on_done_workflow_id,
            on_reject_workflow_id: $on_reject_workflow_id
        ) {
            id
        }
    }
"#;

pub const DELETE_WORKFLOW: &str = r#"
    mutation DeleteWorkflow($id: ID!) {
        delete_workflow(id: $id) {
            id
        }
    }
"#;

pub const CREATE_WORKFLOW_TRANSITION: &str = r#"
    mutation CreateWorkflowTransition(
        $from_workflow_id: ID!,
        $to_workflow_id: ID!,
        $label: String,
        $target_step_id: ID
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
    mutation DeleteWorkflowTransition($id: ID!) {
        delete_workflow_transition(id: $id) {
            id
        }
    }
"#;

pub const SYNC_WORKFLOW_TRANSITIONS: &str = r#"
    mutation SyncWorkflowTransitions(
        $id: ID!,
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
