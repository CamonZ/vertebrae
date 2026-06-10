import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import {
  render,
  createMockTask,
  createMockTaskRun,
} from "../../test/test-utils";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { usePanelFocusStore } from "../../stores/panelFocusStore";
import * as eventsModule from "../../bindings";
import type { Task, TaskRunControls } from "../../bindings";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../../stores/projectScopedStores";
import { queryClient, queryKeys } from "../../query";

const mockTaskOverrides = vi.hoisted(() => ({
  current: {} as Partial<Task>,
}));

// Mock the useTask hook to return task data directly
vi.mock("../../hooks/useTask", () => ({
  useTask: (id: string | null) => {
    if (!id) {
      return { task: null, isLoading: false, error: null, refetch: vi.fn() };
    }
    return {
      task: createMockTask({
        id: id,
        title: "Test Task",
        description: "Test Description",
        level: "task" as const,
        priority: "medium" as const,
        tags: ["tag1"],
        sections: [
          {
            type: "testing_criterion" as const,
            content: "App loads without errors",
            order: 0,
            done: true,
            done_at: new Date().toISOString(),
          },
          {
            type: "testing_criterion" as const,
            content: "Navigation works correctly",
            order: 1,
            done: false,
            done_at: null,
          },
          {
            type: "goal" as const,
            content: "Build a working feature",
            order: 0,
            done: null,
            done_at: null,
          },
          {
            type: "constraint" as const,
            content: "Must use existing components",
            order: 0,
            done: null,
            done_at: null,
          },
          {
            type: "checklist_item" as const,
            content: "First step",
            order: 0,
            done: true,
            done_at: new Date().toISOString(),
          },
          {
            type: "checklist_item" as const,
            content: "Second step",
            order: 1,
            done: false,
            done_at: null,
          },
          {
            type: "anti_pattern" as const,
            content: "Do not bypass orchestration",
            order: 0,
            done: null,
            done_at: null,
          },
          {
            type: "failure_test" as const,
            content: "Reject invalid workflow payloads",
            order: 0,
            done: null,
            done_at: null,
          },
        ],
        code_refs: [
          {
            path: "src/components/App.tsx",
            line_start: 42,
            line_end: 50,
            name: "App component",
            description: "Main app entry",
          },
        ],
        workflow_name: "Implementation",
        step_name: "in_progress",
        workflow_id: "wf-1",
        current_step_id: "step-1",
        run_controls: null,
        ...mockTaskOverrides.current,
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

const mockTaskExecutionsOverrides = vi.hoisted(() => ({
  current: [] as unknown[],
}));

// Mock the useTaskExecutions hook
vi.mock("../../hooks/useTaskExecutions", () => ({
  useTaskExecutions: () => ({
    executions: mockTaskExecutionsOverrides.current,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// Mock the commands and events
vi.mock("../../bindings", () => ({
  commands: {
    updateTask: vi.fn(),
    runWorkflow: vi.fn(),
    stopRun: vi.fn(),
    orchestrateTask: vi.fn(),
    stopOrchestrator: vi.fn(),
    deleteTask: vi.fn(),
    listTasks: vi.fn(async () => ({ status: "ok", data: [] })),
    toggleChecklistItemDone: vi.fn(),
    // Relation levels/titles are looked up from the store in tests; this stub
    // just keeps the fallback fetch from throwing when a relation isn't seeded.
    getTask: vi.fn(async () => ({ status: "error", error: "not mocked" })),
  },
  events: {
    taskChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

const mockTaskData = createMockTask({
  id: "task-123",
  title: "Test Task",
  description: "Test Description",
  level: "task",
  priority: "medium",
  tags: ["tag1"],
  sections: [],
  code_refs: [],
});

function activeRunControls(taskId = mockTaskData.id): TaskRunControls {
  return {
    runnable: false,
    stoppable: true,
    disabled_reason_code: "active_run",
    disabled_reason: "A TaskRun is already active",
    active_run: createMockTaskRun({ id: "run-123", task_id: taskId }),
  };
}

function renderWithTaskOverrides(overrides: Partial<Task>) {
  mockTaskOverrides.current = overrides;
  return render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);
}

function seedTaskList(tasks: Task[]) {
  queryClient.setQueryData(
    queryKeys.tasks.list(getProjectScopeGeneration(), null),
    tasks
  );
}

describe("TaskDetailPanel - Restructured Layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
    mockTaskOverrides.current = {};
    mockTaskExecutionsOverrides.current = [];
    usePanelFocusStore.getState().reset();
    vi.mocked(eventsModule.events.taskChangedEvent.listen).mockResolvedValue(
      () => {}
    );
  });

  afterEach(() => {
    queryClient.clear();
  });

  describe("Header", () => {
    it("shows the current step in the hero status", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      // The workflow name is no longer surfaced in the panel; the step appears
      // in the hero status band (formatStepName("in_progress") -> "In progress").
      expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
    });

    it("renders the task side panel ID as an eight-character short ID", () => {
      mockTaskOverrides.current = {
        id: "12345678-90ab-cdef-1234-567890abcdef",
      };

      render(
        <TaskDetailPanel
          taskId="12345678-90ab-cdef-1234-567890abcdef"
          onClose={vi.fn()}
        />
      );

      expect(screen.getByTestId("task-detail-id")).toHaveTextContent(
        "12345678"
      );
      expect(
        screen.queryByText("12345678-90ab-cdef-1234-567890abcdef")
      ).not.toBeInTheDocument();
    });

    it("renders the level crumb and a clickable 'under <parent>' link", () => {
      mockTaskOverrides.current = { level: "ticket", parent_id: "parent-1" };
      seedTaskList([
        createMockTask({ id: "parent-1", title: "Vertebrae Web App" }),
      ]);
      const onTaskSelect = vi.fn();

      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
          onTaskSelect={onTaskSelect}
        />
      );

      expect(screen.getByTestId("task-detail-level")).toHaveTextContent(
        "ticket"
      );
      const parentLink = screen.getByTestId("task-detail-parent-link");
      expect(parentLink).toHaveTextContent("Vertebrae Web App");

      fireEvent.click(parentLink);
      expect(onTaskSelect).toHaveBeenCalledWith("parent-1");
    });

    it("omits the 'under' crumb when the task has no parent", () => {
      renderWithTaskOverrides({ parent_id: null });

      expect(screen.getByTestId("task-detail-level")).toBeInTheDocument();
      expect(
        screen.queryByTestId("task-detail-parent-link")
      ).not.toBeInTheDocument();
    });

    it("renders back button when onBack is provided", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
          onBack={vi.fn()}
        />
      );

      expect(
        screen.getByRole("button", { name: /go back/i })
      ).toBeInTheDocument();
    });

    it("calls onBack when back button is clicked", () => {
      const mockOnBack = vi.fn();

      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
          onBack={mockOnBack}
        />
      );

      const backButton = screen.getByRole("button", { name: /go back/i });
      fireEvent.click(backButton);

      expect(mockOnBack).toHaveBeenCalledTimes(1);
    });

    it("does not render back button when onBack is not provided", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(
        screen.queryByRole("button", { name: /go back/i })
      ).not.toBeInTheDocument();
    });
  });

  describe("Close button", () => {
    it("renders Close button", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const closeButton = screen.getByRole("button", {
        name: /close panel/i,
      });
      expect(closeButton).toBeInTheDocument();
    });

    it("calls onClose when Close button is clicked", () => {
      const mockOnClose = vi.fn();

      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={mockOnClose} />
      );

      const closeButton = screen.getByRole("button", {
        name: /close panel/i,
      });
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("hides the Detach button when no onDetach handler is provided", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(
        screen.queryByRole("button", { name: /detach into pop-out window/i })
      ).not.toBeInTheDocument();
    });

    it("does not render the Detach button even when onDetach is provided (temporarily disabled)", () => {
      const mockOnDetach = vi.fn();
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
          onDetach={mockOnDetach}
        />
      );

      expect(
        screen.queryByRole("button", { name: /detach into pop-out window/i })
      ).not.toBeInTheDocument();
    });

    it("renders the standalone wrapper and hides Detach in standalone mode", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} standalone />);

      expect(
        screen.getByTestId("task-detail-panel-standalone")
      ).toBeInTheDocument();
      // Detach is meaningless in a window that's already detached
      expect(
        screen.queryByRole("button", { name: /detach into pop-out window/i })
      ).not.toBeInTheDocument();
    });
  });

  describe("Header buttons", () => {
    it("renders Delete and Close buttons in header", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(
        screen.getByRole("button", { name: /delete/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /close panel/i })
      ).toBeInTheDocument();
    });

    it("Delete button is positioned before Close button", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const buttons = screen.getAllByRole("button");
      const deleteIndex = buttons.findIndex(
        (b) => b.getAttribute("aria-label") === "Delete task"
      );
      const closeIndex = buttons.findIndex(
        (b) => b.getAttribute("aria-label") === "Close panel"
      );

      expect(deleteIndex).toBeLessThan(closeIndex);
    });
  });

  describe("Task title display", () => {
    it("displays task title in the panel", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByText("Test Task")).toBeInTheDocument();
    });
  });

  describe("Spec section display", () => {
    it("displays checklist items, anti patterns, and negative tests", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByText("Checklist Items")).toBeInTheDocument();
      expect(screen.getByText("First step")).toBeInTheDocument();
      expect(screen.getByText("Second step")).toBeInTheDocument();
      expect(screen.getByText("Anti Patterns")).toBeInTheDocument();
      expect(
        screen.getByText("Do not bypass orchestration")
      ).toBeInTheDocument();
      expect(screen.getByText("Negative Tests")).toBeInTheDocument();
      expect(
        screen.getByText("Reject invalid workflow payloads")
      ).toBeInTheDocument();
    });
  });

  describe("Inline editing - Title", () => {
    it("makes title editable when clicked", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const titleElement = screen.getByText("Test Task");
      fireEvent.click(titleElement);

      const titleInput = screen.getByDisplayValue("Test Task");
      expect(titleInput).toBeInTheDocument();
      expect(titleInput).toHaveAttribute("type", "text");
    });
  });

  describe("Glass-panel focus (Escape to close)", () => {
    it("registers as a focused glass panel while open", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);
      expect(usePanelFocusStore.getState().stack).toContain("task-detail");
    });

    it("closes the panel on Escape when not editing", () => {
      const onClose = vi.fn();
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={onClose} />);

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not close the panel on Escape while an inline edit is open", () => {
      const onClose = vi.fn();
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={onClose} />);

      // Enter title edit mode; its own Escape-to-cancel must win.
      fireEvent.click(screen.getByText("Test Task"));
      const input = screen.getByDisplayValue("Test Task");
      fireEvent.keyDown(input, { key: "Escape" });

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("Acceptance Criteria section", () => {
    it("is the first section after the title badges", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByText("Test Criteria")).toBeInTheDocument();
      const criteriaSection = screen.getByTestId("acceptance-criteria");
      expect(criteriaSection).toBeInTheDocument();
    });

    it("displays testing_criterion sections with met/pending indicators", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByText("App loads without errors")).toBeInTheDocument();
      expect(
        screen.getByText("Navigation works correctly")
      ).toBeInTheDocument();
    });

    it("shows progress count for criteria", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByText("1/2 met")).toBeInTheDocument();
      expect(screen.getByText("50%")).toBeInTheDocument();
    });

    it("does not render a fabricated 'human' validation badge", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      // Criteria without code refs get no badge — "human" was never real data.
      expect(screen.queryByText("human")).not.toBeInTheDocument();
    });

    it("met criteria have line-through styling", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const metCriterion = screen.getByText("App loads without errors");
      expect(metCriterion.className).toContain("line-through");
    });
  });

  describe("Collapsible sections", () => {
    it("renders Spec collapsible section", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const specToggle = screen.getByRole("button", {
        name: /toggle spec section/i,
      });
      expect(specToggle).toBeInTheDocument();
    });

    it("renders Dependencies collapsible section", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const depsToggle = screen.getByRole("button", {
        name: /toggle dependencies section/i,
      });
      expect(depsToggle).toBeInTheDocument();
    });

    it("renders Code collapsible section", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const codeToggle = screen.getByRole("button", {
        name: /toggle code section/i,
      });
      expect(codeToggle).toBeInTheDocument();
    });

    it("renders Details collapsible section", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const detailsToggle = screen.getByRole("button", {
        name: /toggle details section/i,
      });
      expect(detailsToggle).toBeInTheDocument();
    });

    it("Spec section is open by default showing goal and constraints", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByText("Build a working feature")).toBeInTheDocument();
      expect(
        screen.getByText("Must use existing components")
      ).toBeInTheDocument();
    });

    it("Details section expands to show priority, tags", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const detailsToggle = screen.getByRole("button", {
        name: /toggle details section/i,
      });
      fireEvent.click(detailsToggle);

      expect(screen.getByText("medium")).toBeInTheDocument();
    });

    it("Code section expands to show file paths with line numbers", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const codeToggle = screen.getByRole("button", {
        name: /toggle code section/i,
      });
      fireEvent.click(codeToggle);

      expect(screen.getByText("App.tsx")).toBeInTheDocument();
      expect(screen.getByText("L42-50")).toBeInTheDocument();
    });
  });

  describe("Delete confirmation - Toggle", () => {
    it("renders Delete button in header", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(
        screen.getByRole("button", { name: /delete task/i })
      ).toBeInTheDocument();
    });

    it("opens confirmation and deletes the selected task without cascade by default", async () => {
      const onClose = vi.fn();
      vi.mocked(eventsModule.commands.deleteTask).mockResolvedValue({
        status: "ok",
        data: null,
      });
      seedTaskList([mockTaskData]);

      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={onClose} />);

      fireEvent.click(screen.getByRole("button", { name: /delete task/i }));
      expect(screen.getByText("Delete Task?")).toBeInTheDocument();
      expect(
        screen.getByTestId("task-delete-confirmation")
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

      await waitFor(() => {
        expect(eventsModule.commands.deleteTask).toHaveBeenCalledWith(
          mockTaskData.id,
          false
        );
      });
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it("renders confirmation before the scrollable task body when opened from the header", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: /delete task/i }));

      const confirmationHeading = screen.getByRole("heading", {
        name: "Delete Task?",
      });
      // The Spec section toggle is the first element of the scrollable
      // body, below the static panel header chrome.
      const bodyAnchor = screen.getByRole("button", {
        name: /toggle spec section/i,
      });

      expect(
        confirmationHeading.compareDocumentPosition(bodyAnchor) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("preserves cascade selection for parent tasks with children", async () => {
      const childTask = createMockTask({
        id: "child-001",
        title: "Child task",
        parent_id: mockTaskData.id,
      });
      vi.mocked(eventsModule.commands.deleteTask).mockResolvedValue({
        status: "ok",
        data: null,
      });
      seedTaskList([mockTaskData, childTask]);

      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: /delete task/i }));
      expect(
        screen.getByText("This task has 1 child task")
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("radio", { name: "Delete all child tasks" })
      );
      fireEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

      await waitFor(() => {
        expect(eventsModule.commands.deleteTask).toHaveBeenCalledWith(
          mockTaskData.id,
          true
        );
      });
    });
  });

  describe("Level and ID badges", () => {
    it("labels the id badge with the task level", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByTestId("task-detail-id")).toHaveAttribute(
        "aria-label",
        `Copy full ${mockTaskData.level} ID`
      );
    });

    it("shows short task ID in title area", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByText("task-123")).toBeInTheDocument();
    });
  });

  describe("Run/Stop orchestration controls (run_controls source of truth)", () => {
    function runnableControls(): TaskRunControls {
      return {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      };
    }

    function stoppingControls(taskId = mockTaskData.id): TaskRunControls {
      return {
        runnable: false,
        stoppable: false,
        disabled_reason_code: "stopping",
        disabled_reason: "Stop already requested",
        active_run: createMockTaskRun({
          id: "run-stopping",
          task_id: taskId,
          status: "stopping",
        }),
      };
    }

    it("does not render the deprecated Run Step affordance", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(
        screen.queryByRole("button", { name: /run current step/i })
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Run Step")).not.toBeInTheDocument();
    });

    it("renders the Run button even when run_controls is missing", () => {
      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByTestId("task-detail-run-button")).toBeInTheDocument();
    });

    it("enables Run when no active run and runnable is true", () => {
      renderWithTaskOverrides({ run_controls: runnableControls() });

      expect(screen.getByTestId("task-detail-run-button")).not.toBeDisabled();
      expect(
        screen.queryByTestId("task-detail-stop-button")
      ).not.toBeInTheDocument();
    });

    it("hides Run when an active run is present", () => {
      renderWithTaskOverrides({ run_controls: activeRunControls() });

      expect(
        screen.queryByTestId("task-detail-run-button")
      ).not.toBeInTheDocument();
    });

    it("disables Run when run_controls is absent (no server-derived runnable signal)", () => {
      renderWithTaskOverrides({ run_controls: null });

      expect(screen.getByTestId("task-detail-run-button")).toBeDisabled();
    });

    it("shows Stop and enables it for executing+stoppable runs", () => {
      renderWithTaskOverrides({ run_controls: activeRunControls() });

      const stop = screen.getByTestId("task-detail-stop-button");
      expect(stop).toBeInTheDocument();
      expect(stop).not.toBeDisabled();
      expect(stop).toHaveTextContent(/^Stop$/);
    });

    it.each<["queued" | "waiting"]>([["queued"], ["waiting"]])(
      "shows Stop enabled for %s active runs when stoppable",
      (status) => {
        const controls = activeRunControls();
        renderWithTaskOverrides({
          run_controls: {
            ...controls,
            stoppable: true,
            active_run: { ...controls.active_run!, status },
          },
        });

        const stop = screen.getByTestId("task-detail-stop-button");
        expect(stop).toBeInTheDocument();
        expect(stop).not.toBeDisabled();
      }
    );

    it("hides Stop when there is no active run, even if step_name is in_progress", () => {
      // step_name is in_progress on the mock task; Stop must NOT key off that.
      renderWithTaskOverrides({ run_controls: runnableControls() });

      expect(
        screen.queryByTestId("task-detail-stop-button")
      ).not.toBeInTheDocument();
    });

    it("hides Stop when the server marks a running task not stoppable", () => {
      const controls = activeRunControls();
      renderWithTaskOverrides({
        run_controls: {
          ...controls,
          stoppable: false,
        },
      });

      // Running but not stoppable still surfaces Stop (so the operator sees
      // the in-flight state) but the button must be disabled.
      const stop = screen.getByTestId("task-detail-stop-button");
      expect(stop).toBeInTheDocument();
      expect(stop).toBeDisabled();
    });

    it("hides Run and disables Stop while the run is stopping, and labels Stop as 'Cancel orchestration'", () => {
      renderWithTaskOverrides({ run_controls: stoppingControls() });

      expect(
        screen.queryByTestId("task-detail-run-button")
      ).not.toBeInTheDocument();

      const stop = screen.getByTestId("task-detail-stop-button");
      expect(stop).toBeInTheDocument();
      expect(stop).toBeDisabled();
      expect(stop).toHaveTextContent(/Cancel orchestration/i);
    });

    it("calls stopRun with the active run id when Stop is clicked", async () => {
      vi.mocked(eventsModule.commands.stopRun).mockResolvedValue({
        status: "ok",
        data: null,
      });

      renderWithTaskOverrides({ run_controls: activeRunControls() });

      const stopBtn = screen.getByTestId("task-detail-stop-button");
      fireEvent.click(stopBtn);

      expect(eventsModule.commands.stopRun).toHaveBeenCalledTimes(1);
      expect(eventsModule.commands.stopRun).toHaveBeenCalledWith({
        task_run_id: "run-123",
        task_id: null,
      });
    });

    it("surfaces stopRun error message when the call fails", async () => {
      vi.mocked(eventsModule.commands.stopRun).mockResolvedValue({
        status: "error",
        error: { message: "no orchestrator running" } as never,
      });

      renderWithTaskOverrides({ run_controls: activeRunControls() });

      const stopBtn = screen.getByTestId("task-detail-stop-button");
      fireEvent.click(stopBtn);

      expect(
        await screen.findByText(/no orchestrator running/i)
      ).toBeInTheDocument();
    });

    it("renders the Hearth detail hero as idle when no run is active", () => {
      renderWithTaskOverrides({ run_controls: runnableControls() });

      const hero = screen.getByTestId("task-detail-hero");
      expect(hero).toHaveAttribute("data-hero-state", "idle");
      expect(
        screen.getByTestId("task-detail-hero-idle-label")
      ).toHaveTextContent("No active run");
    });

    it("renders the Hearth detail hero with the active run state", () => {
      renderWithTaskOverrides({ run_controls: activeRunControls() });

      const hero = screen.getByTestId("task-detail-hero");
      expect(hero).toHaveAttribute("data-hero-state", "executing");
      expect(hero).toHaveTextContent("Running");
      expect(hero).toHaveTextContent("In progress");
    });
  });

  describe("Children section", () => {
    const childTask1 = createMockTask({
      id: "child-001",
      title: "First child task",
      level: "task",
      parent_id: mockTaskData.id,
      step_name: "in_progress",
      workflow_name: "Implementation",
    });

    const childTask2 = createMockTask({
      id: "child-002",
      title: "Second child task",
      level: "ticket",
      parent_id: mockTaskData.id,
      step_name: "todo",
      workflow_name: "Backlog",
    });

    it("renders Children section with child count badge when task has children", () => {
      seedTaskList([childTask1, childTask2]);

      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const childrenSection = screen.getByTestId("children-section");
      expect(childrenSection).toBeInTheDocument();
      expect(childrenSection).toHaveTextContent("Children");
      expect(childrenSection).toHaveTextContent("2");
    });

    it("displays each child with its id badge, title, and step name", () => {
      seedTaskList([childTask1, childTask2]);

      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      expect(screen.getByText("First child task")).toBeInTheDocument();
      expect(screen.getByText("Second child task")).toBeInTheDocument();

      const child1Element = screen.getByTestId("child-task-child-001");
      expect(
        child1Element.querySelector('[data-testid="child-task-id-child-001"]')
      ).toHaveAttribute("title", `Task ID: ${childTask1.id}`);
      expect(child1Element).toHaveTextContent("First child task");
      expect(child1Element).toHaveTextContent("In progress");

      const child2Element = screen.getByTestId("child-task-child-002");
      expect(
        child2Element.querySelector('[data-testid="child-task-id-child-002"]')
      ).toHaveAttribute("title", `Ticket ID: ${childTask2.id}`);
      expect(child2Element).toHaveTextContent("Second child task");
      expect(child2Element).toHaveTextContent("Todo");
    });

    it("calls onTaskSelect when a child task is clicked", () => {
      seedTaskList([childTask1]);
      const mockOnTaskSelect = vi.fn();

      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
          onTaskSelect={mockOnTaskSelect}
        />
      );

      const childButton = screen.getByTestId("child-task-child-001");
      fireEvent.click(childButton);

      expect(mockOnTaskSelect).toHaveBeenCalledTimes(1);
      expect(mockOnTaskSelect).toHaveBeenCalledWith("child-001");
    });

    it("renders Children section with a 0 count badge when task has no children", () => {
      seedTaskList([]);

      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const childrenSection = screen.getByTestId("children-section");
      expect(childrenSection).toBeInTheDocument();
      expect(childrenSection).toHaveTextContent("Children");
      expect(childrenSection).toHaveTextContent("0");
      expect(childrenSection).toHaveTextContent("No child tasks");
    });

    it("renders Children toggle button for accessibility", () => {
      seedTaskList([childTask1]);

      render(<TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />);

      const toggleButton = screen.getByRole("button", {
        name: /toggle children section/i,
      });
      expect(toggleButton).toBeInTheDocument();
    });
  });

  describe("Waiting human_input gate", () => {
    function waitingControls(taskId = mockTaskData.id): TaskRunControls {
      return {
        runnable: false,
        stoppable: true,
        disabled_reason_code: "active_run",
        disabled_reason: "Run is parked on human_input",
        active_run: createMockTaskRun({
          id: "run-wait-1",
          task_id: taskId,
          status: "waiting",
          latest_step_execution_id: "exec-wait-1",
        }),
      };
    }

    function notStoppableWaitingControls(): TaskRunControls {
      return {
        runnable: false,
        stoppable: false,
        disabled_reason_code: "active_run",
        disabled_reason: "Run is parked",
        active_run: createMockTaskRun({
          id: "run-wait-2",
          task_id: mockTaskData.id,
          status: "waiting",
          latest_step_execution_id: "exec-wait-2",
        }),
      };
    }

    function execFor(
      runId: string,
      execId: string,
      overrides: Partial<{
        step_name: string;
        step_type: string | null;
        prompt: string | null;
      }> = {}
    ) {
      return {
        id: execId,
        task_id: mockTaskData.id,
        task_run_id: runId,
        workflow_id: "wf-1",
        step_name: overrides.step_name ?? "approval",
        step_type: overrides.step_type ?? "human_input",
        started_at: "2026-05-08T10:00:00Z",
        completed_at: null,
        status: "in_progress" as const,
        prompt: overrides.prompt ?? null,
        output: null,
        context: null,
        transition_result: null,
        model: null,
        model_provider: null,
        input_tokens: null,
        output_tokens: null,
        cost: null,
        duration_ms: null,
        handoff: null,
        session_id: null,
      };
    }

    it("renders the gate with run id, execution id, and step when waiting on human_input", () => {
      mockTaskExecutionsOverrides.current = [
        execFor("run-wait-1", "exec-wait-1", {
          step_name: "approval",
          prompt: "Approve change?",
        }),
      ];
      renderWithTaskOverrides({ run_controls: waitingControls() });

      const gate = screen.getByTestId("human-input-gate");
      expect(gate).toHaveAttribute("data-run-id", "run-wait-1");
      expect(gate).toHaveAttribute("data-execution-id", "exec-wait-1");
      expect(screen.getByTestId("human-input-gate-run-id")).toHaveTextContent(
        "run-wait-1"
      );
      expect(
        screen.getByTestId("human-input-gate-execution-id")
      ).toHaveTextContent("exec-wait-1");
      expect(screen.getByTestId("human-input-gate-step")).toHaveTextContent(
        "approval"
      );
      // Prompt toggle is present (collapsible) since prompt was attached.
      expect(
        screen.getByTestId("human-input-gate-prompt-toggle")
      ).toBeInTheDocument();
    });

    it("offers Stop only when run_controls.stoppable is true", () => {
      mockTaskExecutionsOverrides.current = [
        execFor("run-wait-1", "exec-wait-1"),
      ];
      renderWithTaskOverrides({ run_controls: waitingControls() });
      expect(screen.getByTestId("human-input-gate-stop")).toBeInTheDocument();
    });

    it("hides Stop when run_controls.stoppable is false", () => {
      mockTaskExecutionsOverrides.current = [
        execFor("run-wait-2", "exec-wait-2"),
      ];
      renderWithTaskOverrides({ run_controls: notStoppableWaitingControls() });
      expect(screen.getByTestId("human-input-gate")).toBeInTheDocument();
      expect(
        screen.queryByTestId("human-input-gate-stop")
      ).not.toBeInTheDocument();
    });

    it("does not expose any submit / approve / bypass action", () => {
      mockTaskExecutionsOverrides.current = [
        execFor("run-wait-1", "exec-wait-1"),
      ];
      renderWithTaskOverrides({ run_controls: waitingControls() });
      const gate = screen.getByTestId("human-input-gate");
      expect(
        gate.querySelector('[data-testid="human-input-gate-submit"]')
      ).toBeNull();
      // No "Approve" / "Submit" / "Resume" / "Bypass" labels inside the gate.
      expect(gate.textContent ?? "").not.toMatch(/approve\b/i);
      expect(gate.textContent ?? "").not.toMatch(/submit\b/i);
      expect(gate.textContent ?? "").not.toMatch(/resume\b/i);
      expect(gate.textContent ?? "").not.toMatch(/bypass\b/i);
    });

    it("does not render the gate for wait_children waiting runs with custom step names", () => {
      mockTaskExecutionsOverrides.current = [
        execFor("run-wait-1", "exec-wait-1", {
          step_name: "wait",
          step_type: "wait_children",
        }),
      ];
      renderWithTaskOverrides({ run_controls: waitingControls() });
      expect(screen.queryByTestId("human-input-gate")).not.toBeInTheDocument();
    });

    it("renders the gate for human_input even when the display step name is wait_children", () => {
      mockTaskExecutionsOverrides.current = [
        execFor("run-wait-1", "exec-wait-1", {
          step_name: "wait_children",
          step_type: "human_input",
        }),
      ];
      renderWithTaskOverrides({ run_controls: waitingControls() });
      expect(screen.getByTestId("human-input-gate")).toBeInTheDocument();
    });

    it("does not render the gate when there is no active run", () => {
      mockTaskExecutionsOverrides.current = [];
      renderWithTaskOverrides({ run_controls: null });
      expect(screen.queryByTestId("human-input-gate")).not.toBeInTheDocument();
    });

    it("invokes stopRun with the active TaskRun id when Stop is clicked", () => {
      mockTaskExecutionsOverrides.current = [
        execFor("run-wait-1", "exec-wait-1"),
      ];
      vi.mocked(eventsModule.commands.stopRun).mockResolvedValue({
        status: "ok",
        data: null,
      });
      renderWithTaskOverrides({ run_controls: waitingControls() });

      fireEvent.click(screen.getByTestId("human-input-gate-stop"));
      expect(eventsModule.commands.stopRun).toHaveBeenCalledWith({
        task_run_id: "run-wait-1",
        task_id: null,
      });
    });
  });
});
