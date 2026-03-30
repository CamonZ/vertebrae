import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  createMockTask,
  createMockStepExecution,
} from "../../test/test-utils";
import { LiveSection } from "./LiveSection";
import type { LiveItem } from "./LiveSection";

describe("LiveSection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when items array is empty", () => {
    const { container } = render(<LiveSection items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders section heading with item count", () => {
    const items: LiveItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Running Task" }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "build",
          status: "in_progress",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("displays task title and step name", () => {
    const items: LiveItem[] = [
      {
        task: createMockTask({
          id: "t-1",
          title: "Deploy Frontend",
          workflow_name: "Production",
        }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "deploy",
          status: "in_progress",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    expect(screen.getByText("Deploy Frontend")).toBeInTheDocument();
    expect(screen.getByText(/deploy/)).toBeInTheDocument();
  });

  it("displays workflow name and step name in the item description", () => {
    const items: LiveItem[] = [
      {
        task: createMockTask({
          id: "t-1",
          title: "Task",
          workflow_name: "CI Pipeline",
        }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "test",
          status: "in_progress",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    const item = screen.getByTestId("live-item");
    expect(item.textContent).toContain("CI Pipeline");
    expect(item.textContent).toContain("test");
  });

  it("renders a live duration timer for active executions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:01:30Z"));

    const items: LiveItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Running Task", workflow_name: "Build Pipeline" }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "build",
          status: "in_progress",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    const item = screen.getByTestId("live-item");
    expect(item.textContent).toContain("1m 30s");

    vi.useRealTimers();
  });

  it("renders multiple live items", () => {
    const items: LiveItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Build App" }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "build",
          status: "in_progress",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
      {
        task: createMockTask({ id: "t-2", title: "Run Tests" }),
        execution: createMockStepExecution({
          id: "e-2",
          task_id: "t-2",
          step_name: "test",
          status: "in_progress",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    expect(screen.getByText("2")).toBeInTheDocument();
    const liveItems = screen.getAllByTestId("live-item");
    expect(liveItems).toHaveLength(2);
    expect(screen.getByText("Build App")).toBeInTheDocument();
    expect(screen.getByText("Run Tests")).toBeInTheDocument();
  });

  it("has green-tinted backgrounds and left border on live items", () => {
    const items: LiveItem[] = [
      {
        task: createMockTask({ id: "t-1", title: "Task" }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "step",
          status: "in_progress",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    const item = screen.getByTestId("live-item");
    expect(item.className).toContain("bg-success/5");
    expect(item.className).toContain("border-l-success/40");
  });
});
