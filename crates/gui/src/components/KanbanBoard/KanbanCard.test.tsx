import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
} from "../../test/test-utils";
import { KanbanCard } from "./KanbanCard";

describe("KanbanCard", () => {
  describe("basic rendering", () => {
    it("renders task title", () => {
      const task = createMockTask({ title: "Implement login flow" });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("Implement login flow")).toBeInTheDocument();
    });

    it("renders the 8-digit short task ID", () => {
      const task = createMockTask({
        id: "860cde1b-9093-42ff-a19d-7453f3b7891b",
      });
      render(<KanbanCard task={task} />);

      expect(screen.getByTestId("kanban-card-id")).toHaveTextContent(
        "860cde1b"
      );
      expect(screen.queryByText(task.id)).not.toBeInTheDocument();
    });

    it("labels the id badge with the level for epic", () => {
      const task = createMockTask({ level: "epic" });
      render(<KanbanCard task={task} />);

      expect(screen.getByTestId("kanban-card-id")).toHaveAttribute(
        "aria-label",
        "Copy full epic ID"
      );
    });

    it("labels the id badge with the level for ticket", () => {
      const task = createMockTask({ level: "ticket" });
      render(<KanbanCard task={task} />);

      expect(screen.getByTestId("kanban-card-id")).toHaveAttribute(
        "aria-label",
        "Copy full ticket ID"
      );
    });

    it("labels the id badge with the level for task", () => {
      const task = createMockTask({ level: "task" });
      render(<KanbanCard task={task} />);

      expect(screen.getByTestId("kanban-card-id")).toHaveAttribute(
        "aria-label",
        "Copy full task ID"
      );
    });

    it("shows only the title and id — no step, workflow, tags, or run chip", () => {
      const task = createMockTask({
        title: "Compact card",
        workflow_name: "CI Pipeline",
        step_name: "in_progress",
        priority: "critical",
        tags: ["hearth", "gui"],
        run_controls: createMockTaskRunControls(
          createMockTaskRun({ status: "executing" })
        ),
      });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("Compact card")).toBeInTheDocument();
      expect(screen.getByTestId("kanban-card-id")).toBeInTheDocument();
      expect(screen.queryByText("CI Pipeline")).not.toBeInTheDocument();
      expect(screen.queryByText("In progress")).not.toBeInTheDocument();
      expect(screen.queryByText("hearth")).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("Critical priority")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("Run status: Running")
      ).not.toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("calls onClick with task when clicked", () => {
      const task = createMockTask({ title: "Clickable task" });
      const onClick = vi.fn();
      render(<KanbanCard task={task} onClick={onClick} />);

      fireEvent.click(screen.getByText("Clickable task"));
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledWith(task);
    });

    it("calls onClick on Enter key press", () => {
      const task = createMockTask({ title: "Keyboard task" });
      const onClick = vi.fn();
      render(<KanbanCard task={task} onClick={onClick} />);

      const card = screen.getByRole("button", { name: /Task: Keyboard task/i });
      fireEvent.keyDown(card, { key: "Enter" });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("calls onClick on Space key press", () => {
      const task = createMockTask({ title: "Space task" });
      const onClick = vi.fn();
      render(<KanbanCard task={task} onClick={onClick} />);

      const card = screen.getByRole("button", { name: /Task: Space task/i });
      fireEvent.keyDown(card, { key: " " });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("has aria-label with task title", () => {
      const task = createMockTask({ title: "Accessible task" });
      render(<KanbanCard task={task} />);

      expect(
        screen.getByRole("button", { name: "Task: Accessible task" })
      ).toBeInTheDocument();
    });
  });

  describe("selected state", () => {
    it("applies selected styling when isSelected is true", () => {
      const task = createMockTask({ title: "Selected task" });
      render(<KanbanCard task={task} isSelected={true} />);

      const card = screen.getByRole("button", { name: /Task: Selected task/i });
      expect(card.className).toContain("border-[var(--color-accent)]");
    });

    it("does not apply selected styling when isSelected is false", () => {
      const task = createMockTask({ title: "Unselected task" });
      render(<KanbanCard task={task} isSelected={false} />);

      const card = screen.getByRole("button", {
        name: /Task: Unselected task/i,
      });
      expect(card.className).not.toContain("border-[var(--color-accent)]");
    });
  });

  describe("Hearth board states", () => {
    it("marks active runs via the data attribute (running styling)", () => {
      const activeRun = createMockTaskRun({ status: "executing" });
      const task = createMockTask({
        title: "Running task",
        run_controls: createMockTaskRunControls(activeRun),
      });
      render(<KanbanCard task={task} />);

      const card = screen.getByRole("button", { name: /Task: Running task/i });
      expect(card).toHaveAttribute("data-running", "true");
    });

    it("marks completed tasks as terminal board cards", () => {
      const task = createMockTask({
        title: "Done task",
        completed_at: "2026-05-30T00:00:00Z",
      });
      render(<KanbanCard task={task} />);

      expect(
        screen.getByRole("button", { name: /Task: Done task/i })
      ).toHaveAttribute("data-completed", "true");
    });
  });
});
