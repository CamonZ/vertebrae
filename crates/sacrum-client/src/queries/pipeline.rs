//! GraphQL query bindings for the `pipeline_summary` query.
//!
//! Returns the full set of workflows for a project with their workflow steps,
//! intra-workflow step transitions, inter-workflow transitions, plus per-step
//! `task_counts` (epic/ticket/task) and `running_count` aggregates. The
//! resolver computes all aggregates with a fixed number of SQL queries
//! independent of workflow / step / task count, so the client just calls it.

/// Single GraphQL query returning all data needed by the All Workflows
/// pipeline view.
///
/// The shape mirrors the Absinthe schema — fields are snake_case.
pub const PIPELINE_SUMMARY: &str = r#"
    query PipelineSummary($project_id: Uuid4!) {
        pipeline_summary(project_id: $project_id) {
            id
            name
            description
            auto_advance
            is_default
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
                goal
                step_order
                step_type
                is_final
                workflow_id
                project_id
                inserted_at
                updated_at
                task_counts { epic ticket task }
                running_count
                transitions {
                    id
                    from_step_id
                    to_step_id
                    label
                }
            }
            transitions {
                id
                from_workflow_id
                to_workflow_id
                target_step_id
                label
            }
        }
    }
"#;
