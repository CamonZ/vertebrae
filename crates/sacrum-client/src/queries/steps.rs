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
        step_type
        output_schema
        persistence_options
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

/// Resolve a short ID prefix to a full step within a workflow.
/// Selects only `id` for the same reason as the task/workflow short-id queries —
/// minimizing payload while sacrum's prefix lookups remain a perf hotspot.
pub const RESOLVE_STEP_SHORT_ID: &str = r#"
    query ResolveStepShortId($project_id: Uuid4!, $workflow_id: Uuid4!, $prefix: String!) {
        resolve_step_short_id(project_id: $project_id, workflow_id: $workflow_id, prefix: $prefix) {
            id
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
        $step_type: String,
        $output_schema: Json,
        $persistence_options: Json,
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
            step_type: $step_type,
            output_schema: $output_schema,
            persistence_options: $persistence_options,
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
        $step_type: String,
        $output_schema: Json,
        $persistence_options: Json,
        $clear_output_schema: Boolean,
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
            step_type: $step_type,
            output_schema: $output_schema,
            persistence_options: $persistence_options,
            clear_output_schema: $clear_output_schema,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_step_operations_read_and_write_persistence_options() {
        assert!(STEP_FIELDS.contains("persistence_options"));
        assert!(CREATE_STEP.contains("$persistence_options: Json"));
        assert!(CREATE_STEP.contains("persistence_options: $persistence_options"));
        assert!(UPDATE_STEP.contains("$persistence_options: Json"));
        assert!(UPDATE_STEP.contains("persistence_options: $persistence_options"));
    }
}
