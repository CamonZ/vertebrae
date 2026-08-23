import { render, type RenderOptions } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import type { ReactElement, ReactNode } from "react";
import type {
  AgentConfig,
  Step,
  StepExecution,
  Task,
  TaskRun,
  TaskRunControls,
  Workflow,
} from "../bindings";
import { queryClient } from "../query/queryClient";

/**
 * Custom render function that wraps components with necessary providers
 */
function customRender(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );

  return render(ui, { wrapper: Wrapper, ...options });
}

// Re-export everything from testing-library
export * from "@testing-library/react";
export { userEvent } from "@testing-library/user-event";

// Override render with custom render
export { customRender as render };

/**
 * Create a complete AgentConfig with defaults
 */
export function createMockAgentConfig(
  overrides?: Partial<AgentConfig>
): AgentConfig {
  return {
    model: null,
    codex_model_provider: null,
    fallback_model: null,
    reasoning_effort: null,
    system_prompt: null,
    append_system_prompt: null,
    agents: null,
    tools: [],
    allowed_tools: [],
    disallowed_tools: [],
    permission_mode: null,
    max_budget_usd: null,
    mcp_config: [],
    plugin_dirs: [],
    json_schema: null,
    ...overrides,
  };
}

/**
 * Create a complete Step with defaults
 */
export function createMockStep(overrides?: Partial<Step>): Step {
  return {
    id: null,
    name: "Test Step",
    workflow_id: "workflow-1",
    goal: null,
    prompt: null,
    agent_config: createMockAgentConfig({ model: "claude-3-sonnet" }),
    transitions_to: [],
    order: 0,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

/**
 * Create mock workflow data for testing
 */
export function createMockWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "test-workflow-1",
    name: "Test Workflow",
    description: "A test workflow",
    initial_step: "step-backlog",
    kanban_column: null,
    is_default: false,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create mock Step entities for testing (first-class steps)
 */
export function createMockSteps(workflowId = "test-workflow-1"): Step[] {
  return [
    createMockStep({
      id: "step-backlog",
      workflow_id: workflowId,
      name: "backlog",
      order: 0,
    }),
    createMockStep({
      id: "step-in_progress",
      workflow_id: workflowId,
      name: "in_progress",
      order: 1,
    }),
    createMockStep({
      id: "step-done",
      workflow_id: workflowId,
      name: "done",
      order: 2,
    }),
  ];
}

/**
 * Create mock step execution data for testing
 */
export function createMockStepExecution(
  overrides?: Partial<StepExecution>
): StepExecution {
  return {
    id: `exec-${Math.random().toString(36).slice(2, 10)}`,
    task_id: "task-1",
    task_run_id: null,
    workflow_id: "workflow-1",
    step_name: "in_progress",
    started_at: new Date().toISOString(),
    completed_at: null,
    status: "in_progress",
    ...overrides,
  };
}

export function createMockTaskRun(overrides?: Partial<TaskRun>): TaskRun {
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    task_id: "task-1",
    project_id: "project-1",
    user_id: null,
    status: "executing",
    started_at: new Date().toISOString(),
    ended_at: null,
    stop_requested_at: null,
    latest_step_execution_id: null,
    outcome_kind: null,
    outcome_context: null,
    parent_task_run_id: null,
    root_task_run_id: null,
    triggered_by_step_execution_id: null,
    inserted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockTaskRunControls(
  activeRun: TaskRun,
  overrides?: Partial<TaskRunControls>
): TaskRunControls {
  return {
    runnable: false,
    stoppable: true,
    disabled_reason_code: "active_run",
    disabled_reason: "A TaskRun is already active",
    active_run: activeRun,
    ...overrides,
  };
}

/**
 * Create mock task data for testing
 */
export function createMockTask(overrides?: Partial<Task>): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    title: "Test Task",
    description: "A test task description",
    level: "task",
    priority: null,
    tags: [],
    workflow_id: null,
    current_step_id: null,
    workflow_name: null,
    step_name: null,
    step_type: null,
    run_controls: null,
    archived: false,
    worktree: null,
    rejection_reason: null,
    parent_id: null,
    dependency_ids: [],
    dependent_ids: [],
    child_ids: [],
    sections: [],
    code_refs: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}
