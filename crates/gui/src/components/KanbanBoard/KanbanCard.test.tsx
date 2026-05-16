import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, createMockTask } from "../../test/test-utils";
import { KanbanCard } from "./KanbanCard";

describe("KanbanCard", () => {
  describe("basic rendering", () => {
    it("renders task title", () => {
      const task = createMockTask({ title: "Implement login flow" });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("Implement login flow")).toBeInTheDocument();
    });

    it("renders the 8-digit short task ID", () => {
      const task = createMockTask({ id: "860cde1b-9093-42ff-a19d-7453f3b7891b" });
      render(<KanbanCard task={task} />);

      expect(screen.getByTestId("kanban-card-id")).toHaveTextContent("860cde1b");
      expect(screen.queryByText(task.id)).not.toBeInTheDocument();
    });

    it("renders level badge for epic", () => {
      const task = createMockTask({ level: "epic" });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("Epic")).toBeInTheDocument();
    });

    it("renders level badge for ticket", () => {
      const task = createMockTask({ level: "ticket" });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("Ticket")).toBeInTheDocument();
    });

    it("renders level badge for task", () => {
      const task = createMockTask({ level: "task" });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("Task")).toBeInTheDocument();
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

    it("renders 'No step' when step_name is null", () => {
      const task = createMockTask({ step_name: null });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("No step")).toBeInTheDocument();
    });

    it("renders review indicator when needs_human_review is true", () => {
      const task = createMockTask({ needs_human_review: true });
      render(<KanbanCard task={task} />);

      expect(screen.getByText("Review")).toBeInTheDocument();
    });

    it("does not render review indicator when needs_human_review is false", () => {
      const task = createMockTask({ needs_human_review: false });
      render(<KanbanCard task={task} />);

      // The "Review" text for review indicator should not be present
      // (step name "Review" badge is a different case)
      expect(screen.queryByText("Review")).not.toBeInTheDocument();
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

      expect(screen.getByRole("button", { name: "Task: Accessible task" })).toBeInTheDocument();
    });
  });

  describe("selected state", () => {
    it("applies selected styling when isSelected is true", () => {
      const task = createMockTask({ title: "Selected task" });
      render(<KanbanCard task={task} isSelected={true} />);

      const card = screen.getByRole("button", { name: /Task: Selected task/i });
      expect(card.className).toContain("border-primary/50");
    });

    it("does not apply selected styling when isSelected is false", () => {
      const task = createMockTask({ title: "Unselected task" });
      render(<KanbanCard task={task} isSelected={false} />);

      const card = screen.getByRole("button", { name: /Task: Unselected task/i });
      expect(card.className).not.toContain("border-primary/50");
    });
  });
});
