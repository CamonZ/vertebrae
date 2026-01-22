import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render, createMockTaskWithRelations } from "../../test/test-utils";
import { TaskDetailPanel } from "./TaskDetailPanel";
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
});
