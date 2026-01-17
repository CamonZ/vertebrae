import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilteredTasksPanel } from "./FilteredTasksPanel";
import type { TaskSummary, WorkflowStep } from "../../bindings";

// Helper to create a workflow step
function createWorkflowStep(overrides?: Partial<WorkflowStep>): WorkflowStep {
  return {
    name: "Test Step",
    order: 0,
    agent_config: {
      model: null,
      fallback_model: null,
      system_prompt: null,
      append_system_prompt: null,
      tools: [],
      allowed_tools: [],
      disallowed_tools: [],
      permission_mode: null,
      max_budget_usd: null,
      mcp_config: [],
      plugin_dirs: [],
      agents: null,
      json_schema: null,
    },
    ...overrides,
  };
}

// Helper to create a task summary
function createTaskSummary(
  overrides?: Partial<TaskSummary>
): TaskSummary {
  return {
    id: "task-123",
    title: "Test Task",
    description: "Test description",
    status: "todo",
    level: "task",
    priority: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    started_at: null,
    completed_at: null,
    needs_human_review: false,
    tags: [],
    sections: [],
    code_refs: [],
    workflow_id: null,
    current_step: null,
    ...overrides,
  };
}

describe("FilteredTasksPanel", () => {
  describe("rendering", () => {
    it("returns null when step is null", () => {
      const { container } = render(
        <FilteredTasksPanel step={null} tasks={[]} workflowId="workflow-1" />
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders step name in panel", () => {
      const step = createWorkflowStep({ name: "Development" });
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      expect(screen.getByText("Development")).toBeInTheDocument();
    });

    it("renders step order badge (1-indexed)", () => {
      const step = createWorkflowStep({ order: 2 });
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      // Order 2 displays as "3" (1-indexed)
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("renders task count", () => {
      const step = createWorkflowStep();
      const tasks = [
        createTaskSummary({ id: "task-1" }),
        createTaskSummary({ id: "task-2" }),
      ];
      render(<FilteredTasksPanel step={step} tasks={tasks} workflowId="workflow-1" />);

      expect(screen.getByText("2 tasks")).toBeInTheDocument();
    });

    it("displays active task count", () => {
      const step = createWorkflowStep();
      const tasks = [
        createTaskSummary({ id: "task-1", status: "in_progress" }),
        createTaskSummary({ id: "task-2", status: "todo" }),
      ];
      render(<FilteredTasksPanel step={step} tasks={tasks} workflowId="workflow-1" />);

      expect(screen.getByText("(1 active)")).toBeInTheDocument();
    });
  });

  describe("search functionality", () => {
    it("renders search input", () => {
      const step = createWorkflowStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    });
  });

  describe("view mode toggle", () => {
    it("renders tree and list view toggle buttons", () => {
      const step = createWorkflowStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      expect(screen.getByLabelText("Tree view")).toBeInTheDocument();
      expect(screen.getByLabelText("List view")).toBeInTheDocument();
    });

    it("defaults to tree view", () => {
      const step = createWorkflowStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      const treeButton = screen.getByLabelText("Tree view");
      expect(treeButton).toHaveClass("bg-primary/10", "text-primary");
    });

    it("switches to list view when button clicked", async () => {
      const user = userEvent.setup();
      const step = createWorkflowStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      const listButton = screen.getByLabelText("List view");
      await user.click(listButton);

      expect(listButton).toHaveClass("bg-primary/10", "text-primary");
      expect(screen.getByLabelText("Tree view")).not.toHaveClass("bg-primary/10");
    });
  });

  describe("close button", () => {
    it("renders close button when onClose is provided", () => {
      const step = createWorkflowStep();
      const onClose = vi.fn();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" onClose={onClose} />);

      expect(screen.getByLabelText("Close panel")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", async () => {
      const user = userEvent.setup();
      const step = createWorkflowStep();
      const onClose = vi.fn();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" onClose={onClose} />);

      await user.click(screen.getByLabelText("Close panel"));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not render close button when onClose is not provided", () => {
      const step = createWorkflowStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      expect(screen.queryByLabelText("Close panel")).not.toBeInTheDocument();
    });
  });

  describe("task selection", () => {
    it("calls onTaskSelect when task is clicked in list view", async () => {
      const user = userEvent.setup();
      const step = createWorkflowStep();
      const tasks = [
        createTaskSummary({ id: "task-1", title: "Test Task" }),
      ];
      const onTaskSelect = vi.fn();
      render(
        <FilteredTasksPanel
          step={step}
          tasks={tasks}
          workflowId="workflow-1"
          onTaskSelect={onTaskSelect}
        />
      );

      // Switch to list view
      await user.click(screen.getByLabelText("List view"));

      // Find and click the task
      const taskElement = await screen.findByText("Test Task");
      await user.click(taskElement);

      expect(onTaskSelect).toHaveBeenCalledWith("task-1");
    });
  });

});
