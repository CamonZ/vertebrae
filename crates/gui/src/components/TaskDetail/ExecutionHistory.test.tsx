import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExecutionHistory } from "./ExecutionHistory";
import { commands, StepExecution, SessionLog } from "../../bindings";

// Mock the bindings commands
vi.mock("../../bindings", () => ({
  commands: {
    getTaskExecutions: vi.fn(),
    getExecutionLogs: vi.fn(),
  },
}));

const mockGetTaskExecutions = vi.mocked(commands.getTaskExecutions);
const mockGetExecutionLogs = vi.mocked(commands.getExecutionLogs);

const mockExecution = (
  overrides: Partial<StepExecution> = {}
): StepExecution => ({
  id: "exec-1",
  task_id: "task-1",
  workflow_id: "workflow-1",
  step_name: "in_progress",
  status: "completed",
  started_at: "2024-01-01T10:00:00Z",
  completed_at: "2024-01-01T10:05:00Z",
  ...overrides,
});

const mockSessionLog = (
  overrides: Partial<SessionLog> = {}
): SessionLog => ({
  id: "log-1",
  step_execution_id: "exec-1",
  content: "Log content here",
  created_at: "2024-01-01T10:02:00Z",
  ...overrides,
});

describe("ExecutionHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loading state", () => {
    it("shows loading spinner while fetching executions", () => {
      mockGetTaskExecutions.mockReturnValue(new Promise(() => {}));

      render(<ExecutionHistory taskId="task-1" />);

      expect(screen.getByText("Loading history...")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("displays error message when fetch fails", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "error",
        error: { message: "Failed to load executions" },
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load executions")
        ).toBeInTheDocument();
      });
    });
  });

  describe("empty state", () => {
    it("shows empty message when no executions exist", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("No execution history")).toBeInTheDocument();
      });
    });
  });

  describe("execution timeline", () => {
    it("displays executions in descending order (newest first)", async () => {
      const executions = [
        mockExecution({
          id: "exec-1",
          step_name: "oldest",
          started_at: "2024-01-01T08:00:00Z",
        }),
        mockExecution({
          id: "exec-2",
          step_name: "newest",
          started_at: "2024-01-01T12:00:00Z",
        }),
        mockExecution({
          id: "exec-3",
          step_name: "middle",
          started_at: "2024-01-01T10:00:00Z",
        }),
      ];

      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: executions,
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("newest")).toBeInTheDocument();
      });

      const stepNames = screen.getAllByRole("heading", { level: 4 });
      expect(stepNames[0]).toHaveTextContent("newest");
      expect(stepNames[1]).toHaveTextContent("middle");
      expect(stepNames[2]).toHaveTextContent("oldest");
    });

    it("displays execution status badge", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ status: "completed" })],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("completed")).toBeInTheDocument();
      });
    });

    it("shows Active label for in_progress status", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ status: "in_progress", completed_at: null })],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("Active")).toBeInTheDocument();
      });
    });
  });

  describe("collapsible session logs", () => {
    it("shows chevron icon for expand/collapse", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution()],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("in_progress")).toBeInTheDocument();
      });

      // Find the button with chevron
      const expandButton = screen.getByRole("button");
      expect(expandButton).toBeInTheDocument();
    });

    it("fetches logs lazily when expanded", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution()],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "ok",
        data: [mockSessionLog()],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("in_progress")).toBeInTheDocument();
      });

      // Initially, logs should not be fetched
      expect(mockGetExecutionLogs).not.toHaveBeenCalled();

      // Click to expand
      const expandButton = screen.getByRole("button");
      fireEvent.click(expandButton);

      // Now logs should be fetched
      await waitFor(() => {
        expect(mockGetExecutionLogs).toHaveBeenCalledWith("exec-1");
      });
    });

    it("displays session logs when expanded", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution()],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "ok",
        data: [mockSessionLog({ content: "Session log content" })],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("in_progress")).toBeInTheDocument();
      });

      // Click to expand
      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("Session log content")).toBeInTheDocument();
      });
    });

    it("shows No session logs message when expanded but empty", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution()],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "ok",
        data: [],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("in_progress")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("No session logs")).toBeInTheDocument();
      });
    });

    it("shows loading state while fetching logs", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution()],
      });

      mockGetExecutionLogs.mockReturnValue(new Promise(() => {}));

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("in_progress")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("Loading logs...")).toBeInTheDocument();
      });
    });

    it("shows error when log fetch fails", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution()],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "error",
        error: { message: "Failed to fetch logs" },
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("in_progress")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("Failed to fetch logs")).toBeInTheDocument();
      });
    });

    it("does not refetch logs when collapsing and re-expanding", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution()],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "ok",
        data: [mockSessionLog()],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("in_progress")).toBeInTheDocument();
      });

      const button = screen.getByRole("button");

      // First expand
      fireEvent.click(button);
      await waitFor(() => {
        expect(screen.getByText("Log content here")).toBeInTheDocument();
      });
      expect(mockGetExecutionLogs).toHaveBeenCalledTimes(1);

      // Collapse
      fireEvent.click(button);

      // Re-expand - should not fetch again
      fireEvent.click(button);
      await waitFor(() => {
        expect(screen.getByText("Log content here")).toBeInTheDocument();
      });
      expect(mockGetExecutionLogs).toHaveBeenCalledTimes(1);
    });

    it("manages expand state independently for multiple executions", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [
          mockExecution({ id: "exec-1", step_name: "step-1" }),
          mockExecution({ id: "exec-2", step_name: "step-2" }),
        ],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "ok",
        data: [mockSessionLog({ content: "Log for exec-1" })],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("step-1")).toBeInTheDocument();
        expect(screen.getByText("step-2")).toBeInTheDocument();
      });

      const buttons = screen.getAllByRole("button");

      // Expand first execution
      fireEvent.click(buttons[0]);

      await waitFor(() => {
        expect(screen.getByText("Log for exec-1")).toBeInTheDocument();
      });

      // Second execution should still be collapsed (no logs visible)
      expect(mockGetExecutionLogs).toHaveBeenCalledTimes(1);
      expect(mockGetExecutionLogs).toHaveBeenCalledWith("exec-1");
    });
  });

  describe("duration formatting", () => {
    it("formats duration correctly for completed executions", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [
          mockExecution({
            started_at: "2024-01-01T10:00:00Z",
            completed_at: "2024-01-01T10:05:30Z",
          }),
        ],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("5m 30s")).toBeInTheDocument();
      });
    });

    it("shows Running... for in-progress executions", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [
          mockExecution({
            status: "in_progress",
            completed_at: null,
          }),
        ],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("Running...")).toBeInTheDocument();
      });
    });
  });
});
