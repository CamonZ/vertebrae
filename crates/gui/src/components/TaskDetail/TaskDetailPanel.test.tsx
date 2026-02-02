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
        sections: [],
        code_refs: [],
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

// Mock the commands and events
vi.mock("../../bindings", () => ({
  commands: {
    updateTask: vi.fn(),
    runWorkflow: vi.fn(),
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

describe("TaskDetailPanel - Edit Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(eventsModule.events.taskChangedEvent.listen).mockResolvedValue(() => {});
  });

  describe("Tab navigation", () => {
    it("displays Details tab by default", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      const detailsTab = screen.getByRole("tab", { name: /details/i });
      expect(detailsTab).toHaveAttribute("aria-selected", "true");
    });

    it("can switch to Sections tab", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      const sectionsTab = screen.getByRole("tab", { name: /sections/i });
      fireEvent.click(sectionsTab);
      expect(sectionsTab).toHaveAttribute("aria-selected", "true");
    });

    it("can switch to Graph (Relations) tab", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      const graphTab = screen.getByRole("tab", { name: /graph/i });
      fireEvent.click(graphTab);
      expect(graphTab).toHaveAttribute("aria-selected", "true");
    });

    it("can switch to Code tab", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      const codeTab = screen.getByRole("tab", { name: /code/i });
      fireEvent.click(codeTab);
      expect(codeTab).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("Close button", () => {
    it("renders Close button", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      const closeButton = screen.getByRole("button", { name: /close panel/i });
      expect(closeButton).toBeInTheDocument();
    });

    it("calls onClose when Close button is clicked", () => {
      const mockOnClose = vi.fn();

      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={mockOnClose}
        />
      );

      const closeButton = screen.getByRole("button", { name: /close panel/i });
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Header buttons interaction", () => {
    it("renders Delete and Close buttons in header", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /close panel/i })).toBeInTheDocument();
    });

    it("Delete button is positioned before Close button", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      const buttons = screen.getAllByRole("button");
      const deleteIndex = buttons.findIndex(b => b.getAttribute("aria-label") === "Delete task");
      const closeIndex = buttons.findIndex(b => b.getAttribute("aria-label") === "Close panel");

      expect(deleteIndex).toBeLessThan(closeIndex);
    });
  });

  describe("Task title display", () => {
    it("displays task title in the panel", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText("Test Task")).toBeInTheDocument();
    });
  });

  describe("Inline editing - Title", () => {
    it("makes title editable when clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      // Click on title to edit
      const titleElement = screen.getByText("Test Task");
      fireEvent.click(titleElement);

      // Should show input field for editing (auto-save on blur)
      const titleInput = screen.getByDisplayValue("Test Task");
      expect(titleInput).toBeInTheDocument();
      expect(titleInput).toHaveAttribute("type", "text");
    });
  });

  describe("Inline editing - Description", () => {
    it("makes description editable when clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      // Find and click description
      const descriptionText = screen.getByText("Test Description");
      fireEvent.click(descriptionText);

      // Should show textarea
      const descriptionInput = screen.getByDisplayValue("Test Description");
      expect(descriptionInput).toBeInTheDocument();
      expect(descriptionInput.tagName).toBe("TEXTAREA");
    });
  });

  describe("Inline editing - Tags", () => {
    it("makes tags editable when clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      // Find and click tags section
      const tagsContainer = screen.getByText("tag1").closest("div");
      fireEvent.click(tagsContainer!);

      // Should show input with tags as comma-separated
      const tagsInput = screen.getByDisplayValue("tag1");
      expect(tagsInput).toBeInTheDocument();
      expect(tagsInput.tagName).toBe("INPUT");
    });
  });

  describe("Inline editing - Priority", () => {
    it("Priority field is visible in details tab", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      // Priority label should be present
      const priorityLabels = screen.getAllByText(/Priority/i);
      expect(priorityLabels.length).toBeGreaterThan(0);
    });
  });

  describe("Delete confirmation - Toggle", () => {
    it("renders Delete button in header", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      const deleteButton = screen.getByRole("button", { name: /delete/i });
      expect(deleteButton).toBeInTheDocument();
      expect(deleteButton).toHaveAttribute("title", "Delete this task");
    });

    it("shows delete confirmation when Delete button clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      const deleteButton = screen.getByRole("button", { name: /delete/i });
      fireEvent.click(deleteButton);

      // Should show confirmation message
      expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
    });

    it("shows Confirm Delete button when delete confirmation visible", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      // Show confirmation
      fireEvent.click(screen.getByRole("button", { name: /delete/i }));

      // Should show Confirm Delete button
      expect(screen.getByRole("button", { name: /Confirm Delete/i })).toBeInTheDocument();
    });

    it("hides confirmation when Cancel button clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.id}
          onClose={vi.fn()}
        />
      );

      // Show confirmation
      fireEvent.click(screen.getByRole("button", { name: /delete/i }));
      expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();

      // Click Cancel
      const cancelButtons = screen.getAllByRole("button", { name: /cancel/i });
      fireEvent.click(cancelButtons[cancelButtons.length - 1]); // Last Cancel button is in delete section

      // Confirmation should be gone
      expect(screen.queryByText(/Are you sure you want to delete/)).not.toBeInTheDocument();
    });
  });
});
