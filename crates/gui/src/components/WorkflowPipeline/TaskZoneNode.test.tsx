import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { TaskZoneNode, type TaskZoneNodeData } from "./TaskZoneNode";
import type { Task, TaskWithRelations, Step, AgentConfig } from "../../bindings";

/**
 * Create a complete Task with defaults
 */
function createTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    title: "Test Task",
    description: null,
    level: "task",
    status: "pending",
    priority: null,
    tags: [],
    created_at: null,
    updated_at: null,
    needs_human_review: false,
    current_workflow_id: null,
    current_step_id: null,
    sections: [],
    code_refs: [],
    ...overrides,
  };
}

/**
 * Create a complete TaskWithRelations with defaults
 */
function createTaskWithRelations(
  overrides?: Partial<TaskWithRelations> & { task?: Partial<Task> }
): TaskWithRelations {
  const { task: taskOverrides, ...relationOverrides } = overrides || {};
  return {
    task: createTask(taskOverrides),
    parent_id: null,
    children_ids: [],
    depends_on_ids: [],
    dependents_ids: [],
    ...relationOverrides,
  };
}

/**
 * Create a complete AgentConfig with defaults
 */
function createAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
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
function createStep(overrides?: Partial<Step>): Step {
  return {
    id: null,
    name: "Test Step",
    workflow_id: "workflow-1",
    agent_config: createAgentConfig(),
    is_final: false,
    transitions_to: [],
    order: 0,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

/**
 * Create TaskZoneNode props
 */
function createTaskZoneNodeProps(overrides?: Partial<TaskZoneNodeData>) {
  const defaultData: TaskZoneNodeData = {
    label: "Test Zone",
    tasks: [],
    ...overrides,
  };

  return {
    id: "task-zone-0",
    type: "taskZoneNode" as const,
    data: defaultData,
    selected: false,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    draggable: true,
    dragHandle: undefined,
    selectable: true,
    deletable: true,
    parentId: undefined,
  };
}

describe("TaskZoneNode", () => {
  describe("rendering", () => {
    it("renders zone label", () => {
      const props = createTaskZoneNodeProps({ label: "Coding (3)" });
      render(<TaskZoneNode {...props} />);
      expect(screen.getByText("Coding (3)")).toBeInTheDocument();
    });

    it("renders empty state when no tasks", () => {
      const props = createTaskZoneNodeProps({ tasks: [] });
      render(<TaskZoneNode {...props} />);
      expect(screen.getByText("No tasks")).toBeInTheDocument();
    });

    it("renders task titles", () => {
      const props = createTaskZoneNodeProps({
        tasks: [
          createTaskWithRelations({ task: { title: "First Task" } }),
          createTaskWithRelations({ task: { id: "task-2", title: "Second Task" } }),
        ],
      });
      render(<TaskZoneNode {...props} />);
      expect(screen.getByText("First Task")).toBeInTheDocument();
      expect(screen.getByText("Second Task")).toBeInTheDocument();
    });

    it("renders truncated task IDs", () => {
      const props = createTaskZoneNodeProps({
        tasks: [
          createTaskWithRelations({ task: { id: "abc12345678" } }),
        ],
      });
      render(<TaskZoneNode {...props} />);
      // ID is sliced to first 8 characters
      expect(screen.getByText("abc12345")).toBeInTheDocument();
    });
  });

  describe("task status display", () => {
    it("shows checkmark icon for done tasks", () => {
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { status: "done" } })],
      });
      render(<TaskZoneNode {...props} />);
      expect(screen.getByText("✓")).toBeInTheDocument();
    });

    it("shows checkmark icon for rejected tasks (treated as done)", () => {
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { status: "rejected" } })],
      });
      render(<TaskZoneNode {...props} />);
      expect(screen.getByText("✓")).toBeInTheDocument();
    });

    it("shows spinning icon for in_progress from execution state", () => {
      const executionState = new Map([
        ["task-1", { currentStep: 1, status: "in_progress" }],
      ]);
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { status: "pending" } })],
        executionState,
      });
      render(<TaskZoneNode {...props} />);
      expect(screen.getByText("⟳")).toBeInTheDocument();
    });

    it("shows X icon for failed from execution state", () => {
      const executionState = new Map([
        ["task-1", { currentStep: 1, status: "failed", error: "Something went wrong" }],
      ]);
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { status: "pending" } })],
        executionState,
      });
      render(<TaskZoneNode {...props} />);
      expect(screen.getByText("✕")).toBeInTheDocument();
    });

    it("shows circle icon for waiting tasks", () => {
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { status: "pending" } })],
      });
      render(<TaskZoneNode {...props} />);
      expect(screen.getByText("○")).toBeInTheDocument();
    });
  });

  describe("task level indicators", () => {
    it("renders level dot for epic", () => {
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { level: "epic" } })],
      });
      const { container } = render(<TaskZoneNode {...props} />);
      const levelDot = container.querySelector(".bg-info");
      expect(levelDot).toBeInTheDocument();
    });

    it("renders level dot for ticket", () => {
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { level: "ticket" } })],
      });
      const { container } = render(<TaskZoneNode {...props} />);
      const levelDot = container.querySelector(".bg-primary");
      expect(levelDot).toBeInTheDocument();
    });

    it("renders level dot for task", () => {
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { level: "task" } })],
      });
      const { container } = render(<TaskZoneNode {...props} />);
      const levelDot = container.querySelector(".bg-text-secondary");
      expect(levelDot).toBeInTheDocument();
    });
  });

  describe("selection state", () => {
    it("highlights selected task", () => {
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { id: "task-1" } })],
        selectedTaskId: "task-1",
      });
      const { container } = render(<TaskZoneNode {...props} />);
      // Selected tasks have ring-primary/50 class
      const selectedTask = container.querySelector(".ring-primary\\/50");
      expect(selectedTask).toBeInTheDocument();
    });

    it("does not highlight unselected tasks", () => {
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { id: "task-1" } })],
        selectedTaskId: "task-2", // Different task selected
      });
      const { container } = render(<TaskZoneNode {...props} />);
      const selectedTask = container.querySelector(".ring-primary\\/50");
      expect(selectedTask).not.toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("calls onTaskClick when task is clicked", () => {
      const onTaskClick = vi.fn();
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { id: "task-1", title: "Click Me" } })],
        onTaskClick,
      });
      render(<TaskZoneNode {...props} />);

      fireEvent.click(screen.getByText("Click Me"));
      expect(onTaskClick).toHaveBeenCalledWith("task-1");
    });

    it("calls onZoneClick when zone label is clicked", () => {
      const onZoneClick = vi.fn();
      const step = createStep({ name: "Coding", order: 1 });
      const props = createTaskZoneNodeProps({
        label: "Coding (0)",
        step,
        onZoneClick,
      });
      render(<TaskZoneNode {...props} />);

      fireEvent.click(screen.getByText("Coding (0)"));
      expect(onZoneClick).toHaveBeenCalledWith(step);
    });

    it("does not call onZoneClick when step is not provided", () => {
      const onZoneClick = vi.fn();
      const props = createTaskZoneNodeProps({
        label: "Test Zone",
        onZoneClick,
        step: undefined,
      });
      render(<TaskZoneNode {...props} />);

      fireEvent.click(screen.getByText("Test Zone"));
      expect(onZoneClick).not.toHaveBeenCalled();
    });

    it("stops propagation when task is clicked", () => {
      const onTaskClick = vi.fn();
      const props = createTaskZoneNodeProps({
        tasks: [createTaskWithRelations({ task: { id: "task-1", title: "Click Me" } })],
        onTaskClick,
      });
      render(<TaskZoneNode {...props} />);

      const taskButton = screen.getByText("Click Me").closest("button");
      const clickEvent = new MouseEvent("click", { bubbles: true });
      vi.spyOn(clickEvent, "stopPropagation");

      fireEvent(taskButton!, clickEvent);
      expect(clickEvent.stopPropagation).toHaveBeenCalled();
    });
  });

  describe("active zone styling", () => {
    it("applies active styles when isZoneActive is true", () => {
      const props = createTaskZoneNodeProps({
        label: "Active Zone",
        isZoneActive: true,
      });
      const { container } = render(<TaskZoneNode {...props} />);
      const label = container.querySelector(".text-primary.font-bold");
      expect(label).toBeInTheDocument();
    });

    it("applies default styles when isZoneActive is false", () => {
      const props = createTaskZoneNodeProps({
        label: "Inactive Zone",
        isZoneActive: false,
      });
      const { container } = render(<TaskZoneNode {...props} />);
      const label = container.querySelector(".text-text-muted");
      expect(label).toBeInTheDocument();
    });
  });
});
