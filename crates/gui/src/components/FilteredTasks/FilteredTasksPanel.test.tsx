import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilteredTasksPanel } from "./FilteredTasksPanel";
import type { Task, Step } from "../../bindings";
import { commands } from "../../bindings";

// Mock the commands module
vi.mock("../../bindings", async () => {
  const actual = await vi.importActual("../../bindings");
  return {
    ...actual,
    commands: {
      createTask: vi.fn(),
      assignWorkflow: vi.fn(),
    },
  };
});

// Helper to create a step
function createStep(overrides?: Partial<Step>): Step {
  return {
    id: null,
    name: "Test Step",
    workflow_id: "workflow-1",
    goal: null,
    prompt: null,
    order: 0,
    is_final: false,
    transitions_to: [],
    step_type: "execute",
    output_schema: null,
    created_at: null,
    updated_at: null,
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

// Helper to create a task
function createTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-123",
    title: "Test Task",
    description: null,
    level: "task",
    priority: null,
    tags: [],
    workflow_id: null,
    current_step_id: null,
    workflow_name: null,
    step_name: "todo",
    needs_human_review: null,
    archived: false,
    worktree: null,
    review_comment: null,
    revision_feedback: null,
    rejection_reason: null,
    parent_id: null,
    sections: [],
    code_refs: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: null,
    started_at: null,
    completed_at: null,
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
      const step = createStep({ name: "Development" });
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      expect(screen.getByText("Development")).toBeInTheDocument();
    });

    it("renders step order badge (1-indexed)", () => {
      const step = createStep({ order: 2 });
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      // Order 2 displays as "3" (1-indexed)
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("renders task count", () => {
      const step = createStep();
      const tasks = [
        createTask({ id: "task-1" }),
        createTask({ id: "task-2" }),
      ];
      render(<FilteredTasksPanel step={step} tasks={tasks} workflowId="workflow-1" />);

      const matches = screen.getAllByText("2 tasks");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it("displays active task count derived from run_controls.active_run, not step_name", () => {
      const step = createStep();
      const activeRun = {
        id: "run-1",
        task_id: "task-1",
        project_id: "project-1",
        user_id: null,
        status: "executing" as const,
        started_at: "2024-01-01T00:00:00Z",
        ended_at: null,
        stop_requested_at: null,
        latest_step_execution_id: null,
        outcome_kind: null,
        outcome_context: null,
        parent_task_run_id: null,
        root_task_run_id: null,
        triggered_by_step_execution_id: null,
        inserted_at: null,
        updated_at: null,
      };
      const tasks = [
        // step_name is in_progress but no active TaskRun -- must NOT count.
        createTask({ id: "task-1", step_name: "in_progress" }),
        // No step_name signal but the daemon has an active run -- must count.
        createTask({
          id: "task-2",
          step_name: "todo",
          run_controls: {
            runnable: false,
            stoppable: true,
            disabled_reason_code: null,
            disabled_reason: null,
            active_run: { ...activeRun, task_id: "task-2" },
          },
        }),
        createTask({ id: "task-3", step_name: "todo" }),
      ];
      render(<FilteredTasksPanel step={step} tasks={tasks} workflowId="workflow-1" />);

      expect(screen.getByText("(1 active)")).toBeInTheDocument();
    });
  });

  describe("search functionality", () => {
    it("renders search input", () => {
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    });
  });

  describe("view mode toggle", () => {
    it("renders tree and list view toggle buttons", () => {
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      expect(screen.getByLabelText("Tree view")).toBeInTheDocument();
      expect(screen.getByLabelText("List view")).toBeInTheDocument();
    });

    it("defaults to tree view", () => {
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      const treeButton = screen.getByLabelText("Tree view");
      expect(treeButton).toHaveClass("bg-primary/10", "text-primary");
    });

    it("switches to list view when button clicked", async () => {
      const user = userEvent.setup();
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      const listButton = screen.getByLabelText("List view");
      await user.click(listButton);

      expect(listButton).toHaveClass("bg-primary/10", "text-primary");
      expect(screen.getByLabelText("Tree view")).not.toHaveClass("bg-primary/10");
    });
  });

  describe("close button", () => {
    it("renders close button when onClose is provided", () => {
      const step = createStep();
      const onClose = vi.fn();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" onClose={onClose} />);

      expect(screen.getByLabelText("Close panel")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", async () => {
      const user = userEvent.setup();
      const step = createStep();
      const onClose = vi.fn();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" onClose={onClose} />);

      await user.click(screen.getByLabelText("Close panel"));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not render close button when onClose is not provided", () => {
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      expect(screen.queryByLabelText("Close panel")).not.toBeInTheDocument();
    });
  });

  describe("task selection", () => {
    it("calls onTaskSelect when task is clicked in list view", async () => {
      const user = userEvent.setup();
      const step = createStep();
      const tasks = [
        createTask({ id: "task-1", title: "Test Task" }),
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

  describe("create task functionality", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("renders create task button with pointer cursor", () => {
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      const createButton = screen.getByLabelText("Create task");
      expect(createButton).toBeInTheDocument();
      expect(createButton).toHaveClass("cursor-pointer");
    });

    it("renders close button with pointer cursor", () => {
      const step = createStep();
      const onClose = vi.fn();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" onClose={onClose} />);

      const closeButton = screen.getByLabelText("Close panel");
      expect(closeButton).toBeInTheDocument();
      expect(closeButton).toHaveClass("cursor-pointer");
    });

    it("shows create form when add button is clicked", async () => {
      const user = userEvent.setup();
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));

      expect(screen.getByPlaceholderText("Task title...")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Description (optional)...")).toBeInTheDocument();
      expect(screen.getByText("Level:")).toBeInTheDocument();
      expect(screen.getByRole("combobox")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    });

    it("hides form when cancel is clicked", async () => {
      const user = userEvent.setup();
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      expect(screen.getByPlaceholderText("Task title...")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByPlaceholderText("Task title...")).not.toBeInTheDocument();
    });

    it("disables create button when title is empty", async () => {
      const user = userEvent.setup();
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));

      const createButton = screen.getByRole("button", { name: "Create" });
      expect(createButton).toBeDisabled();
    });

    it("enables create button when title is entered", async () => {
      const user = userEvent.setup();
      const step = createStep();
      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "New Task");

      const createButton = screen.getByRole("button", { name: "Create" });
      expect(createButton).toBeEnabled();
    });

    it("creates task and assigns workflow on submit", async () => {
      const user = userEvent.setup();
      const step = createStep();
      const onTaskSelect = vi.fn();

      vi.mocked(commands.createTask).mockResolvedValue({
        status: "ok",
        data: "new-task-id",
      });
      vi.mocked(commands.assignWorkflow).mockResolvedValue({
        status: "ok",
        data: null,
      });

      render(
        <FilteredTasksPanel
          step={step}
          tasks={[]}
          workflowId="workflow-1"
          onTaskSelect={onTaskSelect}
        />
      );

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "My New Task");
      await user.type(screen.getByPlaceholderText("Description (optional)..."), "Task description");
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(commands.createTask).toHaveBeenCalledWith(
          "My New Task",
          "Task description",
          "task",
          null
        );
      });

      await waitFor(() => {
        expect(commands.assignWorkflow).toHaveBeenCalledWith("new-task-id", "workflow-1");
      });

      await waitFor(() => {
        expect(onTaskSelect).toHaveBeenCalledWith("new-task-id");
      });

      // Form should be hidden after success
      expect(screen.queryByPlaceholderText("Task title...")).not.toBeInTheDocument();
    });

    it("creates task with selected level", async () => {
      const user = userEvent.setup();
      const step = createStep();

      vi.mocked(commands.createTask).mockResolvedValue({
        status: "ok",
        data: "new-task-id",
      });
      vi.mocked(commands.assignWorkflow).mockResolvedValue({
        status: "ok",
        data: null,
      });

      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "New Epic");
      await user.selectOptions(screen.getByRole("combobox"), "epic");
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(commands.createTask).toHaveBeenCalledWith(
          "New Epic",
          null,
          "epic",
          null
        );
      });
    });

    it("displays error when createTask fails", async () => {
      const user = userEvent.setup();
      const step = createStep();

      vi.mocked(commands.createTask).mockResolvedValue({
        status: "error",
        error: { message: "Failed to create task" },
      });

      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "New Task");
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(screen.getByText("Failed to create task")).toBeInTheDocument();
      });

      // Form should still be visible
      expect(screen.getByPlaceholderText("Task title...")).toBeInTheDocument();
    });

    it("displays error when assignWorkflow fails", async () => {
      const user = userEvent.setup();
      const step = createStep();

      vi.mocked(commands.createTask).mockResolvedValue({
        status: "ok",
        data: "new-task-id",
      });
      vi.mocked(commands.assignWorkflow).mockResolvedValue({
        status: "error",
        error: { message: "Workflow not found" },
      });

      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "New Task");
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(screen.getByText(/Task created but workflow assignment failed/)).toBeInTheDocument();
      });
    });

    it("shows loading state during submission", async () => {
      const user = userEvent.setup();
      const step = createStep();

      // Create a promise that we can control
      let resolveCreateTask: (value: unknown) => void;
      const createTaskPromise = new Promise((resolve) => {
        resolveCreateTask = resolve;
      });
      vi.mocked(commands.createTask).mockReturnValue(createTaskPromise as Promise<{ status: "ok"; data: string }>);

      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "New Task");
      await user.click(screen.getByRole("button", { name: "Create" }));

      // Should show loading state
      expect(screen.getByRole("button", { name: "Creating..." })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();

      // Resolve the promise
      resolveCreateTask!({ status: "ok", data: "new-task-id" });
    });

    it("disables inputs during submission", async () => {
      const user = userEvent.setup();
      const step = createStep();

      let resolveCreateTask: (value: unknown) => void;
      const createTaskPromise = new Promise((resolve) => {
        resolveCreateTask = resolve;
      });
      vi.mocked(commands.createTask).mockReturnValue(createTaskPromise as Promise<{ status: "ok"; data: string }>);

      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "New Task");
      await user.click(screen.getByRole("button", { name: "Create" }));

      // Inputs should be disabled
      expect(screen.getByPlaceholderText("Task title...")).toBeDisabled();
      expect(screen.getByPlaceholderText("Description (optional)...")).toBeDisabled();
      expect(screen.getByRole("combobox")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

      // Resolve the promise
      resolveCreateTask!({ status: "ok", data: "new-task-id" });
    });

    it("trims whitespace from title", async () => {
      const user = userEvent.setup();
      const step = createStep();

      vi.mocked(commands.createTask).mockResolvedValue({
        status: "ok",
        data: "new-task-id",
      });
      vi.mocked(commands.assignWorkflow).mockResolvedValue({
        status: "ok",
        data: null,
      });

      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "  Trimmed Title  ");
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(commands.createTask).toHaveBeenCalledWith(
          "Trimmed Title",
          null,
          "task",
          null
        );
      });
    });

    it("sends null for empty description", async () => {
      const user = userEvent.setup();
      const step = createStep();

      vi.mocked(commands.createTask).mockResolvedValue({
        status: "ok",
        data: "new-task-id",
      });
      vi.mocked(commands.assignWorkflow).mockResolvedValue({
        status: "ok",
        data: null,
      });

      render(<FilteredTasksPanel step={step} tasks={[]} workflowId="workflow-1" />);

      await user.click(screen.getByLabelText("Create task"));
      await user.type(screen.getByPlaceholderText("Task title..."), "Task without description");
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(commands.createTask).toHaveBeenCalledWith(
          "Task without description",
          null,
          "task",
          null
        );
      });
    });
  });

});
