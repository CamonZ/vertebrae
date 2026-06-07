import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, createMockTask } from "../../test/test-utils";
import { KanbanColumn } from "./KanbanColumn";

describe("KanbanColumn", () => {
  describe("header rendering", () => {
    it("renders column name in header", () => {
      render(<KanbanColumn columnName="In Progress" tasks={[]} />);

      expect(screen.getByText("In Progress")).toBeInTheDocument();
    });

    it("renders task count of zero when no tasks", () => {
      render(<KanbanColumn columnName="Backlog" tasks={[]} />);

      expect(screen.getByText("0")).toBeInTheDocument();
    });

    it("renders task count matching number of tasks", () => {
      const tasks = [
        createMockTask({ id: "task-1", title: "Task 1" }),
        createMockTask({ id: "task-2", title: "Task 2" }),
        createMockTask({ id: "task-3", title: "Task 3" }),
      ];
      render(<KanbanColumn columnName="Todo" tasks={tasks} />);

      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("has accessible region label with column name and count", () => {
      const tasks = [createMockTask({ id: "task-1", title: "Task A" })];
      render(<KanbanColumn columnName="Review" tasks={tasks} />);

      expect(screen.getByRole("region", { name: "Review column, 1 tasks" })).toBeInTheDocument();
    });

    it("renders a non-empty count as a serif-italic copper accent numeral", () => {
      const tasks = [createMockTask({ id: "task-1", title: "Task A" })];
      render(<KanbanColumn columnName="Review" tasks={tasks} />);

      const count = screen.getByTestId("kanban-column-count");
      expect(count).toHaveTextContent("1");
      expect(count).toHaveClass("font-serif", "italic", "text-[var(--color-accent)]");
    });
  });

  describe("empty state", () => {
    it("shows empty message when column has no tasks", () => {
      render(<KanbanColumn columnName="Done" tasks={[]} />);

      expect(screen.getByText("Nothing here")).toBeInTheDocument();
    });
  });

  describe("task cards", () => {
    it("renders all task cards", () => {
      const tasks = [
        createMockTask({ id: "task-1", title: "First Task" }),
        createMockTask({ id: "task-2", title: "Second Task" }),
      ];
      render(<KanbanColumn columnName="Backlog" tasks={tasks} />);

      expect(screen.getByText("First Task")).toBeInTheDocument();
      expect(screen.getByText("Second Task")).toBeInTheDocument();
    });

    it("passes selectedTaskId to cards for highlight", () => {
      const tasks = [
        createMockTask({ id: "task-selected", title: "Selected One" }),
        createMockTask({ id: "task-other", title: "Other One" }),
      ];
      render(
        <KanbanColumn
          columnName="Active"
          tasks={tasks}
          selectedTaskId="task-selected"
        />
      );

      const selectedCard = screen.getByRole("button", { name: /Task: Selected One/i });
      const otherCard = screen.getByRole("button", { name: /Task: Other One/i });
      // Selection signal is the shared accent left bar (no accent border).
      expect(selectedCard.className).toContain("before:bg-[var(--color-accent)]");
      expect(otherCard.className).not.toContain("before:bg-[var(--color-accent)]");
    });

    it("calls onTaskSelect when a card is clicked", () => {
      const task = createMockTask({ id: "task-1", title: "Clickable" });
      const onTaskSelect = vi.fn();
      render(
        <KanbanColumn
          columnName="Todo"
          tasks={[task]}
          onTaskSelect={onTaskSelect}
        />
      );

      fireEvent.click(screen.getByText("Clickable"));
      expect(onTaskSelect).toHaveBeenCalledTimes(1);
      expect(onTaskSelect).toHaveBeenCalledWith(task);
    });
  });
});
