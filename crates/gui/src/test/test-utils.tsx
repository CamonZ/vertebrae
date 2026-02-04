import { render, type RenderOptions } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { BrowserRouter } from "react-router-dom";
import type { ReactElement, ReactNode } from "react";
import type { Task, Workflow, Step, AgentConfig } from "../bindings";

/**
 * Custom render function that wraps components with necessary providers
 */
function customRender(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <BrowserRouter>
      <ReactFlowProvider>{children}</ReactFlowProvider>
    </BrowserRouter>
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
export function createMockAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: null,
    fallback_model: null,
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
    agent_config: createMockAgentConfig({ model: "claude-3-sonnet" }),
    is_final: false,
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
      is_final: true,
    }),
  ];
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
    needs_human_review: null,
    review_comment: null,
    revision_feedback: null,
    rejection_reason: null,
    parent_id: null,
    dependency_ids: [],
    sections: [],
    code_refs: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}
