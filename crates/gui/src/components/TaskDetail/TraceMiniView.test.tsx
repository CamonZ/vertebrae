import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render, createMockStepExecution } from "../../test/test-utils";
import { TraceMiniView } from "./TraceMiniView";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom"
  );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// useTaskExecutions: only the task's own executions
vi.mock("../../hooks/useTaskExecutions", () => ({
  useTaskExecutions: () => ({
    executions: [
      createMockStepExecution({
        id: "exec-task-old",
        task_id: "task-1",
        step_name: "in_progress",
        started_at: "2025-01-01T10:00:00Z",
        completed_at: "2025-01-01T10:00:30Z",
        status: "completed",
        cost: "0.12",
        input_tokens: 1000,
        output_tokens: 500,
        duration_ms: 30000,
      }),
      createMockStepExecution({
        id: "exec-task-new",
        task_id: "task-1",
        step_name: "in_progress",
        started_at: "2025-01-02T10:00:00Z",
        completed_at: "2025-01-02T10:01:30Z",
        status: "failed",
        cost: "0.05",
        input_tokens: 800,
        output_tokens: 200,
        duration_ms: 90000,
      }),
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// useSubtreeExecutions: rollups across the whole subtree (including this task)
vi.mock("../../hooks/useSubtreeExecutions", () => ({
  useSubtreeExecutions: () => ({
    executions: [],
    rollups: {
      totalRuns: 7,
      totalCost: 1.25,
      totalTokens: 12000,
      totalWallTimeMs: 600000,
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    subtreeTaskIds: ["task-1", "child-1", "child-2"],
    isInSubtree: vi.fn(),
  }),
}));

describe("TraceMiniView", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it("renders workflow and step breadcrumb", () => {
    render(
      <TraceMiniView
        taskId="task-1"
        workflowName="Implementation"
        stepName="in_progress"
      />
    );

    expect(screen.getByText("Implementation")).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
  });

  it("renders the last execution status pill from the most recent execution", () => {
    render(
      <TraceMiniView
        taskId="task-1"
        workflowName="Implementation"
        stepName="in_progress"
      />
    );

    // The newest execution is the failed one — the pill must reflect that,
    // not the older completed run.
    const pill = screen.getByTestId("trace-mini-status");
    expect(pill).toHaveTextContent("failed");
    expect(pill).toHaveAttribute("data-status", "failed");
  });

  it("renders the last execution duration and cost", () => {
    render(<TraceMiniView taskId="task-1" />);

    const lastExec = screen.getByTestId("trace-mini-last-exec");
    // 90000ms = 1m 30s
    expect(lastExec).toHaveTextContent("1m 30s");
    expect(lastExec).toHaveTextContent("$0.05");
  });

  it("renders 'this task' rollup distinct from 'subtree' rollup", () => {
    render(<TraceMiniView taskId="task-1" />);

    const taskRollup = screen.getByTestId("trace-mini-rollup-task");
    const subtreeRollup = screen.getByTestId("trace-mini-rollup-subtree");

    expect(taskRollup).toHaveTextContent("This task");
    expect(taskRollup).toHaveTextContent("2");
    expect(taskRollup).toHaveTextContent("$0.17");

    expect(subtreeRollup).toHaveTextContent("Subtree");
    expect(subtreeRollup).toHaveTextContent("7");
    expect(subtreeRollup).toHaveTextContent("$1.25");

    // Visually distinguished: subtree card uses primary accent
    expect(subtreeRollup.className).toContain("primary");
    expect(taskRollup.className).not.toContain("primary");
  });

  it("navigates to /traces/:taskId when Explore traces is clicked", () => {
    render(<TraceMiniView taskId="task-1" />);

    const exploreButton = screen.getByTestId("trace-mini-explore");
    expect(exploreButton).toHaveTextContent("Explore traces");

    fireEvent.click(exploreButton);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/traces/task-1");
  });

  it("falls back to a placeholder when no workflow is set", () => {
    render(<TraceMiniView taskId="task-1" workflowName={null} />);

    expect(screen.getByText("No workflow")).toBeInTheDocument();
  });
});
