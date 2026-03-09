import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "../../test/test-utils";
import { TaskDetailPanel } from "./TaskDetailPanel";
import * as eventsModule from "../../bindings";

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

// Mock commands and events
vi.mock("../../bindings", () => ({
  commands: {
    updateTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    runWorkflow: vi.fn(),
    addSection: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    editSection: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    removeSection: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    toggleChecklistItemDone: vi.fn().mockResolvedValue({ status: "ok", data: null }),
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

  describe("Details Tab - Consistent inline editing UX", () => {
    it("clicking description shows input immediately with warning dot and check/X icons", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Click on description text
      const descriptionText = screen.getByText(
        "Test Description for inline editing"
      );
      await userEvent.click(descriptionText);

      // Should show textarea immediately (not display mode)
      const textarea = screen.getByRole("textbox");
      expect(textarea.tagName).toBe("TEXTAREA");
      expect(textarea).toHaveValue("Test Description for inline editing");

      // Should show warning dot (edit indicator)
      const warningDot = document.querySelector(".bg-warning");
      expect(warningDot).toBeInTheDocument();

      // Should show save and cancel buttons
      expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /cancel/i })
      ).toBeInTheDocument();
    });

    it("clicking tags shows input immediately with warning dot and check/X icons", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

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
      expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /cancel/i })
      ).toBeInTheDocument();
    });

    it("Enter key saves in description field (with Ctrl for multiline)", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

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

  describe("Sections Tab - Consistent inline editing UX", () => {
    it("clicking section content shows input immediately (single click to edit)", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Switch to Sections tab
      const sectionsTab = screen.getByRole("tab", { name: /sections/i });
      await userEvent.click(sectionsTab);

      // Goal section should be open by default, click on content
      const sectionContent = screen.getByText("Complete the feature");
      await userEvent.click(sectionContent);

      // Should show input immediately (not an intermediate state)
      const input = screen.getByDisplayValue("Complete the feature");
      expect(input).toBeInTheDocument();
      expect(input.tagName).toBe("INPUT");

      // Should show warning dot
      const warningDot = document.querySelector(".bg-warning");
      expect(warningDot).toBeInTheDocument();
    });

    it("shows save, cancel, and delete buttons in section edit mode", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Switch to Sections tab
      await userEvent.click(screen.getByRole("tab", { name: /sections/i }));

      // Click section content to edit
      await userEvent.click(screen.getByText("Complete the feature"));

      // Should show all three buttons
      expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /cancel/i })
      ).toBeInTheDocument();
      // Use exact match for section delete button (not "Delete task" header button)
      expect(
        screen.getByRole("button", { name: "Delete" })
      ).toBeInTheDocument();
    });

    it("delete button in section edit mode triggers delete", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Switch to Sections tab
      await userEvent.click(screen.getByRole("tab", { name: /sections/i }));

      // Click section content to edit
      await userEvent.click(screen.getByText("Complete the feature"));

      // Click delete button (exact match to avoid "Delete task" header button)
      const deleteButton = screen.getByRole("button", { name: "Delete" });
      await userEvent.click(deleteButton);

      await waitFor(() => {
        expect(eventsModule.commands.removeSection).toHaveBeenCalledWith(
          "task-123",
          "goal",
          0
        );
      });
    });

    it("Escape key cancels section edit", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Switch to Sections tab
      await userEvent.click(screen.getByRole("tab", { name: /sections/i }));

      // Click section content to edit
      await userEvent.click(screen.getByText("Complete the feature"));

      // Verify we're in edit mode
      expect(
        screen.getByDisplayValue("Complete the feature")
      ).toBeInTheDocument();

      // Press Escape
      await userEvent.keyboard("{Escape}");

      // Should return to display mode
      expect(screen.getByText("Complete the feature")).toBeInTheDocument();
      expect(
        screen.queryByDisplayValue("Complete the feature")
      ).not.toBeInTheDocument();
    });

    it("Enter key saves section edit", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Switch to Sections tab
      await userEvent.click(screen.getByRole("tab", { name: /sections/i }));

      // Click section content to edit
      await userEvent.click(screen.getByText("Complete the feature"));

      const input = screen.getByDisplayValue("Complete the feature");
      await userEvent.clear(input);
      await userEvent.type(input, "Updated goal{Enter}");

      await waitFor(() => {
        expect(eventsModule.commands.editSection).toHaveBeenCalledWith(
          "task-123",
          "goal",
          0,
          "Updated goal"
        );
      });
    });

    it("step sections show checkbox that can be toggled without entering edit mode", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Switch to Sections tab
      await userEvent.click(screen.getByRole("tab", { name: /sections/i }));

      // Steps section should be open by default
      // Find the step checkbox (should show step number or checkmark)
      const stepCheckboxes = screen
        .getAllByRole("button")
        .filter((btn) => btn.title?.includes("Mark as"));

      expect(stepCheckboxes.length).toBeGreaterThan(0);

      // Click the first checkbox
      await userEvent.click(stepCheckboxes[0]);

      await waitFor(() => {
        expect(eventsModule.commands.toggleChecklistItemDone).toHaveBeenCalled();
      });
    });
  });

  describe("Cross-tab UX consistency", () => {
    it("warning dot has same styling in both tabs", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Test Details tab
      await userEvent.click(
        screen.getByText("Test Description for inline editing")
      );
      const detailsWarningDot = document.querySelector(".bg-warning");
      expect(detailsWarningDot).toHaveClass("rounded-full");

      // Cancel and switch to Sections tab
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("tab", { name: /sections/i }));

      // Edit a section
      await userEvent.click(screen.getByText("Complete the feature"));

      const sectionsWarningDot = document.querySelector(".bg-warning");
      expect(sectionsWarningDot).toHaveClass("rounded-full");
    });

    it("same keyboard shortcuts work in both tabs (Escape to cancel)", async () => {
      render(<TaskDetailPanel taskId="task-123" onClose={vi.fn()} />);

      // Test Details tab
      await userEvent.click(
        screen.getByText("Test Description for inline editing")
      );
      expect(screen.getByRole("textbox")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

      // Test Sections tab
      await userEvent.click(screen.getByRole("tab", { name: /sections/i }));
      await userEvent.click(screen.getByText("Complete the feature"));
      expect(screen.getByRole("textbox")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
  });
});
