/// Fragment for step execution fields.
/// Absinthe uses snake_case for all field names.
pub const EXECUTION_FIELDS: &str = r#"
    fragment ExecutionFields on StepExecution {
        id
        task_id
        workflow_id
        step_name
        status
        context
        prompt
        output
        transition_result
        model
        model_provider
        input_tokens
        output_tokens
        cost
        duration_ms
        inserted_at
        updated_at
    }
"#;

/// List all executions for a task.
/// NOTE: Prepend EXECUTION_FIELDS when sending.
pub const LIST_EXECUTIONS: &str = r#"
    query ListExecutions($task_id: Uuid4!) {
        step_executions(task_id: $task_id) {
            ...ExecutionFields
        }
    }
"#;

/// Get a single execution by ID.
/// NOTE: Prepend EXECUTION_FIELDS when sending.
pub const GET_EXECUTION: &str = r#"
    query GetExecution($id: Uuid4!) {
        step_execution(id: $id) {
            ...ExecutionFields
        }
    }
"#;

pub const CREATE_EXECUTION: &str = r#"
    mutation CreateExecution(
        $task_id: Uuid4!,
        $workflow_id: Uuid4!,
        $step_name: String!,
        $status: String,
        $context: Json,
        $prompt: String,
        $model: String,
        $model_provider: String
    ) {
        create_step_execution(
            task_id: $task_id,
            workflow_id: $workflow_id,
            step_name: $step_name,
            status: $status,
            context: $context,
            prompt: $prompt,
            model: $model,
            model_provider: $model_provider
        ) {
            id
        }
    }
"#;

pub const UPDATE_EXECUTION: &str = r#"
    mutation UpdateExecution(
        $id: Uuid4!,
        $status: String,
        $output: String,
        $transition_result: String,
        $input_tokens: Int,
        $output_tokens: Int,
        $cost: Decimal,
        $duration_ms: Int
    ) {
        update_step_execution(
            id: $id,
            status: $status,
            output: $output,
            transition_result: $transition_result,
            input_tokens: $input_tokens,
            output_tokens: $output_tokens,
            cost: $cost,
            duration_ms: $duration_ms
        ) {
            id
        }
    }
"#;

/// List session logs for a step execution.
pub const LIST_LOGS: &str = r#"
    query ListLogs($step_execution_id: Uuid4!) {
        session_logs(step_execution_id: $step_execution_id) {
            id
            step_execution_id
            content
            inserted_at
            updated_at
        }
    }
"#;

pub const CREATE_LOG: &str = r#"
    mutation CreateLog($step_execution_id: Uuid4!, $content: String!) {
        create_session_log(
            step_execution_id: $step_execution_id,
            content: $content
        ) {
            id
        }
    }
"#;

/// Trigger a workflow step execution via the orchestrator.
/// Sacrum creates a StepExecution and broadcasts run_step to daemon clients.
/// NOTE: Prepend EXECUTION_FIELDS when sending.
pub const RUN_STEP: &str = r#"
    mutation RunStep($task_id: Uuid4!, $step_id: Uuid4!) {
        run_step(task_id: $task_id, step_id: $step_id) {
            ...ExecutionFields
        }
    }
"#;

/// Orchestrate a task through its entire workflow via the TaskOrchestrator FSM.
/// Sacrum schedules the task and drives it through all steps automatically.
pub const ORCHESTRATE_TASK: &str = r#"
    mutation OrchestrateTask($task_id: Uuid4!) {
        orchestrate_task(task_id: $task_id) {
            id
        }
    }
"#;
