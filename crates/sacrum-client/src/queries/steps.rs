/// Fragment for workflow step fields.
/// Absinthe uses snake_case for all field names.
pub const STEP_FIELDS: &str = r#"
    fragment StepFields on WorkflowStep {
        id
        name
        goal
        prompt
        agents
        skills
        agent_config
        is_final
        step_order
        workflow_id
        project_id
        inserted_at
        updated_at
        transitions {
            id to_step_id label
        }
    }
"#;

/// List all steps for a workflow.
/// NOTE: Prepend STEP_FIELDS when sending.
pub const LIST_STEPS: &str = r#"
    query ListSteps($workflow_id: Uuid4!) {
        workflow_steps(workflow_id: $workflow_id) {
            ...StepFields
        }
    }
"#;

/// Get a single step by ID.
/// NOTE: Prepend STEP_FIELDS when sending.
pub const GET_STEP: &str = r#"
    query GetStep($id: Uuid4!) {
        workflow_step(id: $id) {
            ...StepFields
        }
    }
"#;

pub const CREATE_STEP: &str = r#"
    mutation CreateStep(
        $workflow_id: Uuid4!,
        $name: String!,
        $goal: String,
        $prompt: String,
        $agents: [String!],
        $skills: [String!],
        $agent_config: Json,
        $is_final: Boolean,
        $step_order: Int
    ) {
        create_workflow_step(
            workflow_id: $workflow_id,
            name: $name,
            goal: $goal,
            prompt: $prompt,
            agents: $agents,
            skills: $skills,
            agent_config: $agent_config,
            is_final: $is_final,
            step_order: $step_order
        ) {
            ...StepFields
        }
    }
"#;

pub const UPDATE_STEP: &str = r#"
    mutation UpdateStep(
        $id: Uuid4!,
        $name: String,
        $goal: String,
        $prompt: String,
        $agents: [String!],
        $skills: [String!],
        $agent_config: Json,
        $is_final: Boolean,
        $step_order: Int
    ) {
        update_workflow_step(
            id: $id,
            name: $name,
            goal: $goal,
            prompt: $prompt,
            agents: $agents,
            skills: $skills,
            agent_config: $agent_config,
            is_final: $is_final,
            step_order: $step_order
        ) {
            ...StepFields
        }
    }
"#;

pub const DELETE_STEP: &str = r#"
    mutation DeleteStep($id: Uuid4!) {
        delete_workflow_step(id: $id) {
            id
        }
    }
"#;

pub const SYNC_STEP_TRANSITIONS: &str = r#"
    mutation SyncStepTransitions(
        $id: Uuid4!,
        $transitions: [StepTransitionInput!]!
    ) {
        sync_step_transitions(id: $id, transitions: $transitions) {
            ...StepFields
        }
    }
"#;
