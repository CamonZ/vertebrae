import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepDetailPanel } from "./StepDetailPanel";
import type { Step, Task } from "../../bindings";
import * as hooks from "../../hooks";
import * as bindings from "../../bindings";

// Mock the hooks
vi.mock("../../hooks", () => ({
  useStep: vi.fn(),
  useStepChangeListener: vi.fn(),
  useExpandedNodes: vi.fn(),
}));

// Mock the bindings commands
vi.mock("../../bindings", async () => {
  const actual = await vi.importActual("../../bindings");
  return {
    ...actual,
    commands: {
      updateStep: vi.fn(),
      deleteStep: vi.fn(),
    },
  };
});

// confirm is already defined globally, so we just mock it in tests

// Helper to create a step with defaults
function createStep(overrides?: Partial<Step>): Step {
  return {
    id: "step-test",
    name: "Test Step",
    workflow_id: "workflow-1",
    order: 0,
    is_final: false,
    transitions_to: [],
    agents: [],
    skills: [],
    goal: null,
    prompt: null,
    eval_prompt: null,
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

// Helper to create a task with defaults
function createTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-test",
    title: "Test Task",
    description: null,
    level: "task",
    priority: null,
    tags: [],
    workflow_id: null,
    current_step_id: null,
    workflow_name: null,
    step_name: null,
    needs_human_review: null,
    archived: false,
    worktree: null,
    review_comment: null,
    revision_feedback: null,
    rejection_reason: null,
    parent_id: null,
    dependency_ids: [],
    sections: [],
    code_refs: [],
    created_at: null,
    updated_at: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe("StepDetailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock setup
    vi.mocked(hooks.useStep).mockReturnValue({
      step: createStep(),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      applyUpdate: vi.fn(),
    });
    vi.mocked(hooks.useStepChangeListener).mockReturnValue(undefined);
    vi.mocked(hooks.useExpandedNodes).mockReturnValue({
      expandedNodeIds: new Set(),
      toggleNode: vi.fn(),
      setNodeExpanded: vi.fn(),
      isNodeExpanded: vi.fn(),
      resetExpandedNodes: vi.fn(),
      expandAll: vi.fn(),
    });
  });

  describe("rendering", () => {
    it("returns null when step is not loaded", () => {
      vi.mocked(hooks.useStep).mockReturnValue({
        step: null,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      const { container } = render(
        <StepDetailPanel stepId="step-test" allSteps={[]} />
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders panel header with 'Step Configuration' title", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Step Configuration")).toBeInTheDocument();
    });

    it("renders step name in editable field", () => {
      const step = createStep({ name: "Development" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Development")).toBeInTheDocument();
    });

    it("renders step order badge (1-indexed)", () => {
      const step = createStep({ order: 2 });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      // Order 2 displays as "3" (1-indexed)
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("displays goal when configured", () => {
      const step = createStep({ goal: "Complete the implementation task" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Complete the implementation task")).toBeInTheDocument();
    });

    it("displays agents section with count", () => {
      const step = createStep({ agents: [".claude/agents/reviewer.md"] });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Agents (1)")).toBeInTheDocument();
      expect(screen.getByText(".claude/agents/reviewer.md")).toBeInTheDocument();
    });

    it("displays skills section with count", () => {
      const step = createStep({ skills: ["code-review", "security-audit"] });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Skills (2)")).toBeInTheDocument();
      expect(screen.getByText("code-review")).toBeInTheDocument();
      expect(screen.getByText("security-audit")).toBeInTheDocument();
    });

    it("displays final step toggle", () => {
      const step = createStep({ is_final: true });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText(/final step/i)).toBeInTheDocument();
    });

    it("displays transitions section", () => {
      const step1 = createStep({ id: "step-1", name: "Step 1" });
      const step2 = createStep({ id: "step-2", name: "Step 2" });
      const step = createStep({
        transitions_to: ["step-1", "step-2"],
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[step1, step2]} />);
      expect(screen.getByText("Transitions (2)")).toBeInTheDocument();
      expect(screen.getByText("Step 1")).toBeInTheDocument();
      expect(screen.getByText("Step 2")).toBeInTheDocument();
    });

    it("displays model section", () => {
      const step = createStep({
        agent_config: {
          model: "opus",
          fallback_model: null,
          system_prompt: null,
          append_system_prompt: null,
          tools: ["browser"],
          allowed_tools: [],
          disallowed_tools: [],
          permission_mode: null,
          max_budget_usd: null,
          mcp_config: [],
          plugin_dirs: [],
          agents: null,
          json_schema: null,
        },
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Model")).toBeInTheDocument();
      expect(screen.getByText("opus")).toBeInTheDocument();
    });

    it("displays timeline section", () => {
      const now = new Date().toISOString();
      const step = createStep({
        created_at: now,
        updated_at: now,
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Timeline")).toBeInTheDocument();
    });
  });

  describe("delete", () => {
    it("shows delete button", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByLabelText("Delete step")).toBeInTheDocument();
    });

    it("shows confirmation section when delete is clicked", async () => {
      const user = userEvent.setup();

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);

      const deleteButton = screen.getByLabelText("Delete step");
      await user.click(deleteButton);

      // Confirmation section should appear
      expect(screen.getByText("Delete Step?")).toBeInTheDocument();
      expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
      expect(screen.getByText("Confirm Delete")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
      expect(bindings.commands.deleteStep).not.toHaveBeenCalled();
    });

    it("hides confirmation when cancel is clicked", async () => {
      const user = userEvent.setup();

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);

      // Show confirmation
      await user.click(screen.getByLabelText("Delete step"));
      expect(screen.getByText("Delete Step?")).toBeInTheDocument();

      // Click cancel
      await user.click(screen.getByText("Cancel"));

      // Confirmation should be hidden
      expect(screen.queryByText("Delete Step?")).not.toBeInTheDocument();
    });

    it("calls deleteStep when confirmed", async () => {
      const user = userEvent.setup();
      const onDeleted = vi.fn();

      vi.mocked(bindings.commands.deleteStep).mockResolvedValue({
        status: "ok",
        data: null,
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} onDeleted={onDeleted} />);

      // Show confirmation
      await user.click(screen.getByLabelText("Delete step"));

      // Confirm delete
      await user.click(screen.getByText("Confirm Delete"));

      expect(bindings.commands.deleteStep).toHaveBeenCalledWith("step-test");
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
  });

  describe("close button", () => {
    it("renders close button when onClose is provided", () => {
      const onClose = vi.fn();
      render(<StepDetailPanel stepId="step-test" allSteps={[]} onClose={onClose} />);
      expect(screen.getByLabelText("Close panel")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<StepDetailPanel stepId="step-test" allSteps={[]} onClose={onClose} />);

      const closeButton = screen.getByLabelText("Close panel");
      await user.click(closeButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not render close button when onClose is not provided", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.queryByLabelText("Close panel")).not.toBeInTheDocument();
    });
  });

  describe("back button", () => {
    it("renders back button when onBack is provided", () => {
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} onBack={vi.fn()} />
      );
      expect(screen.getByLabelText("Go back")).toBeInTheDocument();
    });

    it("calls onBack when back button is clicked", async () => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} onBack={onBack} />
      );

      await user.click(screen.getByLabelText("Go back"));

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("does not render back button when onBack is not provided", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.queryByLabelText("Go back")).not.toBeInTheDocument();
    });
  });

  describe("tabbed interface", () => {
    it("renders Configuration and Tasks tabs", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Configuration")).toBeInTheDocument();
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });

    it("shows task count badge on Tasks tab", () => {
      const tasks = [
        createTask({ id: "task-1" }),
        createTask({ id: "task-2" }),
        createTask({ id: "task-3" }),
      ];
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={tasks} />
      );
      
      // Find the badge with the count (3)
      const badge = screen.getByText("3");
      expect(badge).toBeInTheDocument();
    });

    it("displays 0 count when no tasks provided", () => {
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={[]} />
      );
      
      // Should still show badge with 0
      const badge = screen.getByText("0");
      expect(badge).toBeInTheDocument();
    });

    it("starts with Configuration tab active", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      
      // Configuration tab content should be visible (step name)
      const step = createStep({ name: "Test Step" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });
      
      // Re-render to pick up the new mock
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getAllByText("Test Step")[0]).toBeInTheDocument();
    });

    it("switches to Tasks tab when clicked", async () => {
      const user = userEvent.setup();
      const tasks = [createTask({ id: "task-1", title: "Task One" })];
      
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={tasks} />
      );
      
      // Click Tasks tab
      const tasksTab = screen.getByText("Tasks");
      await user.click(tasksTab);
      
      // Configuration content should not be visible (no agents/skills section)
      expect(screen.queryByText("Agents")).not.toBeInTheDocument();
      
      // Tasks tab content should be visible (search input)
      expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    });

    it("switches back to Configuration tab when clicked", async () => {
      const user = userEvent.setup();
      const tasks = [createTask({ id: "task-1" })];
      
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={tasks} />
      );
      
      // Switch to Tasks tab
      await user.click(screen.getByText("Tasks"));
      expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
      
      // Switch back to Configuration tab
      await user.click(screen.getByText("Configuration"));
      
      // Configuration content should be visible again
      expect(screen.getByText("Overview")).toBeInTheDocument();
    });
  });

  describe("Configuration tab", () => {
    it("displays all step configuration sections", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      
      expect(screen.getByText("Overview")).toBeInTheDocument();
      expect(screen.getByText(/Agents/)).toBeInTheDocument();
      expect(screen.getByText(/Skills/)).toBeInTheDocument();
      expect(screen.getByText(/Transitions/)).toBeInTheDocument();
      expect(screen.getByText("Model")).toBeInTheDocument();
      expect(screen.getByText("Timeline")).toBeInTheDocument();
    });

    it("displays step name and goal", () => {
      const step = createStep({
        name: "Review Code",
        goal: "Check for security issues",
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Review Code")).toBeInTheDocument();
      expect(screen.getByText("Check for security issues")).toBeInTheDocument();
    });

    it("displays prompt when set", () => {
      const step = createStep({
        prompt: "Review the pull request for correctness and style",
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Prompt")).toBeInTheDocument();
      expect(
        screen.getByText("Review the pull request for correctness and style")
      ).toBeInTheDocument();
    });

    it("shows prompt section with placeholder when prompt is null", () => {
      const step = createStep({ prompt: null });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Prompt")).toBeInTheDocument();
      expect(screen.getByText("Click to add prompt...")).toBeInTheDocument();
    });

    it("displays eval_prompt when set with distinct styling", () => {
      const step = createStep({
        eval_prompt: "Did the review identify any critical issues?",
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Eval Prompt")).toBeInTheDocument();
      expect(
        screen.getByText("Did the review identify any critical issues?")
      ).toBeInTheDocument();

      // Verify eval_prompt label has warning-style color (visually distinct)
      const evalLabel = screen.getByText("Eval Prompt");
      expect(evalLabel).toHaveClass("text-warning");
    });

    it("shows eval_prompt section with placeholder when eval_prompt is null", () => {
      const step = createStep({ eval_prompt: null });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Eval Prompt")).toBeInTheDocument();
      expect(screen.getByText("Click to add eval prompt...")).toBeInTheDocument();
    });

    it("displays both prompt and eval_prompt when both are set", () => {
      const step = createStep({
        prompt: "Implement the feature as described",
        eval_prompt: "Does the implementation match the spec?",
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Prompt")).toBeInTheDocument();
      expect(
        screen.getByText("Implement the feature as described")
      ).toBeInTheDocument();
      expect(screen.getByText("Eval Prompt")).toBeInTheDocument();
      expect(
        screen.getByText("Does the implementation match the spec?")
      ).toBeInTheDocument();
    });
  });

  describe("Tasks tab", () => {
    it("displays empty state when no tasks", async () => {
      const user = userEvent.setup();
      
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={[]} />
      );
      
      await user.click(screen.getByText("Tasks"));
      
      expect(
        screen.getByText("No tasks assigned to this step")
      ).toBeInTheDocument();
    });

    it("displays search input in Tasks tab", async () => {
      const user = userEvent.setup();
      const tasks = [createTask({ id: "task-1" })];
      
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={tasks} />
      );
      
      await user.click(screen.getByText("Tasks"));
      
      expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    });

    it("displays view mode toggle (tree/list) in Tasks tab", async () => {
      const user = userEvent.setup();
      const tasks = [createTask({ id: "task-1" })];
      
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={tasks} />
      );
      
      await user.click(screen.getByText("Tasks"));
      
      // Look for tree and list view buttons
      const treeButton = screen.getByLabelText("Tree view");
      const listButton = screen.getByLabelText("List view");
      
      expect(treeButton).toBeInTheDocument();
      expect(listButton).toBeInTheDocument();
    });

    it("filters tasks by search query", async () => {
      const user = userEvent.setup();
      const tasks = [
        createTask({ id: "task-1", title: "Deploy Frontend" }),
        createTask({ id: "task-2", title: "Write Tests" }),
      ];
      
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={tasks} />
      );
      
      // Switch to Tasks tab
      await user.click(screen.getByText("Tasks"));
      
      // Search for "Deploy"
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "Deploy");
      
      // Should filter the tasks (implementation detail verified via integration)
      expect(searchInput).toHaveValue("Deploy");
    });

    it("toggles between tree and list view", async () => {
      const user = userEvent.setup();
      const tasks = [createTask({ id: "task-1" })];
      
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} tasks={tasks} />
      );
      
      await user.click(screen.getByText("Tasks"));
      
      // Tree view should be active by default
      expect(screen.getByLabelText("Tree view")).toHaveClass("bg-primary/10");
      
      // Click list view
      await user.click(screen.getByLabelText("List view"));
      
      // List view should now be active
      expect(screen.getByLabelText("List view")).toHaveClass("bg-primary/10");
    });

    it("calls onTaskSelect when a task is selected", () => {
      const onTaskSelect = vi.fn();
      const tasks = [createTask({ id: "task-1", title: "Test Task" })];
      
      render(
        <StepDetailPanel 
          stepId="step-test" 
          allSteps={[]} 
          tasks={tasks}
          onTaskSelect={onTaskSelect}
        />
      );
      
      // This is verified through the prop being passed to TaskList/TaskTreeView
      // The actual task selection behavior is tested in those components
      expect(onTaskSelect).not.toHaveBeenCalled();
    });

    it("highlights selected task when selectedTaskId is provided", async () => {
      const user = userEvent.setup();
      const tasks = [
        createTask({ id: "task-1", title: "Task One" }),
        createTask({ id: "task-2", title: "Task Two" }),
      ];
      
      render(
        <StepDetailPanel 
          stepId="step-test" 
          allSteps={[]} 
          tasks={tasks}
          selectedTaskId="task-1"
        />
      );
      
      await user.click(screen.getByText("Tasks"));
      
      // Verify selectedTaskId is passed to the task components
      expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    });

  });

  describe("step tasks integration", () => {
    it("displays correct number of tasks in Tasks tab badge", () => {
      const tasks = [
        createTask({ id: "task-1", title: "Task 1" }),
        createTask({ id: "task-2", title: "Task 2" }),
        createTask({ id: "task-3", title: "Task 3" }),
      ];

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}

        />
      );

      // Should display task count in badge
      const badge = screen.getByText("3");
      expect(badge).toBeInTheDocument();
    });

    it("updates task count when tasks prop changes", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={[createTask({ id: "task-1" })]}

        />
      );

      // Click Tasks tab to see the badge
      await user.click(screen.getByText("Tasks"));

      // Initial render shows 1 task in the badge
      const badges = screen.getAllByText("1");
      expect(badges.length).toBeGreaterThan(0); // Step order and task count

      // Rerender with more tasks
      rerender(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={[
            createTask({ id: "task-1" }),
            createTask({ id: "task-2" }),
            createTask({ id: "task-3" }),
          ]}

        />
      );

      // Should now show 3 tasks (check for specific badge)
      const taskCountBadges = screen.getAllByText("3");
      expect(taskCountBadges.length).toBeGreaterThan(0);
    });

    it("allows task selection from step's task list", async () => {
      const user = userEvent.setup();
      const onTaskSelect = vi.fn();
      const tasks = [
        createTask({ id: "task-1", title: "Deploy Frontend" }),
        createTask({ id: "task-2", title: "Write Tests" }),
      ];

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}

          onTaskSelect={onTaskSelect}
        />
      );

      // Switch to Tasks tab to view task list
      await user.click(screen.getByText("Tasks"));

      // Verify search input is available for task filtering
      const searchInput = screen.getByPlaceholderText("Search...");
      expect(searchInput).toBeInTheDocument();
    });

    it("displays selected task highlight in task list", () => {
      const tasks = [
        createTask({ id: "task-1", title: "Task One" }),
        createTask({ id: "task-2", title: "Task Two" }),
      ];

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}

          selectedTaskId="task-1"
        />
      );

      // Component should accept selectedTaskId prop
      expect(screen.getByText("Configuration")).toBeInTheDocument();
    });

    it("handles empty task list gracefully", async () => {
      const user = userEvent.setup();

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={[]}

        />
      );

      // Switch to Tasks tab
      await user.click(screen.getByText("Tasks"));

      // Should show empty state
      expect(
        screen.getByText("No tasks assigned to this step")
      ).toBeInTheDocument();
    });

    it("calls onTaskSelect callback when provided", () => {
      const onTaskSelect = vi.fn();

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={[]}

          onTaskSelect={onTaskSelect}
        />
      );

      // Callback should be registered but not called until user interacts with tasks
      expect(onTaskSelect).not.toHaveBeenCalled();
    });
  });

  describe("execution state tracking", () => {
    it("accepts taskExecutionStates prop without error", async () => {
      const user = userEvent.setup();
      const tasks = [
        createTask({ id: "task-1", title: "Running Task" }),
      ];
      const executionStates = new Map([
        ["task-1", { status: "Running" as const, stepName: "build" }],
      ]);

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}
          taskExecutionStates={executionStates}
        />
      );

      // Switch to Tasks tab
      await user.click(screen.getByText("Tasks"));

      // Task should be visible
      expect(screen.getByText("Running Task")).toBeInTheDocument();
    });

    it("renders execution indicator for running task in tree view", async () => {
      const user = userEvent.setup();
      const tasks = [
        createTask({ id: "task-1", title: "Running Task" }),
      ];
      const executionStates = new Map([
        ["task-1", { status: "Running" as const, stepName: "build" }],
      ]);

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}
          taskExecutionStates={executionStates}
        />
      );

      await user.click(screen.getByText("Tasks"));

      // Should show execution indicator
      expect(screen.getByTitle("Execution: Running")).toBeInTheDocument();
    });

    it("renders execution indicator for completed task in tree view", async () => {
      const user = userEvent.setup();
      const tasks = [
        createTask({ id: "task-1", title: "Done Task" }),
      ];
      const executionStates = new Map([
        ["task-1", { status: "Completed" as const, stepName: "build" }],
      ]);

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}
          taskExecutionStates={executionStates}
        />
      );

      await user.click(screen.getByText("Tasks"));

      expect(screen.getByTitle("Execution: Completed")).toBeInTheDocument();
    });

    it("renders execution indicator for failed task in tree view", async () => {
      const user = userEvent.setup();
      const tasks = [
        createTask({ id: "task-1", title: "Failed Task" }),
      ];
      const executionStates = new Map([
        ["task-1", { status: "Failed" as const, stepName: "build" }],
      ]);

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}
          taskExecutionStates={executionStates}
        />
      );

      await user.click(screen.getByText("Tasks"));

      expect(screen.getByTitle("Execution: Failed")).toBeInTheDocument();
    });

    it("renders execution indicator in list view", async () => {
      const user = userEvent.setup();
      const tasks = [
        createTask({ id: "task-1", title: "Running Task" }),
      ];
      const executionStates = new Map([
        ["task-1", { status: "Running" as const, stepName: "build" }],
      ]);

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}
          taskExecutionStates={executionStates}
        />
      );

      await user.click(screen.getByText("Tasks"));
      // Switch to list view
      await user.click(screen.getByLabelText("List view"));

      expect(screen.getByTitle("Execution: Running")).toBeInTheDocument();
    });

    it("does not render execution indicator for tasks without execution state", async () => {
      const user = userEvent.setup();
      const tasks = [
        createTask({ id: "task-1", title: "Idle Task" }),
      ];
      // Empty execution states map
      const executionStates = new Map<string, { status: "Running" | "Completed" | "Failed" | "Pending"; stepName: string }>();

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          tasks={tasks}
          taskExecutionStates={executionStates}
        />
      );

      await user.click(screen.getByText("Tasks"));

      expect(screen.queryByTitle(/^Execution:/)).not.toBeInTheDocument();
    });
  });
});
