import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  createMockTask,
  createMockStepExecution,
} from "../../test/test-utils";
import { RecentlyCompletedSection } from "./RecentlyCompletedSection";
import type { CompletedItem } from "./RecentlyCompletedSection";

describe("RecentlyCompletedSection", () => {
  it("renders nothing when items array is empty", () => {
    const { container } = render(<RecentlyCompletedSection items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders section heading with item count", () => {
    const items: CompletedItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Done Task" }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "deploy",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:02:00Z",
        }),
      },
    ];
    render(<RecentlyCompletedSection items={items} />);

    expect(screen.getByText("Recently Completed")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("displays task title, step name, and duration", () => {
    const items: CompletedItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Build Frontend" }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "build",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:02:34Z",
        }),
      },
    ];
    render(<RecentlyCompletedSection items={items} />);

    const item = screen.getByTestId("completed-item");
    expect(item.textContent).toContain("Build Frontend");
    expect(item.textContent).toContain("build");
  });

  it("dismisses a single item when dismiss button is clicked", () => {
    const items: CompletedItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Task A" }),
        execution: createMockStepExecution({
          id: "e-1",
          step_name: "step_a",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:00Z",
        }),
      },
      {
        task: createMockTask({ id: "t-2", title: "Task B" }),
        execution: createMockStepExecution({
          id: "e-2",
          step_name: "step_b",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:00Z",
        }),
      },
    ];
    render(<RecentlyCompletedSection items={items} />);

    expect(screen.getAllByTestId("completed-item")).toHaveLength(2);

    const dismissButton = screen.getByLabelText("Dismiss Task A");
    fireEvent.click(dismissButton);

    expect(screen.getAllByTestId("completed-item")).toHaveLength(1);
    expect(screen.queryByText("Task A")).not.toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
  });

  it("shows Dismiss all button when there are 2+ items", () => {
    const items: CompletedItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Task A" }),
        execution: createMockStepExecution({
          id: "e-1",
          step_name: "step_a",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:00Z",
        }),
      },
      {
        task: createMockTask({ id: "t-2", title: "Task B" }),
        execution: createMockStepExecution({
          id: "e-2",
          step_name: "step_b",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:00Z",
        }),
      },
    ];
    render(<RecentlyCompletedSection items={items} />);

    expect(screen.getByText("Dismiss all")).toBeInTheDocument();
  });

  it("does not show Dismiss all button when there is only 1 item", () => {
    const items: CompletedItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Task A" }),
        execution: createMockStepExecution({
          id: "e-1",
          step_name: "step_a",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:00Z",
        }),
      },
    ];
    render(<RecentlyCompletedSection items={items} />);

    expect(screen.queryByText("Dismiss all")).not.toBeInTheDocument();
  });

  it("dismisses all items when Dismiss all is clicked", () => {
    const items: CompletedItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Task A" }),
        execution: createMockStepExecution({
          id: "e-1",
          step_name: "step_a",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:00Z",
        }),
      },
      {
        task: createMockTask({ id: "t-2", title: "Task B" }),
        execution: createMockStepExecution({
          id: "e-2",
          step_name: "step_b",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:00Z",
        }),
      },
    ];
    const { container } = render(<RecentlyCompletedSection items={items} />);

    fireEvent.click(screen.getByText("Dismiss all"));

    // Section hides entirely when all items are dismissed
    expect(container.innerHTML).toBe("");
  });

  it("renders items with neutral styling (not red/green)", () => {
    const items: CompletedItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Task" }),
        execution: createMockStepExecution({
          id: "e-1",
          step_name: "step",
          status: "completed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:00Z",
        }),
      },
    ];
    render(<RecentlyCompletedSection items={items} />);

    const item = screen.getByTestId("completed-item");
    expect(item.className).toContain("bg-bg-secondary");
    expect(item.className).toContain("border-l-border");
    // Ensure no red or green tinting
    expect(item.className).not.toContain("error");
    expect(item.className).not.toContain("success");
  });
});
