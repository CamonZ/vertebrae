import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render, createMockTaskWithRelations } from "../../test/test-utils";
import { TaskDetailPanel } from "./TaskDetailPanel";
import * as commands from "../../bindings";
import * as eventsModule from "../../bindings";

// Mock the useTask hook to return task data directly
vi.mock("../../hooks/useTask", () => ({
  useTask: (id: string | null) => {
    if (!id) {
      return { task: null, isLoading: false, error: null, refetch: vi.fn() };
    }
    return {
      task: createMockTaskWithRelations({
        task: {
          id: id,
          title: "Test Task",
          description: "Test Description",
          level: "task" as const,
          priority: "medium" as const,
          tags: ["tag1"],
          sections: [],
          code_refs: [],
        },
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

// Mock the useDeleteTask hook
vi.mock("../../hooks/useDeleteTask", () => ({
  useDeleteTask: () => ({
    isDeleteDialogOpen: false,
    openDeleteDialog: vi.fn(),
    closeDeleteDialog: vi.fn(),
    cascade: false,
    setCascade: vi.fn(),
    isDeleting: false,
    deleteError: null,
    confirmDelete: vi.fn(),
  }),
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

const mockTaskData = createMockTaskWithRelations({
  task: {
    id: "task-123",
    title: "Test Task",
    description: "Test Description",
    level: "task",
    priority: "medium",
    tags: ["tag1"],
    sections: [],
    code_refs: [],
  },
});

describe("TaskDetailPanel - Edit Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(eventsModule.events.taskChangedEvent.listen).mockResolvedValue(() => {});
  });

  describe("Edit button", () => {
    it("renders Edit button in the header", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const editButton = screen.getByRole("button", { name: /edit/i });
      expect(editButton).toBeInTheDocument();
      expect(editButton).toHaveAttribute("title", "Edit this task");
    });

    it("Edit button is not disabled", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const editButton = screen.getByRole("button", { name: /edit/i });
      expect(editButton).not.toBeDisabled();
    });

    it("opens TaskEditForm modal when Edit button is clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const editButton = screen.getByRole("button", { name: /edit/i });
      fireEvent.click(editButton);

      // Modal should appear
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Edit Task")).toBeInTheDocument();
    });

    it("pre-populates TaskEditForm with current task data", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const editButton = screen.getByRole("button", { name: /edit/i });
      fireEvent.click(editButton);

      const titleInput = screen.getByDisplayValue("Test Task");
      expect(titleInput).toBeInTheDocument();
      expect(titleInput).toHaveAttribute("id", "edit-task-title");
    });

    it("pre-populates description field", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const editButton = screen.getByRole("button", { name: /edit/i });
      fireEvent.click(editButton);

      const descriptionInput = screen.getByDisplayValue("Test Description");
      expect(descriptionInput).toBeInTheDocument();
    });
  });

  describe("Form cancellation", () => {
    it("closes form when Cancel button is clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      // Open form
      const editButton = screen.getByRole("button", { name: /edit/i });
      fireEvent.click(editButton);
      expect(screen.getByText("Edit Task")).toBeInTheDocument();

      // Click Cancel
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(cancelButton);

      // Modal should close
      expect(screen.queryByText("Edit Task")).not.toBeInTheDocument();
    });
  });

  describe("Tab navigation", () => {
    it("displays Details tab by default", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const detailsTab = screen.getByRole("tab", { name: /details/i });
      expect(detailsTab).toHaveAttribute("aria-selected", "true");
    });

    it("can switch to Sections tab", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
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
          taskId={mockTaskData.task.id}
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
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const codeTab = screen.getByRole("tab", { name: /code/i });
      fireEvent.click(codeTab);
      expect(codeTab).toHaveAttribute("aria-selected", "true");
    });

    it("preserves active tab when Edit form is opened and closed", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      // Switch to Sections tab
      const sectionsTab = screen.getByRole("tab", { name: /sections/i });
      fireEvent.click(sectionsTab);
      expect(sectionsTab).toHaveAttribute("aria-selected", "true");

      // Open Edit form
      const editButton = screen.getByRole("button", { name: /edit/i });
      fireEvent.click(editButton);
      expect(screen.getByText("Edit Task")).toBeInTheDocument();

      // Close Edit form
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(cancelButton);

      // Sections tab should still be selected
      expect(sectionsTab).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("Close button", () => {
    it("renders Close button", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
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
          taskId={mockTaskData.task.id}
          onClose={mockOnClose}
        />
      );

      const closeButton = screen.getByRole("button", { name: /close panel/i });
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Header buttons interaction", () => {
    it("renders Edit, Delete, and Close buttons in header", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /close panel/i })).toBeInTheDocument();
    });

    it("Edit button is positioned before Delete button", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const buttons = screen.getAllByRole("button");
      const editIndex = buttons.findIndex(b => b.getAttribute("aria-label") === "Edit task");
      const deleteIndex = buttons.findIndex(b => b.getAttribute("aria-label") === "Delete task");

      expect(editIndex).toBeLessThan(deleteIndex);
    });
  });

  describe("Form submission", () => {
    it("calls updateTask command on form submission", () => {
      const mockUpdateTask = vi.fn().mockResolvedValue({
        status: "ok",
        data: null,
      });
      vi.mocked(commands.commands.updateTask).mockImplementation(mockUpdateTask);

      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      // Open form
      const editButton = screen.getByRole("button", { name: /edit/i });
      fireEvent.click(editButton);

      // Submit form
      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      // updateTask should have been called
      expect(mockUpdateTask).toHaveBeenCalled();
    });
  });

  describe("Task title display", () => {
    it("displays task title in the panel", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText("Test Task")).toBeInTheDocument();
    });
  });

  describe("Modal rendering", () => {
    it("renders FormModal when Edit button is clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const editButton = screen.getByRole("button", { name: /edit/i });
      fireEvent.click(editButton);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("does not render modal when taskId is null", () => {
      render(
        <TaskDetailPanel
          taskId={null}
          onClose={vi.fn()}
        />
      );

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("Sections tab content", () => {
    it("displays Sections tab content when clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const sectionsTab = screen.getByRole("tab", { name: /sections/i });
      fireEvent.click(sectionsTab);

      // Should display section-related content or empty state
      expect(screen.getByText(/no sections defined/i)).toBeInTheDocument();
    });

    it("shows Add Section button in Sections tab", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const sectionsTab = screen.getByRole("tab", { name: /sections/i });
      fireEvent.click(sectionsTab);

      expect(screen.getByRole("button", { name: /add section/i })).toBeInTheDocument();
    });
  });

  describe("Relations tab content", () => {
    it("displays Relations tab content when clicked", () => {
      render(
        <TaskDetailPanel
          taskId={mockTaskData.task.id}
          onClose={vi.fn()}
        />
      );

      const graphTab = screen.getByRole("tab", { name: /graph/i });
      fireEvent.click(graphTab);

      // Should display relationship-related content
      const parentLabel = screen.getAllByText(/parent/i);
      expect(parentLabel.length).toBeGreaterThan(0);
    });
  });
});
