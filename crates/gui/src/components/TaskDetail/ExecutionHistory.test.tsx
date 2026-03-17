import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExecutionHistory } from "./ExecutionHistory";
import { commands, StepExecution, SessionLog } from "../../bindings";
import { useSessionLogStore } from "../../stores";

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

// Helper to create JSON log content that ConversationLogViewer can parse
const createThinkingLog = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  });

const mockSessionLog = (
  overrides: Partial<SessionLog> = {}
): SessionLog => ({
  id: "log-1",
  step_execution_id: "exec-1",
  content: createThinkingLog("Log content here"),
  created_at: "2024-01-01T10:02:00Z",
  ...overrides,
});

describe("ExecutionHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionLogStore.setState({ logsByExecutionId: {} });
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

  describe("in_progress execution auto-expand", () => {
    it("renders expanded by default when status is in_progress", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [
          mockExecution({ status: "in_progress", completed_at: null }),
        ],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("Active")).toBeInTheDocument();
      });

      // The chevron should have rotate-90 class (expanded state)
      const chevron = document.querySelector("svg[aria-hidden='true']");
      expect(chevron?.getAttribute("class")).toContain("rotate-90");
    });

    it("shows logs from the store for an in_progress execution", async () => {
      useSessionLogStore.setState({
        logsByExecutionId: {
          "exec-1": [
            mockSessionLog({
              content: createThinkingLog("Streaming log content"),
            }),
          ],
        },
      });

      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [
          mockExecution({
            id: "exec-1",
            status: "in_progress",
            completed_at: null,
          }),
        ],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(
          screen.getByText("Streaming log content")
        ).toBeInTheDocument();
      });
    });
  });

  describe("completed execution expand", () => {
    it("renders collapsed by default when status is completed", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ status: "completed" })],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("completed")).toBeInTheDocument();
      });

      // The chevron should NOT have rotate-90 class (collapsed state)
      const chevron = document.querySelector("svg[aria-hidden='true']");
      expect(chevron?.getAttribute("class")).not.toContain("rotate-90");
    });

    it("triggers getExecutionLogs and populates the store when expanding a completed execution", async () => {
      const fetchedLogs = [
        mockSessionLog({
          id: "log-1",
          content: createThinkingLog("Historical log"),
          created_at: "2024-01-01T10:01:00Z",
        }),
        mockSessionLog({
          id: "log-2",
          content: createThinkingLog("Older log"),
          created_at: "2024-01-01T10:00:00Z",
        }),
      ];

      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ id: "exec-1", status: "completed" })],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "ok",
        data: fetchedLogs,
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("completed")).toBeInTheDocument();
      });

      // Initially, logs should not be fetched
      expect(mockGetExecutionLogs).not.toHaveBeenCalled();

      // Click to expand
      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(mockGetExecutionLogs).toHaveBeenCalledWith("exec-1");
      });

      // Verify logs were stored in ascending order
      const storeState = useSessionLogStore.getState();
      expect(storeState.logsByExecutionId["exec-1"]).toHaveLength(2);
      expect(storeState.logsByExecutionId["exec-1"][0].id).toBe("log-2");
      expect(storeState.logsByExecutionId["exec-1"][1].id).toBe("log-1");
    });

    it("does NOT re-fetch when re-expanding a completed execution that already has logs in the store", async () => {
      useSessionLogStore.setState({
        logsByExecutionId: {
          "exec-1": [
            mockSessionLog({
              content: createThinkingLog("Already fetched log"),
            }),
          ],
        },
      });

      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ id: "exec-1", status: "completed" })],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("completed")).toBeInTheDocument();
      });

      const button = screen.getByRole("button");

      // Expand
      fireEvent.click(button);

      await waitFor(() => {
        expect(
          screen.getByText("Already fetched log")
        ).toBeInTheDocument();
      });

      // Should NOT have called getExecutionLogs since store already has data
      expect(mockGetExecutionLogs).not.toHaveBeenCalled();

      // Collapse and re-expand
      fireEvent.click(button);
      fireEvent.click(button);

      await waitFor(() => {
        expect(
          screen.getByText("Already fetched log")
        ).toBeInTheDocument();
      });

      // Still should not have fetched
      expect(mockGetExecutionLogs).not.toHaveBeenCalled();
    });
  });

  describe("fetch error handling", () => {
    it("shows error message when log fetch fails", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ id: "exec-1", status: "completed" })],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "error",
        error: { message: "Failed to fetch logs" },
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("completed")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("Failed to fetch logs")).toBeInTheDocument();
      });
    });
  });

  describe("null id handling", () => {
    it("does not attempt fetch when execution has null id", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ id: null, status: "completed" })],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("completed")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button"));

      // Give time for any async operation
      await waitFor(() => {
        expect(mockGetExecutionLogs).not.toHaveBeenCalled();
      });
    });
  });

  describe("loading state for logs", () => {
    it("shows loading spinner while fetching logs", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ status: "completed" })],
      });

      mockGetExecutionLogs.mockReturnValue(new Promise(() => {}));

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("completed")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("Loading logs...")).toBeInTheDocument();
      });
    });

    it("shows No session logs for completed execution with empty results", async () => {
      mockGetTaskExecutions.mockResolvedValue({
        status: "ok",
        data: [mockExecution({ id: "exec-1", status: "completed" })],
      });

      mockGetExecutionLogs.mockResolvedValue({
        status: "ok",
        data: [],
      });

      render(<ExecutionHistory taskId="task-1" />);

      await waitFor(() => {
        expect(screen.getByText("completed")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("No session logs")).toBeInTheDocument();
      });
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
