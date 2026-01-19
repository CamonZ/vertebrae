import { render, type RenderOptions } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { BrowserRouter } from "react-router-dom";
import type { ReactElement, ReactNode } from "react";

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
 * Create mock workflow data for testing
 */
export function createMockWorkflow(overrides?: Partial<{
  id: string;
  name: string;
  steps: Array<{
    name: string;
    order: number;
    agent_config: {
      model: string;
      system_prompt: string;
      append_system_prompt: string;
      tools: string[];
      allowed_tools: string[];
      permission_mode: string | null;
    };
  }>;
}>) {
  return {
    id: "test-workflow-1",
    name: "Test Workflow",
    description: "A test workflow",
    is_default: false,
    on_done_workflow: null,
    on_reject_workflow: null,
    steps: [
      {
        name: "backlog",
        order: 0,
        agent_config: {
          model: "claude-3-sonnet",
          system_prompt: "",
          append_system_prompt: "",
          tools: [],
          allowed_tools: [],
          permission_mode: null,
        },
      },
      {
        name: "in_progress",
        order: 1,
        agent_config: {
          model: "claude-3-sonnet",
          system_prompt: "",
          append_system_prompt: "",
          tools: [],
          allowed_tools: [],
          permission_mode: null,
        },
      },
      {
        name: "done",
        order: 2,
        agent_config: {
          model: "claude-3-sonnet",
          system_prompt: "",
          append_system_prompt: "",
          tools: [],
          allowed_tools: [],
          permission_mode: null,
        },
      },
    ],
    ...overrides,
  };
}

/**
 * Create mock Step entities for testing (first-class steps)
 */
export function createMockSteps(workflowId = "test-workflow-1") {
  return [
    {
      id: "step-backlog",
      workflow_id: workflowId,
      name: "backlog",
      order: 0,
      agent_config: {
        model: "claude-3-sonnet",
        system_prompt: "",
        append_system_prompt: "",
        tools: [],
        allowed_tools: [],
        permission_mode: null,
      },
      created_at: null,
      updated_at: null,
    },
    {
      id: "step-in_progress",
      workflow_id: workflowId,
      name: "in_progress",
      order: 1,
      agent_config: {
        model: "claude-3-sonnet",
        system_prompt: "",
        append_system_prompt: "",
        tools: [],
        allowed_tools: [],
        permission_mode: null,
      },
      created_at: null,
      updated_at: null,
    },
    {
      id: "step-done",
      workflow_id: workflowId,
      name: "done",
      order: 2,
      agent_config: {
        model: "claude-3-sonnet",
        system_prompt: "",
        append_system_prompt: "",
        tools: [],
        allowed_tools: [],
        permission_mode: null,
      },
      created_at: null,
      updated_at: null,
    },
  ];
}

/**
 * Create mock task data for testing
 */
export function createMockTask(overrides?: Partial<{
  id: string;
  title: string;
  description: string;
  status: string;
  level: string;
  parent_id: string | null;
  workflow_id: string | null;
  current_step: number | null;
  current_step_id: string | null;
}>) {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    title: "Test Task",
    description: "A test task description",
    status: "backlog",
    level: "task",
    parent_id: null,
    workflow_id: null,
    current_step: null,
    current_step_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create mock task with relations for testing
 */
export function createMockTaskWithRelations(overrides?: Partial<{
  task: ReturnType<typeof createMockTask>;
  depends_on_ids: string[];
  dependent_ids: string[];
}>) {
  return {
    task: createMockTask(overrides?.task),
    depends_on_ids: [],
    dependent_ids: [],
    ...overrides,
  };
}
