import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render, createMockTask } from "../../test/test-utils";
import { TaskNode, type TaskNodeData } from "./TaskNode";

// Helper to create TaskNode props
function createTaskNodeProps(overrides?: Partial<TaskNodeData>) {
  const defaultData: TaskNodeData = {
    task: createMockTask(),
    status: "waiting",
    error: undefined,
    hasBlockers: false,
    isBlocking: false,
    isDoneStack: false,
    ...overrides,
  };

  return {
    id: `task-${defaultData.task.id}`,
    type: "taskNode" as const,
    data: defaultData,
    selected: false,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    draggable: true,
    dragHandle: undefined,
    selectable: true,
    deletable: true,
    parentId: undefined,
  };
}

describe("TaskNode", () => {
  describe("rendering", () => {
    it("renders task title", () => {
      const props = createTaskNodeProps({
        task: createMockTask({ title: "My Test Task" }),
      });

      render(<TaskNode {...props} />);

      expect(screen.getByText("My Test Task")).toBeInTheDocument();
    });

    it("renders task ID prefix (first 8 chars)", () => {
      const props = createTaskNodeProps({
        task: createMockTask({ id: "abcdefgh-1234-5678" }),
      });

      render(<TaskNode {...props} />);

      expect(screen.getByText("abcdefgh")).toBeInTheDocument();
    });

    it("handles empty task ID gracefully", () => {
      const task = createMockTask();
      task.id = undefined as unknown as string;
      const props = createTaskNodeProps({ task });

      // Should not throw
      render(<TaskNode {...props} />);
    });
  });

  describe("status display", () => {
    it("shows waiting icon for waiting status", () => {
      const props = createTaskNodeProps({ status: "waiting" });

      render(<TaskNode {...props} />);

      expect(screen.getByText("○")).toBeInTheDocument();
    });

    it("shows spinning icon for in_progress status", () => {
      const props = createTaskNodeProps({ status: "in_progress" });

      render(<TaskNode {...props} />);

      expect(screen.getByText("⟳")).toBeInTheDocument();
    });

    it("shows checkmark for completed status", () => {
      const props = createTaskNodeProps({ status: "completed" });

      render(<TaskNode {...props} />);

      expect(screen.getByText("✓")).toBeInTheDocument();
    });

    it("shows X for failed status", () => {
      const props = createTaskNodeProps({ status: "failed" });

      render(<TaskNode {...props} />);

      expect(screen.getByText("✕")).toBeInTheDocument();
    });
  });

  describe("error display", () => {
    it("renders error message when provided", () => {
      const props = createTaskNodeProps({
        status: "failed",
        error: "Connection timeout",
      });

      render(<TaskNode {...props} />);

      expect(screen.getByText("Connection timeout")).toBeInTheDocument();
    });

    it("does not render error section when no error", () => {
      const props = createTaskNodeProps({
        status: "waiting",
        error: undefined,
      });

      render(<TaskNode {...props} />);

      expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    });
  });

  describe("dependency indicators", () => {
    it("shows blocked indicator when task has blockers", () => {
      const props = createTaskNodeProps({ hasBlockers: true });

      render(<TaskNode {...props} />);

      expect(screen.getByText(/blocked/)).toBeInTheDocument();
    });

    it("shows blocks indicator when task is blocking others", () => {
      const props = createTaskNodeProps({ isBlocking: true });

      render(<TaskNode {...props} />);

      expect(screen.getByText(/blocks/)).toBeInTheDocument();
    });

    it("shows both indicators when task has blockers and is blocking", () => {
      const props = createTaskNodeProps({
        hasBlockers: true,
        isBlocking: true,
      });

      render(<TaskNode {...props} />);

      expect(screen.getByText(/blocked/)).toBeInTheDocument();
      expect(screen.getByText(/blocks/)).toBeInTheDocument();
    });

    it("does not show dependency indicators when no dependencies", () => {
      const props = createTaskNodeProps({
        hasBlockers: false,
        isBlocking: false,
      });

      render(<TaskNode {...props} />);

      expect(screen.queryByText(/blocked/)).not.toBeInTheDocument();
      expect(screen.queryByText(/blocks/)).not.toBeInTheDocument();
    });
  });

  describe("done stack styling", () => {
    it("applies done stack styles when isDoneStack is true", () => {
      const props = createTaskNodeProps({
        status: "completed",
        isDoneStack: true,
      });

      const { container } = render(<TaskNode {...props} />);

      // Should have muted styling for done stack
      const node = container.querySelector(".border-border.bg-bg-tertiary");
      expect(node).toBeInTheDocument();
    });

    it("applies status-based styles when not in done stack", () => {
      const props = createTaskNodeProps({
        status: "in_progress",
        isDoneStack: false,
      });

      const { container } = render(<TaskNode {...props} />);

      // Should have accent styling for in_progress
      const node = container.querySelector(".border-accent");
      expect(node).toBeInTheDocument();
    });
  });

  describe("selection state", () => {
    it("applies selected styles when selected", () => {
      const props = createTaskNodeProps();
      const selectedProps = { ...props, selected: true };

      const { container } = render(<TaskNode {...selectedProps} />);

      // Should have ring styling when selected
      const node = container.querySelector(".ring-2.ring-primary");
      expect(node).toBeInTheDocument();
    });
  });

  describe("status colors", () => {
    it("applies accent color for in_progress", () => {
      const props = createTaskNodeProps({ status: "in_progress" });

      const { container } = render(<TaskNode {...props} />);

      expect(container.querySelector(".border-accent")).toBeInTheDocument();
    });

    it("applies success color for completed", () => {
      const props = createTaskNodeProps({ status: "completed" });

      const { container } = render(<TaskNode {...props} />);

      expect(container.querySelector(".border-success")).toBeInTheDocument();
    });

    it("applies error color for failed", () => {
      const props = createTaskNodeProps({ status: "failed" });

      const { container } = render(<TaskNode {...props} />);

      expect(container.querySelector(".border-error")).toBeInTheDocument();
    });

    it("applies default border for waiting", () => {
      const props = createTaskNodeProps({ status: "waiting" });

      const { container } = render(<TaskNode {...props} />);

      expect(container.querySelector(".border-border")).toBeInTheDocument();
    });
  });
});
