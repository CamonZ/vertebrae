import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  createMockTask,
  createMockTaskRun,
  createMockStepExecution,
} from "../test/test-utils";
import { OperationsPage } from "./OperationsPage";
import type { Task, StepExecution, TaskRun } from "../bindings";

let mockAttentionItems: {
  kind: "failed_run" | "review_request";
  task: Task;
  taskRun?: TaskRun;
}[] = [];
let mockLiveItems: { task: Task; taskRun: TaskRun }[] = [];
let mockCompletedItems: { task: Task; execution: StepExecution }[] = [];
let mockReadyTasks: Task[] = [];
let mockIsLoading = false;
let mockError: string | null = null;

vi.mock("../hooks/useOperationsData", () => ({
  useOperationsData: () => ({
    attentionItems: mockAttentionItems,
    liveItems: mockLiveItems,
    completedItems: mockCompletedItems,
    readyTasks: mockReadyTasks,
    isLoading: mockIsLoading,
    error: mockError,
    refetch: vi.fn(),
  }),
}));

// Mock the sub-components to isolate page-level tests
vi.mock("../components/Operations", () => ({
  NeedsAttentionSection: ({ items }: { items: unknown[] }) =>
    items.length > 0 ? <div data-testid="needs-attention-section">Needs Attention ({items.length})</div> : null,
  LiveSection: ({ items }: { items: unknown[] }) =>
    items.length > 0 ? <div data-testid="live-section">Live ({items.length})</div> : null,
  RecentlyCompletedSection: ({ items }: { items: unknown[] }) =>
    items.length > 0 ? <div data-testid="completed-section">Completed ({items.length})</div> : null,
  ReadySection: ({ tasks }: { tasks: unknown[] }) =>
    tasks.length > 0 ? <div data-testid="ready-section">Ready ({tasks.length})</div> : null,
}));

describe("OperationsPage", () => {
  beforeEach(() => {
    mockAttentionItems = [];
    mockLiveItems = [];
    mockCompletedItems = [];
    mockReadyTasks = [];
    mockIsLoading = false;
    mockError = null;
  });

  describe("loading state", () => {
    it("shows loading spinner when data is loading", () => {
      mockIsLoading = true;
      render(<OperationsPage />);

      expect(screen.getByText("Loading operations...")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message and retry button", () => {
      mockError = "Failed to fetch tasks";
      render(<OperationsPage />);

      expect(screen.getByText("Failed to fetch tasks")).toBeInTheDocument();
      expect(screen.getByText("Try again")).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("shows 'All clear' when nothing is happening", () => {
      render(<OperationsPage />);

      expect(screen.getByText("All clear")).toBeInTheDocument();
      expect(
        screen.getByText("No active operations or items needing attention"),
      ).toBeInTheDocument();
    });
  });

  describe("header", () => {
    it("renders Operations heading", () => {
      render(<OperationsPage />);

      expect(
        screen.getByRole("heading", { name: "Operations" }),
      ).toBeInTheDocument();
    });

    it("shows live count badge when there are running operations", () => {
      mockLiveItems = [
        {
          task: createMockTask({ id: "t-1", title: "Task" }),
          taskRun: createMockTaskRun({
            id: "run-1",
            task_id: "t-1",
            status: "executing",
          }),
        },
      ];
      render(<OperationsPage />);

      expect(screen.getByText("1 running")).toBeInTheDocument();
    });

    it("shows attention count badge when items need attention", () => {
      mockAttentionItems = [
        {
          kind: "review_request",
          task: createMockTask({ id: "t-1", title: "Task" }),
        },
      ];
      render(<OperationsPage />);

      expect(screen.getByText("1 need attention")).toBeInTheDocument();
    });

    it("does not show live badge when no operations are running", () => {
      render(<OperationsPage />);

      expect(screen.queryByText(/running/)).not.toBeInTheDocument();
    });

    it("does not show attention badge when no items need attention", () => {
      mockReadyTasks = [createMockTask({ id: "t-1", title: "Task" })];
      render(<OperationsPage />);

      expect(screen.queryByText(/need attention/)).not.toBeInTheDocument();
    });
  });

  describe("section rendering", () => {
    it("renders NeedsAttentionSection when there is a failed TaskRun", () => {
      mockAttentionItems = [
        {
          kind: "failed_run",
          task: createMockTask({ id: "t-1", title: "Failed Task" }),
          taskRun: createMockTaskRun({
            id: "run-1",
            task_id: "t-1",
            status: "failed",
          }),
        },
      ];
      render(<OperationsPage />);

      expect(screen.getByTestId("needs-attention-section")).toBeInTheDocument();
      expect(screen.getByText("Needs Attention (1)")).toBeInTheDocument();
    });

    it("renders LiveSection when there are live operations", () => {
      mockLiveItems = [
        {
          task: createMockTask({ id: "t-1", title: "Running Task" }),
          taskRun: createMockTaskRun({
            id: "run-1",
            task_id: "t-1",
            status: "executing",
          }),
        },
      ];
      render(<OperationsPage />);

      expect(screen.getByTestId("live-section")).toBeInTheDocument();
      expect(screen.getByText("Live (1)")).toBeInTheDocument();
    });

    it("renders RecentlyCompletedSection when there are completed items", () => {
      mockCompletedItems = [
        {
          task: createMockTask({ id: "t-1", title: "Done Task" }),
          execution: createMockStepExecution({
            id: "e-1",
            task_id: "t-1",
            status: "completed",
            completed_at: "2025-01-01T12:02:00Z",
          }),
        },
      ];
      render(<OperationsPage />);

      expect(screen.getByTestId("completed-section")).toBeInTheDocument();
      expect(screen.getByText("Completed (1)")).toBeInTheDocument();
    });

    it("renders ReadySection when there are ready tasks", () => {
      mockReadyTasks = [
        createMockTask({ id: "t-1", title: "Ready Task" }),
      ];
      render(<OperationsPage />);

      expect(screen.getByTestId("ready-section")).toBeInTheDocument();
      expect(screen.getByText("Ready (1)")).toBeInTheDocument();
    });

    it("renders all sections simultaneously", () => {
      mockAttentionItems = [
        {
          kind: "review_request",
          task: createMockTask({ id: "t-1", title: "Review" }),
        },
      ];
      mockLiveItems = [
        {
          task: createMockTask({ id: "t-2", title: "Running" }),
          taskRun: createMockTaskRun({
            id: "run-2",
            task_id: "t-2",
            status: "executing",
          }),
        },
      ];
      mockCompletedItems = [
        {
          task: createMockTask({ id: "t-3", title: "Done" }),
          execution: createMockStepExecution({
            id: "e-2",
            task_id: "t-3",
            status: "completed",
            completed_at: "2025-01-01T12:00:00Z",
          }),
        },
      ];
      mockReadyTasks = [
        createMockTask({ id: "t-4", title: "Waiting" }),
      ];
      render(<OperationsPage />);

      expect(screen.getByTestId("needs-attention-section")).toBeInTheDocument();
      expect(screen.getByTestId("live-section")).toBeInTheDocument();
      expect(screen.getByTestId("completed-section")).toBeInTheDocument();
      expect(screen.getByTestId("ready-section")).toBeInTheDocument();
    });

    it("does not render empty sections", () => {
      mockLiveItems = [
        {
          task: createMockTask({ id: "t-1", title: "Running" }),
          taskRun: createMockTaskRun({
            id: "run-1",
            task_id: "t-1",
            status: "executing",
          }),
        },
      ];
      render(<OperationsPage />);

      expect(screen.getByTestId("live-section")).toBeInTheDocument();
      expect(screen.queryByTestId("needs-attention-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("completed-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ready-section")).not.toBeInTheDocument();
    });
  });

});
