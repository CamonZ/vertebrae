import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
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

// Two attempts share the same TaskRun (run-A) and one belongs to a separate,
// earlier run (run-B), so "this task" rollups report 2 distinct runs across 3
// attempts.
const PLURAL_TASK_EXECUTIONS = [
  createMockStepExecution({
    id: "exec-task-old",
    task_id: "task-1",
    task_run_id: "run-B",
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
    id: "exec-task-retry",
    task_id: "task-1",
    task_run_id: "run-A",
    step_name: "in_progress",
    started_at: "2025-01-02T09:30:00Z",
    completed_at: "2025-01-02T09:31:00Z",
    status: "failed",
    cost: "0.03",
    input_tokens: 400,
    output_tokens: 100,
    duration_ms: 60000,
  }),
  createMockStepExecution({
    id: "exec-task-new",
    task_id: "task-1",
    task_run_id: "run-A",
    step_name: "in_progress",
    started_at: "2025-01-02T10:00:00Z",
    completed_at: "2025-01-02T10:01:30Z",
    status: "failed",
    cost: "0.05",
    input_tokens: 800,
    output_tokens: 200,
    duration_ms: 90000,
  }),
];

const SINGULAR_TASK_EXECUTIONS = [
  createMockStepExecution({
    id: "exec-task-only",
    task_id: "task-1",
    task_run_id: "run-only",
    step_name: "in_progress",
    started_at: "2025-01-02T10:00:00Z",
    completed_at: "2025-01-02T10:00:10Z",
    status: "completed",
    cost: "0.01",
    input_tokens: 100,
    output_tokens: 50,
    duration_ms: 10000,
  }),
];

let taskExecutions = PLURAL_TASK_EXECUTIONS;
let subtreeRollups = {
  totalRuns: 4,
  totalAttempts: 7,
  totalCost: 1.25,
  totalTokens: 12000,
  totalWallTimeMs: 600000,
};

vi.mock("../../hooks/useTaskExecutions", () => ({
  useTaskExecutions: () => ({
    executions: taskExecutions,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/useSubtreeExecutions", () => ({
  useSubtreeExecutions: () => ({
    executions: [],
    rollups: subtreeRollups,
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
    taskExecutions = PLURAL_TASK_EXECUTIONS;
    subtreeRollups = {
      totalRuns: 4,
      totalAttempts: 7,
      totalCost: 1.25,
      totalTokens: 12000,
      totalWallTimeMs: 600000,
    };
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

  it("renders 'this task' rollup with TaskRun count and StepExecution attempt count separated", () => {
    render(<TraceMiniView taskId="task-1" />);

    const taskRollup = screen.getByTestId("trace-mini-rollup-task");
    const subtreeRollup = screen.getByTestId("trace-mini-rollup-subtree");

    // Three attempts (StepExecutions) span two TaskRuns; the headline number
    // is the TaskRun count so retries don't inflate "runs". Both labels must
    // pluralize since the counts are > 1.
    expect(taskRollup).toHaveTextContent("This task");
    expect(screen.getByTestId("trace-mini-rollup-task-runs")).toHaveTextContent(
      "2"
    );
    expect(within(taskRollup).getByText("runs")).toBeInTheDocument();
    expect(within(taskRollup).queryByText("run")).toBeNull();
    expect(
      screen.getByTestId("trace-mini-rollup-task-attempts")
    ).toHaveTextContent("3 attempts");
    expect(taskRollup).toHaveTextContent("$0.20");

    expect(subtreeRollup).toHaveTextContent("Subtree");
    expect(
      screen.getByTestId("trace-mini-rollup-subtree-runs")
    ).toHaveTextContent("4");
    expect(within(subtreeRollup).getByText("runs")).toBeInTheDocument();
    expect(within(subtreeRollup).queryByText("run")).toBeNull();
    expect(
      screen.getByTestId("trace-mini-rollup-subtree-attempts")
    ).toHaveTextContent("7 attempts");
    expect(subtreeRollup).toHaveTextContent("$1.25");

    // Visually distinguished: subtree card uses primary accent
    expect(subtreeRollup.className).toContain("primary");
    expect(taskRollup.className).not.toContain("primary");
  });

  it("singularizes the run/attempt labels when the counts are exactly one", () => {
    taskExecutions = SINGULAR_TASK_EXECUTIONS;
    subtreeRollups = {
      totalRuns: 1,
      totalAttempts: 1,
      totalCost: 0.01,
      totalTokens: 150,
      totalWallTimeMs: 10000,
    };

    render(<TraceMiniView taskId="task-1" />);

    const taskRollup = screen.getByTestId("trace-mini-rollup-task");
    const subtreeRollup = screen.getByTestId("trace-mini-rollup-subtree");

    expect(screen.getByTestId("trace-mini-rollup-task-runs")).toHaveTextContent(
      "1"
    );
    expect(within(taskRollup).getByText("run")).toBeInTheDocument();
    expect(within(taskRollup).queryByText("runs")).toBeNull();
    expect(
      screen.getByTestId("trace-mini-rollup-task-attempts").textContent
    ).toBe("1 attempt");

    expect(
      screen.getByTestId("trace-mini-rollup-subtree-runs")
    ).toHaveTextContent("1");
    expect(within(subtreeRollup).getByText("run")).toBeInTheDocument();
    expect(within(subtreeRollup).queryByText("runs")).toBeNull();
    expect(
      screen.getByTestId("trace-mini-rollup-subtree-attempts").textContent
    ).toBe("1 attempt");
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
