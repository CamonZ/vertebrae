import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render, createMockTask } from "../../test/test-utils";
import { TaskDetailPanel } from "./TaskDetailPanel";
import * as eventsModule from "../../bindings";

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
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

// Mock the useTaskExecutions hook
vi.mock("../../hooks/useTaskExecutions", () => ({
  useTaskExecutions: () => ({
    executions: [],
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
    runStep: vi.fn(),
    orchestrateTask: vi.fn(),
    deleteTask: vi.fn(),
    toggleChecklistItemDone: vi.fn(),
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

describe("TaskDetailPanel - Restructured Layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(eventsModule.events.taskChangedEvent.listen).mockResolvedValue(
      () => {}
    );
  });

  describe("Header", () => {
    it("displays workflow -> step breadcrumb when task has workflow", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(screen.getByText("Implementation")).toBeInTheDocument();
      expect(screen.getByText("in progress")).toBeInTheDocument();
    });

    it("displays status badge with glow animation for in_progress", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const statusBadge = screen.getByTestId("status-badge");
      expect(statusBadge).toBeInTheDocument();
      expect(statusBadge.className).toContain("animate-pulse-glow");
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
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(
        screen.queryByRole("button", { name: /go back/i })
      ).not.toBeInTheDocument();
    });
  });

  describe("Close button", () => {
    it("renders Close button", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

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
  });

  describe("Header buttons", () => {
    it("renders Delete and Close buttons in header", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(
        screen.getByRole("button", { name: /delete/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /close panel/i })
      ).toBeInTheDocument();
    });

    it("Delete button is positioned before Close button", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

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
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(screen.getByText("Test Task")).toBeInTheDocument();
    });
  });

  describe("Inline editing - Title", () => {
    it("makes title editable when clicked", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const titleElement = screen.getByText("Test Task");
      fireEvent.click(titleElement);

      const titleInput = screen.getByDisplayValue("Test Task");
      expect(titleInput).toBeInTheDocument();
      expect(titleInput).toHaveAttribute("type", "text");
    });
  });

  describe("Acceptance Criteria section", () => {
    it("is the first section after the title badges", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(screen.getByText("Acceptance Criteria")).toBeInTheDocument();
      const criteriaSection = screen.getByTestId("acceptance-criteria");
      expect(criteriaSection).toBeInTheDocument();
    });

    it("displays testing_criterion sections with met/pending indicators", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(screen.getByText("App loads without errors")).toBeInTheDocument();
      expect(
        screen.getByText("Navigation works correctly")
      ).toBeInTheDocument();
    });

    it("shows progress count for criteria", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(screen.getByText("1/2 met")).toBeInTheDocument();
      expect(screen.getByText("50%")).toBeInTheDocument();
    });

    it("shows human/machine validation badges", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const humanBadges = screen.getAllByText("human");
      expect(humanBadges.length).toBeGreaterThan(0);
    });

    it("met criteria have line-through styling", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const metCriterion = screen.getByText("App loads without errors");
      expect(metCriterion.className).toContain("line-through");
    });
  });

  describe("Progress section", () => {
    it("shows checklist items in progress section", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const progressSection = screen.getByTestId("progress-section");
      expect(progressSection).toBeInTheDocument();
      expect(screen.getByText("First step")).toBeInTheDocument();
      expect(screen.getByText("Second step")).toBeInTheDocument();
    });

    it("shows checklist progress badge", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(screen.getByText("1/2")).toBeInTheDocument();
    });
  });

  describe("Collapsible sections", () => {
    it("renders Spec collapsible section", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const specToggle = screen.getByRole("button", {
        name: /toggle spec section/i,
      });
      expect(specToggle).toBeInTheDocument();
    });

    it("renders Dependencies collapsible section", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const depsToggle = screen.getByRole("button", {
        name: /toggle dependencies section/i,
      });
      expect(depsToggle).toBeInTheDocument();
    });

    it("renders Code collapsible section", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const codeToggle = screen.getByRole("button", {
        name: /toggle code section/i,
      });
      expect(codeToggle).toBeInTheDocument();
    });

    it("renders Details collapsible section", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const detailsToggle = screen.getByRole("button", {
        name: /toggle details section/i,
      });
      expect(detailsToggle).toBeInTheDocument();
    });

    it("Spec section expands to show goal and constraints", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const specToggle = screen.getByRole("button", {
        name: /toggle spec section/i,
      });
      fireEvent.click(specToggle);

      expect(screen.getByText("Build a working feature")).toBeInTheDocument();
      expect(
        screen.getByText("Must use existing components")
      ).toBeInTheDocument();
    });

    it("Details section expands to show description, priority, tags", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      const detailsToggle = screen.getByRole("button", {
        name: /toggle details section/i,
      });
      fireEvent.click(detailsToggle);

      expect(screen.getByText("Test Description")).toBeInTheDocument();
      expect(screen.getByText("medium")).toBeInTheDocument();
    });

    it("Code section expands to show file paths with line numbers", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

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
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(
        screen.getByRole("button", { name: /delete task/i })
      ).toBeInTheDocument();
    });
  });

  describe("Level and ID badges", () => {
    it("shows level badge in title area", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(screen.getByText("task")).toBeInTheDocument();
    });

    it("shows short task ID in title area", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(screen.getByText("task-123")).toBeInTheDocument();
    });
  });

  describe("Run workflow buttons", () => {
    it("shows Run Step button when task has workflow and current step", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(
        screen.getByRole("button", { name: /run current step/i })
      ).toBeInTheDocument();
    });

    it("shows Run Workflow button when task has workflow", () => {
      render(
        <TaskDetailPanel taskId={mockTaskData.id} onClose={vi.fn()} />
      );

      expect(
        screen.getByRole("button", { name: /run entire workflow/i })
      ).toBeInTheDocument();
    });
  });
});
