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
        "title",
        `Epic ID: ${task.id}`
      );
    });

    it("labels the id badge with the level for ticket", () => {
      const task = createMockTask({ level: "ticket" });
      render(<KanbanCard task={task} />);

      expect(screen.getByTestId("kanban-card-id")).toHaveAttribute(
        "title",
        `Ticket ID: ${task.id}`
      );
    });

    it("labels the id badge with the level for task", () => {
      const task = createMockTask({ level: "task" });
      render(<KanbanCard task={task} />);

      expect(screen.getByTestId("kanban-card-id")).toHaveAttribute(
        "title",
        `Task ID: ${task.id}`
      );
    });

    it("renders workflow name when present", () => {
      const task = createMockTask({ workflow_name: "CI Pipeline" });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("CI Pipeline")).toBeInTheDocument();
    });

    it("does not render workflow name when null", () => {
      const task = createMockTask({ workflow_name: null });
      render(<KanbanCard task={task} />);

      expect(screen.queryByText("CI Pipeline")).not.toBeInTheDocument();
    });

    it("renders step name formatted with capitalization", () => {
      const task = createMockTask({ step_name: "in_progress" });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("In progress")).toBeInTheDocument();
    });

    it("renders the workflow segment alone when step_name is null", () => {
      const task = createMockTask({
        workflow_name: "CI Pipeline",
        step_name: null,
      });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("CI Pipeline")).toBeInTheDocument();
      expect(screen.queryByText("No step")).not.toBeInTheDocument();
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
    it("marks active runs and renders the run chip", () => {
      const activeRun = createMockTaskRun({ status: "executing" });
      const task = createMockTask({
        title: "Running task",
        run_controls: createMockTaskRunControls(activeRun),
      });
      render(<KanbanCard task={task} />);

      const card = screen.getByRole("button", { name: /Task: Running task/i });
      expect(card).toHaveAttribute("data-running", "true");
      expect(screen.getByLabelText("Run status: Running")).toBeInTheDocument();
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

    it("renders priority and tag vocabulary", () => {
      const task = createMockTask({
        title: "Critical task",
        priority: "critical",
        tags: ["hearth", "gui", "extra"],
      });
      render(<KanbanCard task={task} />);

      expect(screen.getByLabelText("Critical priority")).toHaveTextContent("↑");
      expect(screen.getByText("hearth")).toBeInTheDocument();
      expect(screen.getByText("gui")).toBeInTheDocument();
      expect(screen.getByText("+1")).toBeInTheDocument();
    });

    it("renders child state breakdowns", () => {
      const task = createMockTask({ title: "Parent task" });
      render(
        <KanbanCard
          task={task}
          childBreakdown={{ done: 1, running: 1, waiting: 0, queued: 2 }}
        />
      );

      expect(
        screen.getByLabelText(
          "State breakdown: 1 done, 1 running, 0 waiting, 2 queued"
        )
      ).toBeInTheDocument();
    });
  });
});
