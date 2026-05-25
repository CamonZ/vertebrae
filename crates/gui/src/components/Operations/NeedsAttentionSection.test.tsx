import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  createMockTask,
  createMockTaskRun,
} from "../../test/test-utils";
import { NeedsAttentionSection } from "./NeedsAttentionSection";
import type { AttentionItem } from "./NeedsAttentionSection";

describe("NeedsAttentionSection", () => {
  it("renders nothing when items array is empty", () => {
    const { container } = render(<NeedsAttentionSection items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders section heading with item count", () => {
    const items: AttentionItem[] = [
      {
        kind: "failed_run",
        task: createMockTask({ id: "t-1", title: "Broken Task" }),
        taskRun: createMockTaskRun({
          id: "run-broken",
          task_id: "t-1",
          status: "failed",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    expect(screen.getByText("Zone: Attention")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("displays failed run with task title and run id", () => {
    const items: AttentionItem[] = [
      {
        kind: "failed_run",
        task: createMockTask({ id: "t-1", title: "Deploy Service" }),
        taskRun: createMockTaskRun({
          id: "run-12345678abcd",
          task_id: "t-1",
          status: "failed",
          started_at: "2025-01-01T12:00:00Z",
          ended_at: "2025-01-01T12:01:30Z",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    expect(screen.getByText("Deploy Service")).toBeInTheDocument();
    // First 8 chars of the run id are surfaced in the meta line.
    expect(screen.getByText("run-1234")).toBeInTheDocument();
    expect(screen.getByText("View Logs")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("calls onViewLogs with the failed TaskRun id when View Logs is clicked", () => {
    const onViewLogs = vi.fn();
    const items: AttentionItem[] = [
      {
        kind: "failed_run",
        task: createMockTask({ id: "t-1", title: "Task" }),
        taskRun: createMockTaskRun({
          id: "run-42",
          task_id: "t-1",
          status: "failed",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} onViewLogs={onViewLogs} />);

    fireEvent.click(screen.getByText("View Logs"));
    expect(onViewLogs).toHaveBeenCalledWith("run-42");
  });

  it("calls onRetry with task ID when Retry is clicked", () => {
    const onRetry = vi.fn();
    const items: AttentionItem[] = [
      {
        kind: "failed_run",
        task: createMockTask({ id: "t-1", title: "Task" }),
        taskRun: createMockTaskRun({
          id: "run-42",
          task_id: "t-1",
          status: "failed",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} onRetry={onRetry} />);

    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledWith("t-1");
  });

  it("renders multiple failed run items", () => {
    const items: AttentionItem[] = [
      {
        kind: "failed_run",
        task: createMockTask({ id: "t-1", title: "Failed Build" }),
        taskRun: createMockTaskRun({
          id: "run-build",
          task_id: "t-1",
          status: "failed",
        }),
      },
      {
        kind: "failed_run",
        task: createMockTask({ id: "t-2", title: "Failed Deploy" }),
        taskRun: createMockTaskRun({
          id: "run-deploy",
          task_id: "t-2",
          status: "failed",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    expect(screen.getByText("2")).toBeInTheDocument();
    const attentionItems = screen.getAllByTestId("attention-item");
    expect(attentionItems).toHaveLength(2);
    expect(screen.getByText("Failed Build")).toBeInTheDocument();
    expect(screen.getByText("Failed Deploy")).toBeInTheDocument();
  });
});
