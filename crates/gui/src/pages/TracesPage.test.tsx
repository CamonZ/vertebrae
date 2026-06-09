import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, render as rtlRender } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  createMockTask,
  createMockTaskRun,
  createMockStepExecution,
} from "../test/test-utils";
import { useTaskStore } from "../stores/taskStore";
import { TracesPage } from "./TracesPage";

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

vi.mock("../bindings", () => ({
  commands: {
    getTask: vi.fn(async () => ({
      status: "error",
      error: { message: "not found" },
    })),
    listTasks: vi.fn(async () => ({ status: "ok", data: [] })),
    getExecutionLogs: vi.fn(async () => ({ status: "ok", data: [] })),
    getTaskExecutions: vi.fn(async () => ({ status: "ok", data: [] })),
    stopRun: vi.fn(async () => ({ status: "ok", data: null })),
  },
}));

let mockTask: ReturnType<typeof createMockTask> | null = null;
let mockTaskLoading = false;
let mockTaskError: string | null = null;
let mockRuns: ReturnType<typeof createMockTaskRun>[] = [];
let mockActiveRun: ReturnType<typeof createMockTaskRun> | null = null;
let mockExecutions: ReturnType<typeof createMockStepExecution>[] = [];

vi.mock("../hooks", () => ({
  useTask: () => ({
    task: mockTask,
    isLoading: mockTaskLoading,
    error: mockTaskError,
    refetch: vi.fn(),
  }),
  useTaskRuns: () => ({
    runs: mockRuns,
    activeRun: mockActiveRun,
    latestRun: null,
    resolveRun: () =>
      mockActiveRun
        ? { run: mockActiveRun, source: "active" as const }
        : { run: null, source: "none" as const },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRunTrace: () => ({
    stepExecutions: mockExecutions,
    logsByExecutionId: {},
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function renderAt(path: string) {
  return rtlRender(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/traces/:taskId" element={<TracesPage />} />
        <Route path="/traces" element={<TracesPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("TracesPage (single-run)", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTask = createMockTask({ id: "root", title: "Root Epic", level: "epic" });
    mockTaskLoading = false;
    mockTaskError = null;
    mockRuns = [];
    mockActiveRun = null;
    mockExecutions = [];
    useTaskStore.setState({
      tasks: [createMockTask({ id: "root", title: "Root Epic", level: "epic" })],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
  });

  it("renders the header with the task title", () => {
    renderAt("/traces/root");
    expect(screen.getByTestId("traces-title").textContent).toBe("Root Epic");
  });

  it("renders the run-history rail when the task has runs", () => {
    mockRuns = [createMockTaskRun({ id: "run-1", task_id: "root" })];
    mockActiveRun = mockRuns[0];
    renderAt("/traces/root");
    expect(screen.getByTestId("run-history-rail")).toBeInTheDocument();
  });

  it("renders the empty stream when the run has no executions", () => {
    mockRuns = [createMockTaskRun({ id: "run-1", task_id: "root" })];
    mockActiveRun = mockRuns[0];
    renderAt("/traces/root");
    expect(screen.getByTestId("unified-chat-empty")).toBeInTheDocument();
  });

  it("renders the FlightStrip when the run has threads", () => {
    mockRuns = [createMockTaskRun({ id: "run-1", task_id: "root" })];
    mockActiveRun = mockRuns[0];
    mockExecutions = [
      createMockStepExecution({
        id: "ex-1",
        task_id: "root",
        task_run_id: "run-1",
        status: "completed",
        step_name: "in_progress",
        step_type: "execute",
      }),
    ];
    renderAt("/traces/root");
    expect(screen.getByTestId("flight-strip")).toBeInTheDocument();
  });

  it("does not render any mode toggle (single trace surface)", () => {
    renderAt("/traces/root");
    expect(screen.queryByTestId("trace-mode-toggle")).toBeNull();
  });

  it("navigates back when the back button is clicked", () => {
    renderAt("/traces/root");
    fireEvent.click(screen.getByTestId("traces-back-button"));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it("renders the picker rail and no-task hint when no taskId is provided", () => {
    renderAt("/traces");
    expect(screen.getByTestId("traces-page")).toBeInTheDocument();
    expect(screen.getByTestId("traces-picker-rail")).toBeInTheDocument();
    expect(screen.getByTestId("traces-no-task-hint")).toBeInTheDocument();
  });
});
