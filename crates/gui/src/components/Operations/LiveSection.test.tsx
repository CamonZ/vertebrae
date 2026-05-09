import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  createMockTask,
  createMockTaskRun,
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
        taskRun: createMockTaskRun({
          id: "run-1",
          task_id: "t-1",
          status: "executing",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("displays task title and active run status", () => {
    const items: LiveItem[] = [
      {
        task: createMockTask({
          id: "t-1",
          title: "Deploy Frontend",
          workflow_name: "Production",
        }),
        taskRun: createMockTaskRun({
          id: "run-1",
          task_id: "t-1",
          status: "executing",
          started_at: "2025-01-01T12:00:00Z",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    expect(screen.getByText("Deploy Frontend")).toBeInTheDocument();
    const item = screen.getByTestId("live-item");
    expect(item).toHaveAttribute("data-run-status", "executing");
    expect(item.textContent).toContain("running");
  });

  it("labels queued runs as queued in the description", () => {
    const items: LiveItem[] = [
      {
        task: createMockTask({
          id: "t-1",
          title: "Pending",
          workflow_name: "CI",
        }),
        taskRun: createMockTaskRun({
          id: "run-1",
          task_id: "t-1",
          status: "queued",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    const item = screen.getByTestId("live-item");
    expect(item).toHaveAttribute("data-run-status", "queued");
    expect(item.textContent).toContain("queued");
  });

  it("labels waiting runs as waiting", () => {
    const items: LiveItem[] = [
      {
        task: createMockTask({
          id: "t-1",
          title: "Awaiting Input",
          workflow_name: "Approvals",
        }),
        taskRun: createMockTaskRun({
          id: "run-1",
          task_id: "t-1",
          status: "waiting",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    const item = screen.getByTestId("live-item");
    expect(item).toHaveAttribute("data-run-status", "waiting");
    expect(item.textContent).toContain("waiting");
  });

  it("renders a live duration timer for executing runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:01:30Z"));

    const items: LiveItem[] = [
      {
        task: createMockTask({
          id: "t-1",
          title: "Running Task",
          workflow_name: "Build Pipeline",
        }),
        taskRun: createMockTaskRun({
          id: "run-1",
          task_id: "t-1",
          status: "executing",
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
        taskRun: createMockTaskRun({
          id: "run-1",
          task_id: "t-1",
          status: "executing",
        }),
      },
      {
        task: createMockTask({ id: "t-2", title: "Run Tests" }),
        taskRun: createMockTaskRun({
          id: "run-2",
          task_id: "t-2",
          status: "executing",
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
        taskRun: createMockTaskRun({
          id: "run-1",
          task_id: "t-1",
          status: "executing",
        }),
      },
    ];
    render(<LiveSection items={items} />);

    const item = screen.getByTestId("live-item");
    expect(item.className).toContain("bg-success/5");
    expect(item.className).toContain("border-l-success/40");
  });
});
