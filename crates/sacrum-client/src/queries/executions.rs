/// Fragment for step execution fields.
/// Absinthe uses snake_case for all field names.
pub const EXECUTION_FIELDS: &str = r#"
    fragment ExecutionFields on StepExecution {
        id
        task_id
        task_run_id
        workflow_id
        step_name
        step_type
        status
        context
        prompt
        output
        transition_result
        model
        model_provider
        input_tokens
        output_tokens
        session_input_tokens
        session_cache_read_input_tokens
        session_output_tokens
        session_total_tokens
        context_window_input_tokens
        context_window_cache_read_input_tokens
        context_window_total_tokens
        cost
        duration_ms
        handoff
        inserted_at
        updated_at
    }
"#;

/// Fragment for task run fields.
/// Absinthe uses snake_case for all field names.
pub const TASK_RUN_FIELDS: &str = r#"
    fragment TaskRunFields on TaskRun {
        id
        task_id
        project_id
        user_id
        status
        started_at
        ended_at
        stop_requested_at
        latest_step_execution_id
        outcome_kind
        outcome_context
        parent_task_run_id
        root_task_run_id
        triggered_by_step_execution_id
        inserted_at
        updated_at
    }
"#;

/// Fragment for session log fields.
pub const SESSION_LOG_FIELDS: &str = r#"
    fragment SessionLogFields on SessionLog {
        id
        step_execution_id
        content
        format
        inserted_at
        updated_at
    }
"#;

/// Fragment for task run trace fields.
/// NOTE: Prepend TASK_RUN_FIELDS, EXECUTION_FIELDS, and SESSION_LOG_FIELDS when sending.
pub const TASK_RUN_TRACE_FIELDS: &str = r#"
    fragment TaskRunTraceFields on TaskRunTrace {
        root_task_run_id
        task_runs {
            ...TaskRunFields
        }
        step_executions {
            ...ExecutionFields
        }
        session_logs {
            ...SessionLogFields
        }
    }
"#;

/// Get the active TaskRun for a task, if any.
/// NOTE: Prepend TASK_RUN_FIELDS when sending.
pub const ACTIVE_RUN: &str = r#"
    query ActiveRun($task_id: Uuid4!) {
        active_run(task_id: $task_id) {
            ...TaskRunFields
        }
    }
"#;

/// List all TaskRuns for a task.
/// NOTE: Prepend TASK_RUN_FIELDS when sending.
pub const TASK_RUNS: &str = r#"
    query TaskRuns($task_id: Uuid4!) {
        task_runs(task_id: $task_id) {
            ...TaskRunFields
        }
    }
"#;

/// Get one TaskRun by ID.
/// NOTE: Prepend TASK_RUN_FIELDS when sending.
pub const TASK_RUN: &str = r#"
    query TaskRun($id: Uuid4!) {
        task_run(id: $id) {
            ...TaskRunFields
        }
    }
"#;

/// Get the trace tree for a root TaskRun.
/// NOTE: Prepend TASK_RUN_FIELDS, EXECUTION_FIELDS, SESSION_LOG_FIELDS, and
/// TASK_RUN_TRACE_FIELDS when sending.
pub const TASK_RUN_TRACE: &str = r#"
    query TaskRunTrace($root_task_run_id: Uuid4!) {
        task_run_trace(root_task_run_id: $root_task_run_id) {
            ...TaskRunTraceFields
        }
    }
"#;

/// Start or schedule a workflow run for a task.
/// NOTE: Prepend TASK_RUN_FIELDS when sending.
pub const RUN_WORKFLOW: &str = r#"
    mutation RunWorkflow($task_id: Uuid4!) {
        run_workflow(task_id: $task_id) {
            ...TaskRunFields
        }
    }
"#;

/// Stop a run by task ID or explicit TaskRun ID.
/// NOTE: Prepend TASK_RUN_FIELDS when sending.
pub const STOP_RUN: &str = r#"
    mutation StopRun($task_id: Uuid4, $task_run_id: Uuid4) {
        stop_run(task_id: $task_id, task_run_id: $task_run_id) {
            ...TaskRunFields
        }
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
        $duration_ms: Int,
        $model: String,
        $model_provider: String
    ) {
        update_step_execution(
            id: $id,
            status: $status,
            output: $output,
            transition_result: $transition_result,
            input_tokens: $input_tokens,
            output_tokens: $output_tokens,
            cost: $cost,
            duration_ms: $duration_ms,
            model: $model,
            model_provider: $model_provider
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
    mutation CreateLog($step_execution_id: Uuid4!, $content: String!, $format: String) {
        create_session_log(
            step_execution_id: $step_execution_id,
            content: $content
            format: $format
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

/// Cancel a running step execution. Sacrum sets the status to `cancelling`
/// and broadcasts `cancel_step` to the daemon, which kills the child process.
/// NOTE: Prepend EXECUTION_FIELDS when sending.
pub const CANCEL_STEP_EXECUTION: &str = r#"
    mutation CancelStepExecution($step_execution_id: Uuid4!) {
        cancel_step_execution(step_execution_id: $step_execution_id) {
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

/// Stop the running TaskOrchestrator for a task. Idempotent.
/// Sacrum calls Sacrum.Orchestrator.stop/1, which terminates the FSM
/// and cancels any in-flight step execution. Returns the task.
pub const STOP_ORCHESTRATOR: &str = r#"
    mutation StopOrchestrator($task_id: Uuid4!) {
        stop_orchestrator(task_id: $task_id) {
            id
        }
    }
"#;
