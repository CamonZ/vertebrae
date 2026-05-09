/**
 * Coverage for the TaskRun-aware traces page:
 *   - /traces/:taskId resolves to active run when one exists
 *   - falls back to the latest terminal run when no active run is present
 *   - selectedRunId in the URL takes precedence
 *   - rootRunId pins the trace tree even when a newer active run exists
 *   - selecting a run from the rail updates the URL
 *   - tasks with no TaskRun history fall back to the legacy SubtreeRail
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  createMockTask,
  createMockStepExecution,
  createMockTaskRun,
} from "../test/test-utils";
import { useTaskStore } from "../stores/taskStore";
import { TracesPage } from "./TracesPage";
import type { TaskRun } from "../bindings";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom"
  );
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

let mockRuns: TaskRun[] = [];
let mockResolve: (selectedRunId: string | null) => {
  run: TaskRun | null;
  source: "active" | "latest" | "selected" | "none";
} = () => ({ run: null, source: "none" });

let mockTraceExecutions: ReturnType<typeof createMockStepExecution>[] = [];
let lastTraceRootId: string | null = null;

vi.mock("../hooks", () => ({
  useTask: () => ({
    task: createMockTask({ id: "root", title: "Root", level: "epic" }),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskRuns: () => ({
    runs: mockRuns,
    activeRun: mockRuns.find((r) => r.status === "executing") ?? null,
    latestRun:
      mockRuns.find((r) => r.status === "executing") == null
        ? mockRuns.find((r) =>
            ["completed", "failed", "stopped"].includes(r.status)
          ) ?? null
        : null,
    resolveRun: (id: string | null) => mockResolve(id),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskRunTrace: (rootTaskRunId: string | null) => {
    lastTraceRootId = rootTaskRunId;
    return {
      trace: rootTaskRunId
        ? { root_task_run_id: rootTaskRunId }
        : null,
      taskRuns: [],
      executions: rootTaskRunId ? mockTraceExecutions : [],
      sessionLogs: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

const subtreeExecutions = [
  createMockStepExecution({ id: "subtree-ex-1", task_id: "root" }),
];

vi.mock("../hooks/useSubtreeExecutions", () => ({
  useSubtreeExecutions: () => ({
    executions: subtreeExecutions,
    rollups: {
      totalRuns: subtreeExecutions.length,
      totalAttempts: subtreeExecutions.length,
      totalCost: 0,
      totalTokens: 0,
      totalWallTimeMs: 0,
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    subtreeTaskIds: ["root"],
    isInSubtree: vi.fn(),
  }),
}));

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return createMockTaskRun({
    task_id: "root",
    started_at: "2026-01-01T00:00:00.000Z",
    inserted_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/traces/:taskId" element={<TracesPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("TracesPage with TaskRun history", () => {
  beforeEach(() => {
    mockRuns = [];
    mockResolve = () => ({ run: null, source: "none" });
    mockTraceExecutions = [];
    lastTraceRootId = null;
    useTaskStore.setState({
      tasks: [createMockTask({ id: "root", title: "Root" })],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
  });

  it("opens the active run by default for /traces/:taskId", () => {
    const activeRun = makeRun({
      id: "run-active",
      status: "executing",
      root_task_run_id: "run-active",
    });
    mockRuns = [activeRun];
    mockResolve = () => ({ run: activeRun, source: "active" });
    mockTraceExecutions = [
      createMockStepExecution({ id: "trace-ex-1", task_id: "root" }),
    ];

    renderAt("/traces/root");

    expect(screen.getByTestId("run-history-rail")).toBeTruthy();
    expect(screen.queryByTestId("subtree-rail")).toBeNull();

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-active");
    expect(indicator.getAttribute("data-run-source")).toBe("active");
    expect(lastTraceRootId).toBe("run-active");
  });

  it("falls back to the latest terminal run when no active run exists", () => {
    const completed = makeRun({
      id: "run-done",
      status: "completed",
      root_task_run_id: "run-done",
    });
    mockRuns = [completed];
    mockResolve = () => ({ run: completed, source: "latest" });

    renderAt("/traces/root");

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-done");
    expect(indicator.getAttribute("data-run-source")).toBe("latest");
    expect(lastTraceRootId).toBe("run-done");
  });

  it("uses runId from the URL to select an explicit run", () => {
    const activeRun = makeRun({
      id: "run-active",
      status: "executing",
      root_task_run_id: "run-active",
    });
    const olderRun = makeRun({
      id: "run-old",
      status: "completed",
      root_task_run_id: "run-old",
    });
    mockRuns = [activeRun, olderRun];
    mockResolve = (id) => {
      if (id === "run-old") {
        return { run: olderRun, source: "selected" };
      }
      return { run: activeRun, source: "active" };
    };

    renderAt("/traces/root?runId=run-old");

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-old");
    expect(indicator.getAttribute("data-run-source")).toBe("selected");
    expect(lastTraceRootId).toBe("run-old");
  });

  it("rootRunId pins the trace tree even when a newer active run exists", () => {
    const activeRun = makeRun({
      id: "run-active",
      status: "executing",
      root_task_run_id: "run-active",
    });
    const pinned = makeRun({
      id: "run-pinned",
      status: "completed",
      root_task_run_id: "run-pinned",
    });
    mockRuns = [activeRun, pinned];
    mockResolve = () => ({ run: activeRun, source: "active" });

    renderAt("/traces/root?rootRunId=run-pinned");

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-pinned");
    expect(indicator.getAttribute("data-run-source")).toBe("selected");
    expect(lastTraceRootId).toBe("run-pinned");
  });

  it("clicking a run in the rail updates the runId URL parameter", () => {
    const activeRun = makeRun({
      id: "run-active",
      status: "executing",
      root_task_run_id: "run-active",
    });
    const olderRun = makeRun({
      id: "run-old",
      status: "completed",
      root_task_run_id: "run-old",
    });
    mockRuns = [activeRun, olderRun];
    mockResolve = (id) => {
      if (id === "run-old") return { run: olderRun, source: "selected" };
      return { run: activeRun, source: "active" };
    };

    renderAt("/traces/root");

    const rows = screen.getAllByTestId("run-history-row-button");
    // Older run should be the second one (newest first).
    fireEvent.click(rows[1]);

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-old");
    expect(indicator.getAttribute("data-run-source")).toBe("selected");
  });

  it("falls back to the legacy SubtreeRail when the task has no runs", () => {
    mockRuns = [];
    mockResolve = () => ({ run: null, source: "none" });

    renderAt("/traces/root");

    expect(screen.getByTestId("subtree-rail")).toBeTruthy();
    expect(screen.queryByTestId("run-history-rail")).toBeNull();
    expect(screen.queryByTestId("traces-active-run")).toBeNull();
    expect(lastTraceRootId).toBeNull();
  });
});
