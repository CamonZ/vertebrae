import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render, createMockTask } from "../../test/test-utils";
import { TaskDetailPanel } from "./TaskDetailPanel";
import * as eventsModule from "../../bindings";
import { useTaskStore } from "../../stores";

// Use vi.hoisted to define mock data that's available in hoisted mocks
const { mockTaskData } = vi.hoisted(() => {
  const sections = [
    {
      type: "goal" as const,
      content: "Complete the feature",
      order: 0,
      done: false,
      done_at: null,
    },
    {
      type: "checklist_item" as const,
      content: "First step to do",
      order: 0,
      done: false,
      done_at: null,
    },
    {
      type: "checklist_item" as const,
      content: "Second step to do",
      order: 1,
      done: true,
      done_at: new Date().toISOString(),
    },
    {
      type: "testing_criterion" as const,
      content: "Feature works end to end",
      order: 0,
      done: false,
      done_at: null,
    },
    {
      type: "testing_criterion" as const,
      content: "No regressions",
      order: 1,
      done: true,
      done_at: new Date().toISOString(),
    },
  ];

  const mockTaskData = {
    id: "task-123",
    title: "Test Task",
    description: "Test Description for inline editing",
    level: "task" as const,
    priority: "medium" as const,
    tags: ["tag1", "tag2"],
    sections: sections,
    code_refs: [],
    needs_human_review: false,
    review_comment: null,
    revision_feedback: "Some revision feedback",
    workflow_id: null,
    current_step_id: null,
    workflow_name: null,
    step_name: null,
    parent_id: null,
    dependency_ids: [],
    archived: false,
    worktree: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    rejection_reason: null,
  };

  return { mockTaskData };
});

// Mock useTask hook with hoisted data
vi.mock("../../hooks/useTask", () => ({
  useTask: (id: string | null) => {
    if (!id) {
      return { task: null, isLoading: false, error: null, refetch: vi.fn() };
    }
    return {
      task: mockTaskData,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

// Mock useTaskExecutions hook
vi.mock("../../hooks/useTaskExecutions", () => ({
  useTaskExecutions: () => ({
    executions: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// Mock commands and events
vi.mock("../../bindings", () => ({
  commands: {
    updateTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    addSection: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    editSection: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    removeSection: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    toggleChecklistItemDone: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: null }),
    deleteTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    runStep: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    orchestrateTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    stopOrchestrator: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {
    taskChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

describe("TaskDetailPanel - Inline Editing Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(eventsModule.events.taskChangedEvent.listen).mockResolvedValue(
      () => {}
    );
  });

  afterEach(() => {
    useTaskStore.getState().setTasks([]);
  });

  describe("Details section - Inline editing UX", () => {
    it("clicking description shows input immediately with warning dot and check/X icons", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Description is in the Spec section (open by default)
      // Click on description text
      const descriptionText = screen.getByText(
        "Test Description for inline editing"
      );
      await userEvent.click(descriptionText);

      // Should show textarea immediately
      const textarea = screen.getByRole("textbox");
      expect(textarea.tagName).toBe("TEXTAREA");
      expect(textarea).toHaveValue("Test Description for inline editing");

      // Should show warning dot (edit indicator)
      const warningDot = document.querySelector(".bg-warning");
      expect(warningDot).toBeInTheDocument();

      // Should show save and cancel buttons
      expect(
        screen.getByRole("button", { name: /save/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /cancel/i })
      ).toBeInTheDocument();
    });

    it("clicking tags shows input immediately with warning dot and check/X icons", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Expand Details section first
      const detailsToggle = screen.getByRole("button", {
        name: /toggle details section/i,
      });
      await userEvent.click(detailsToggle);

      // Find the tags display and click it
      const tagsDisplay = screen.getByText("tag1, tag2");
      await userEvent.click(tagsDisplay);

      // Should show input immediately
      const input = screen.getByRole("textbox");
      expect(input.tagName).toBe("INPUT");
      expect(input).toHaveValue("tag1, tag2");

      // Should show warning dot
      const warningDot = document.querySelector(".bg-warning");
      expect(warningDot).toBeInTheDocument();

      // Should show save and cancel buttons
      expect(
        screen.getByRole("button", { name: /save/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /cancel/i })
      ).toBeInTheDocument();
    });

    it("Enter key saves in description field (with Ctrl for multiline)", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Description is in the Spec section (open by default)
      // Click description to enter edit mode
      await userEvent.click(
        screen.getByText("Test Description for inline editing")
      );

      const textarea = screen.getByRole("textbox");
      await userEvent.clear(textarea);
      await userEvent.type(textarea, "New description");

      // For multiline, Ctrl+Enter should save
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await waitFor(() => {
        expect(eventsModule.commands.updateTask).toHaveBeenCalled();
      });
    });

    it("Escape key cancels edit in description field", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Description is in the Spec section (open by default)
      // Click description to enter edit mode
      await userEvent.click(
        screen.getByText("Test Description for inline editing")
      );

      const textarea = screen.getByRole("textbox");
      await userEvent.clear(textarea);
      await userEvent.type(textarea, "New description");

      // Press Escape to cancel
      await userEvent.keyboard("{Escape}");

      // Should return to display mode with original value
      expect(
        screen.getByText("Test Description for inline editing")
      ).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("Enter key saves in tags field (single line)", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Expand Details section
      await userEvent.click(
        screen.getByRole("button", { name: /toggle details section/i })
      );

      // Click tags to enter edit mode
      await userEvent.click(screen.getByText("tag1, tag2"));

      const input = screen.getByRole("textbox");
      await userEvent.clear(input);
      await userEvent.type(input, "newtag1, newtag2{Enter}");

      await waitFor(() => {
        expect(eventsModule.commands.updateTask).toHaveBeenCalled();
      });
    });
  });

  describe("Acceptance criteria interaction", () => {
    it("displays acceptance criteria with met/pending indicators", () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      expect(
        screen.getByText("Feature works end to end")
      ).toBeInTheDocument();
      expect(screen.getByText("No regressions")).toBeInTheDocument();
    });

    it("met criteria are styled with line-through", () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      const metCriterion = screen.getByText("No regressions");
      expect(metCriterion.className).toContain("line-through");
    });

    it("pending criteria are not styled with line-through", () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      const pendingCriterion = screen.getByText("Feature works end to end");
      expect(pendingCriterion.className).not.toContain("line-through");
    });

    it("shows progress summary", () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      expect(screen.getByText("1/2 met")).toBeInTheDocument();
    });

    it("toggling criterion calls toggleChecklistItemDone", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      const toggleButtons = screen
        .getAllByRole("button")
        .filter(
          (btn) =>
            btn.getAttribute("aria-label")?.includes("Mark criterion") ?? false
        );

      expect(toggleButtons.length).toBeGreaterThan(0);

      await userEvent.click(toggleButtons[0]);

      await waitFor(() => {
        expect(
          eventsModule.commands.toggleChecklistItemDone
        ).toHaveBeenCalled();
      });
    });
  });

  describe("Progress section with checklist items", () => {
    it("displays checklist items in progress section", () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      expect(screen.getByText("First step to do")).toBeInTheDocument();
      expect(screen.getByText("Second step to do")).toBeInTheDocument();
    });

    it("completed checklist items have line-through styling", () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      const completedItem = screen.getByText("Second step to do");
      expect(completedItem.className).toContain("line-through");
    });

    it("incomplete checklist items do not have line-through", () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      const incompleteItem = screen.getByText("First step to do");
      expect(incompleteItem.className).not.toContain("line-through");
    });
  });

  describe("Spec section shows goal and constraints when expanded", () => {
    it("shows goal content in Spec section (open by default)", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      expect(screen.getByText("Complete the feature")).toBeInTheDocument();
    });
  });

  describe("Panel layout preserves existing functionality", () => {
    it("all sections are rendered in the correct order: criteria, progress, spec, deps, code, details", () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      const allText = document.body.textContent ?? "";
      const criteriaPos = allText.indexOf("Acceptance Criteria");
      const progressPos = allText.indexOf("Progress");
      const specPos = allText.indexOf("Spec");
      const depsPos = allText.indexOf("Dependencies");
      const codePos = allText.indexOf("Code");
      const detailsPos = allText.lastIndexOf("Details");

      expect(criteriaPos).toBeLessThan(progressPos);
      expect(progressPos).toBeLessThan(specPos);
      expect(specPos).toBeLessThan(depsPos);
      expect(depsPos).toBeLessThan(codePos);
      expect(codePos).toBeLessThan(detailsPos);
    });

    it("sections include Children between Spec and Dependencies when task has children", () => {
      useTaskStore.getState().setTasks([
        createMockTask({
          id: "child-integ-1",
          title: "Integration child",
          level: "task",
          parent_id: "task-123",
          step_name: "todo",
        }),
      ]);

      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      const allText = document.body.textContent ?? "";
      const specPos = allText.indexOf("Spec");
      const childrenPos = allText.indexOf("Children");
      const depsPos = allText.indexOf("Dependencies");

      expect(specPos).toBeLessThan(childrenPos);
      expect(childrenPos).toBeLessThan(depsPos);
    });

    it("title is editable via click", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      await userEvent.click(screen.getByText("Test Task"));

      const titleInput = screen.getByDisplayValue("Test Task");
      expect(titleInput).toBeInTheDocument();
      expect(titleInput).toHaveAttribute("type", "text");
    });
  });
});
