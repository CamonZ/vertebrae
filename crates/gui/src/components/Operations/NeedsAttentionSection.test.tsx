import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  createMockTask,
  createMockStepExecution,
} from "../../test/test-utils";
import { NeedsAttentionSection } from "./NeedsAttentionSection";
import type { AttentionItem } from "./NeedsAttentionSection";

vi.mock("../../bindings", () => ({
  commands: {
    updateTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

import { commands } from "../../bindings";

describe("NeedsAttentionSection", () => {
  it("renders nothing when items array is empty", () => {
    const { container } = render(<NeedsAttentionSection items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders section heading with item count", () => {
    const items: AttentionItem[] = [
      {
        kind: "failed_execution",
        task: createMockTask({ id: "t-1", title: "Broken Task" }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "build",
          status: "failed",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("displays failed execution with task title and step name", () => {
    const items: AttentionItem[] = [
      {
        kind: "failed_execution",
        task: createMockTask({ id: "t-1", title: "Deploy Service" }),
        execution: createMockStepExecution({
          id: "e-1",
          task_id: "t-1",
          step_name: "deploy",
          status: "failed",
          started_at: "2025-01-01T12:00:00Z",
          completed_at: "2025-01-01T12:01:30Z",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    expect(screen.getByText("Deploy Service")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.getByText("View Logs")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("displays review request with task title and Approve/Reject buttons", () => {
    const items: AttentionItem[] = [
      {
        kind: "review_request",
        task: createMockTask({
          id: "t-2",
          title: "Needs Review Task",
          needs_human_review: true,
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    expect(screen.getByText("Needs Review Task")).toBeInTheDocument();
    expect(screen.getByText("Waiting for human review")).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
  });

  it("calls onViewLogs with execution ID when View Logs is clicked", () => {
    const onViewLogs = vi.fn();
    const items: AttentionItem[] = [
      {
        kind: "failed_execution",
        task: createMockTask({ id: "t-1", title: "Task" }),
        execution: createMockStepExecution({
          id: "exec-42",
          task_id: "t-1",
          step_name: "test",
          status: "failed",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} onViewLogs={onViewLogs} />);

    fireEvent.click(screen.getByText("View Logs"));
    expect(onViewLogs).toHaveBeenCalledWith("exec-42");
  });

  it("calls onRetry with task ID and step name when Retry is clicked", () => {
    const onRetry = vi.fn();
    const items: AttentionItem[] = [
      {
        kind: "failed_execution",
        task: createMockTask({ id: "t-1", title: "Task" }),
        execution: createMockStepExecution({
          id: "exec-42",
          task_id: "t-1",
          step_name: "deploy",
          status: "failed",
        }),
      },
    ];
    render(<NeedsAttentionSection items={items} onRetry={onRetry} />);

    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledWith("t-1", "deploy");
  });

  it("calls updateTask to clear needs_human_review when Approve is clicked", () => {
    const items: AttentionItem[] = [
      {
        kind: "review_request",
        task: createMockTask({ id: "t-3", title: "Review Me" }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    fireEvent.click(screen.getByText("Approve"));
    expect(commands.updateTask).toHaveBeenCalledWith("t-3", expect.objectContaining({
      needs_human_review: false,
    }));
  });

  it("calls updateTask with revision_feedback when Reject is clicked", () => {
    const items: AttentionItem[] = [
      {
        kind: "review_request",
        task: createMockTask({ id: "t-4", title: "Reject Me" }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    fireEvent.click(screen.getByText("Reject"));
    expect(commands.updateTask).toHaveBeenCalledWith("t-4", expect.objectContaining({
      needs_human_review: false,
      revision_feedback: "Rejected during review",
    }));
  });

  it("renders multiple items of mixed kinds", () => {
    const items: AttentionItem[] = [
      {
        kind: "failed_execution",
        task: createMockTask({ id: "t-1", title: "Failed Build" }),
        execution: createMockStepExecution({
          id: "e-1",
          step_name: "build",
          status: "failed",
        }),
      },
      {
        kind: "review_request",
        task: createMockTask({ id: "t-2", title: "Pending Review" }),
      },
    ];
    render(<NeedsAttentionSection items={items} />);

    expect(screen.getByText("2")).toBeInTheDocument();
    const attentionItems = screen.getAllByTestId("attention-item");
    expect(attentionItems).toHaveLength(2);
    expect(screen.getByText("Failed Build")).toBeInTheDocument();
    expect(screen.getByText("Pending Review")).toBeInTheDocument();
  });
});
