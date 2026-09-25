/// Fragment for workflow step fields.
/// Absinthe uses snake_case for all field names.
pub const STEP_FIELDS: &str = r#"
    fragment StepFields on WorkflowStep {
        id
        name
        goal
        step_type
        config {
            ... on LlmInferenceStepConfig {
                version prompt output_schema agents skills agent_config
            }
            ... on RouteStepConfig { version route_config }
            ... on WaitChildrenStepConfig { version output_schema }
        }
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

/// Complete step fields for workflow export. This is separate from the
/// presentation fragments so an export cannot accidentally lose JSON-backed
/// configuration or nullable prompts.
pub const WORKFLOW_EXPORT_STEP_FIELDS: &str = r#"
    fragment WorkflowExportStepFields on WorkflowStep {
        id
        name
        goal
        step_type
        config {
            ... on LlmInferenceStepConfig {
                version prompt output_schema agents skills agent_config
            }
            ... on RouteStepConfig { version route_config }
            ... on WaitChildrenStepConfig { version output_schema }
        }
        persistence_options
        step_order
        workflow_id
        project_id
        inserted_at
        updated_at
        transitions {
            id
            to_step_id
            label
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
        $step_type: String,
        $config: Json,
        $persistence_options: Json,
        $step_order: Int
    ) {
        create_workflow_step(
            workflow_id: $workflow_id,
            name: $name,
            goal: $goal,
            step_type: $step_type,
            config: $config,
            persistence_options: $persistence_options,
            step_order: $step_order
        ) {
            ...StepFields
        }
    }
"#;

/// The nullable update arguments must be omitted from the GraphQL document when
/// an update does not touch them. Passing a missing variable to an explicit
/// nullable argument coerces it to null, which would turn an unrelated update
/// into an accidental clear on the backend.
/// Build an update mutation containing only fields represented by the update.
pub fn update_step_query(updates: &vertebrae_core::StepUpdate) -> String {
    let mut definitions = vec!["$id: Uuid4!".to_string()];
    let mut arguments = vec!["id: $id".to_string()];

    let mut add = |enabled: bool, definition: &str, argument: &str| {
        if enabled {
            definitions.push(definition.to_string());
            arguments.push(argument.to_string());
        }
    };

    add(updates.name.is_some(), "$name: String", "name: $name");
    add(updates.goal.is_some(), "$goal: String", "goal: $goal");
    add(updates.config.is_some(), "$config: Json", "config: $config");
    add(
        updates.persistence_options.is_some(),
        "$persistence_options: Json",
        "persistence_options: $persistence_options",
    );
    add(
        updates.order.is_some(),
        "$step_order: Int",
        "step_order: $step_order",
    );

    format!(
        "mutation UpdateStep(\n        {}\n    ) {{\n        update_workflow_step(\n            {}\n        ) {{\n            ...StepFields\n        }}\n    }}",
        definitions.join(",\n        "),
        arguments.join(",\n            ")
    )
}

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
    fn step_fragments_select_the_config_union() {
        for fragment in [STEP_FIELDS, WORKFLOW_EXPORT_STEP_FIELDS] {
            assert!(fragment.contains("persistence_options"));
            assert!(fragment.contains("... on LlmInferenceStepConfig"));
            assert!(fragment.contains("... on RouteStepConfig { version route_config }"));
            assert!(fragment.contains("... on WaitChildrenStepConfig { version output_schema }"));
        }
        assert!(CREATE_STEP.contains("$config: Json"));
        assert!(CREATE_STEP.contains("config: $config"));
        assert!(CREATE_STEP.contains("persistence_options: $persistence_options"));
        assert!(!CREATE_STEP.contains("$prompt"));
        assert!(!CREATE_STEP.contains("$route_config"));
    }

    #[test]
    fn update_step_query_omits_unmodified_nullable_fields() {
        let query = update_step_query(&vertebrae_core::StepUpdate::new().with_name("x"));
        assert!(query.contains("name: $name"));
        assert!(!query.contains("config: $config"));
        assert!(!query.contains("persistence_options"));
        assert!(!query.contains("step_type"));

        let query = update_step_query(
            &vertebrae_core::StepUpdate::new()
                .with_route_config(Some(serde_json::json!({"version": 1})))
                .with_persistence_options(None),
        );
        assert!(query.contains("$config: Json"));
        assert!(query.contains("config: $config"));
        assert!(query.contains("persistence_options: $persistence_options"));
        assert!(!query.contains("clear_output_schema"));
    }
}
