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
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import {
  createMockTask,
  createMockStepExecution,
  createMockTaskRun,
} from "../test/test-utils";
import { useTaskStore } from "../stores/taskStore";
import { TracesPage } from "./TracesPage";
import type { SessionLog, TaskRun } from "../bindings";

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
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
let mockTraceRuns: TaskRun[] = [];
let mockTraceLogs: SessionLog[] = [];
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
        ? (mockRuns.find((r) =>
            ["completed", "failed", "stopped"].includes(r.status)
          ) ?? null)
        : null,
    resolveRun: (id: string | null) => mockResolve(id),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskRunTrace: (rootTaskRunId: string | null) => {
    lastTraceRootId = rootTaskRunId;
    return {
      trace: rootTaskRunId ? { root_task_run_id: rootTaskRunId } : null,
      taskRuns: rootTaskRunId ? mockTraceRuns : [],
      executions: rootTaskRunId ? mockTraceExecutions : [],
      sessionLogs: rootTaskRunId ? mockTraceLogs : [],
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

function makeLog(execId: string, text = execId): SessionLog {
  return {
    id: `log-${execId}`,
    step_execution_id: execId,
    content: JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    }),
    created_at: "2026-01-01T00:00:01.000Z",
  };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/traces/:taskId" element={<TracesPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-search={location.search} />;
}

function currentSearchParams() {
  return new URLSearchParams(
    screen.getByTestId("location").getAttribute("data-search") ?? ""
  );
}

describe("TracesPage with TaskRun history", () => {
  beforeEach(() => {
    mockRuns = [];
    mockResolve = () => ({ run: null, source: "none" });
    mockTraceExecutions = [];
    mockTraceRuns = [];
    mockTraceLogs = [];
    lastTraceRootId = null;
    useTaskStore.setState({
      tasks: [
        createMockTask({ id: "root", title: "Root" }),
        createMockTask({
          id: "child",
          title: "Child",
          parent_id: "root",
        }),
        createMockTask({
          id: "sibling",
          title: "Sibling",
          parent_id: "root",
        }),
        createMockTask({
          id: "grandchild",
          title: "Grandchild",
          parent_id: "child",
        }),
      ],
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
      started_at: "2026-01-02T00:00:00.000Z",
    });
    const olderRun = makeRun({
      id: "run-old",
      status: "completed",
      root_task_run_id: "run-old",
      started_at: "2026-01-01T00:00:00.000Z",
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
      started_at: "2026-01-02T00:00:00.000Z",
    });
    const olderRun = makeRun({
      id: "run-old",
      status: "completed",
      root_task_run_id: "run-old",
      started_at: "2026-01-01T00:00:00.000Z",
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
    expect(currentSearchParams().get("runId")).toBe("run-old");
    expect(currentSearchParams().get("scope")).toBe("lineage");
  });

  it("treats a run whose parent is absent from the rail as a root selection", () => {
    const activeRun = makeRun({
      id: "run-active",
      status: "executing",
      root_task_run_id: "run-active",
      started_at: "2026-01-02T00:00:00.000Z",
    });
    const detachedRun = makeRun({
      id: "run-detached",
      status: "completed",
      parent_task_run_id: "run-missing-parent",
      root_task_run_id: "run-detached",
      started_at: "2026-01-01T00:00:00.000Z",
    });
    mockRuns = [activeRun, detachedRun];
    mockResolve = (id) => {
      if (id === "run-detached")
        return { run: detachedRun, source: "selected" };
      return { run: activeRun, source: "active" };
    };

    renderAt("/traces/root");

    fireEvent.click(screen.getAllByTestId("run-history-row-button")[1]);

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-detached");
    expect(indicator.getAttribute("data-run-source")).toBe("selected");
    expect(currentSearchParams().get("runId")).toBe("run-detached");
    expect(currentSearchParams().get("scope")).toBe("lineage");
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

  it("keeps a child run selected while fetching its root trace tree and defaults to descendants scope", () => {
    const rootRun = makeRun({
      id: "run-root",
      task_id: "root",
      status: "executing",
      root_task_run_id: "run-root",
    });
    const childRun = makeRun({
      id: "run-child",
      task_id: "child",
      status: "executing",
      parent_task_run_id: "run-root",
      root_task_run_id: "run-root",
    });
    const siblingRun = makeRun({
      id: "run-sibling",
      task_id: "sibling",
      status: "completed",
      parent_task_run_id: "run-root",
      root_task_run_id: "run-root",
    });
    const grandchildRun = makeRun({
      id: "run-grandchild",
      task_id: "grandchild",
      status: "completed",
      parent_task_run_id: "run-child",
      root_task_run_id: "run-root",
    });
    mockRuns = [childRun];
    mockTraceRuns = [rootRun, childRun, grandchildRun, siblingRun];
    mockResolve = () => ({ run: childRun, source: "active" });
    mockTraceExecutions = [
      createMockStepExecution({
        id: "exec-root",
        task_id: "root",
        task_run_id: "run-root",
      }),
      createMockStepExecution({
        id: "exec-child",
        task_id: "child",
        task_run_id: "run-child",
      }),
      createMockStepExecution({
        id: "exec-grandchild",
        task_id: "grandchild",
        task_run_id: "run-grandchild",
      }),
      createMockStepExecution({
        id: "exec-sibling",
        task_id: "sibling",
        task_run_id: "run-sibling",
      }),
    ];
    mockTraceLogs = mockTraceExecutions.map((exec) => makeLog(exec.id!));

    renderAt("/traces/child");

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-child");
    expect(lastTraceRootId).toBe("run-root");
    expect(screen.queryByTestId("trace-filter-lineage-scope")).toBeNull();

    const segments = screen
      .queryAllByTestId("unified-chat-event")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(segments)).toEqual(
      new Set(["exec-child", "exec-grandchild"])
    );

    const railRows = screen
      .getAllByTestId("run-history-row")
      .map((el) => [
        el.getAttribute("data-run-id"),
        el.getAttribute("data-depth"),
      ]);
    expect(railRows).toEqual([
      ["run-root", "0"],
      ["run-child", "1"],
      ["run-grandchild", "2"],
      ["run-sibling", "1"],
    ]);
  });

  it("uses runId to select a child run under a parent root", () => {
    const rootRun = makeRun({
      id: "run-root",
      task_id: "root",
      status: "completed",
      root_task_run_id: "run-root",
    });
    const childRun = makeRun({
      id: "run-child",
      task_id: "child",
      status: "completed",
      parent_task_run_id: "run-root",
      root_task_run_id: "run-root",
    });
    mockRuns = [rootRun, childRun];
    mockTraceRuns = [rootRun, childRun];
    mockResolve = (id) =>
      id === "run-child"
        ? { run: childRun, source: "selected" }
        : { run: rootRun, source: "latest" };
    mockTraceExecutions = [
      createMockStepExecution({
        id: "exec-root",
        task_id: "root",
        task_run_id: "run-root",
      }),
      createMockStepExecution({
        id: "exec-child",
        task_id: "child",
        task_run_id: "run-child",
      }),
    ];
    mockTraceLogs = mockTraceExecutions.map((exec) => makeLog(exec.id!));

    renderAt("/traces/root?runId=run-child");

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-child");
    expect(indicator.getAttribute("data-run-source")).toBe("selected");
    expect(currentSearchParams().get("runId")).toBe("run-child");
    expect(currentSearchParams().has("scope")).toBe(false);
    expect(lastTraceRootId).toBe("run-root");
    const segments = screen
      .queryAllByTestId("unified-chat-event")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(segments)).toEqual(new Set(["exec-child"]));
  });

  it("clicking a child run from the trace rail scopes THREAD and flight strip to that child", () => {
    const rootRun = makeRun({
      id: "run-root",
      task_id: "root",
      status: "completed",
      root_task_run_id: "run-root",
    });
    const childRun = makeRun({
      id: "run-child",
      task_id: "child",
      status: "completed",
      parent_task_run_id: "run-root",
      root_task_run_id: "run-root",
    });
    const siblingRun = makeRun({
      id: "run-sibling",
      task_id: "sibling",
      status: "completed",
      parent_task_run_id: "run-root",
      root_task_run_id: "run-root",
    });
    mockRuns = [rootRun];
    mockTraceRuns = [rootRun, childRun, siblingRun];
    mockResolve = () => ({ run: rootRun, source: "latest" });
    mockTraceExecutions = [
      createMockStepExecution({
        id: "exec-root",
        task_id: "root",
        task_run_id: "run-root",
      }),
      createMockStepExecution({
        id: "exec-child",
        task_id: "child",
        task_run_id: "run-child",
      }),
      createMockStepExecution({
        id: "exec-sibling",
        task_id: "sibling",
        task_run_id: "run-sibling",
      }),
    ];
    mockTraceLogs = mockTraceExecutions.map((exec) => makeLog(exec.id!));

    renderAt("/traces/root?scope=lineage");

    fireEvent.click(screen.getAllByTestId("run-history-row-button")[1]);

    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-id")).toBe("run-child");
    expect(indicator.getAttribute("data-run-source")).toBe("selected");
    expect(currentSearchParams().get("runId")).toBe("run-child");
    expect(currentSearchParams().has("scope")).toBe(false);

    const rowState = screen.getAllByTestId("run-history-row").map((row) => ({
      id: row.getAttribute("data-run-id"),
      active: row.getAttribute("data-active"),
      source: row.getAttribute("data-active-source"),
    }));
    expect(rowState).toEqual([
      { id: "run-root", active: "false", source: null },
      { id: "run-child", active: "true", source: "selected" },
      { id: "run-sibling", active: "false", source: null },
    ]);

    const threadSegments = screen
      .queryAllByTestId("unified-chat-event")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(threadSegments)).toEqual(new Set(["exec-child"]));

    const markers = screen
      .queryAllByTestId("flight-strip-marker-main")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(markers)).toEqual(new Set(["exec-child"]));
  });

  it("uses the root run row to restore THREAD, flight strip, and corridor context", () => {
    const rootRun = makeRun({
      id: "run-root",
      task_id: "root",
      status: "executing",
      root_task_run_id: "run-root",
    });
    const childRun = makeRun({
      id: "run-child",
      task_id: "child",
      status: "executing",
      parent_task_run_id: "run-root",
      root_task_run_id: "run-root",
    });
    const grandchildRun = makeRun({
      id: "run-grandchild",
      task_id: "grandchild",
      status: "completed",
      parent_task_run_id: "run-child",
      root_task_run_id: "run-root",
    });
    const siblingRun = makeRun({
      id: "run-sibling",
      task_id: "sibling",
      status: "completed",
      parent_task_run_id: "run-root",
      root_task_run_id: "run-root",
    });
    mockRuns = [childRun];
    mockTraceRuns = [rootRun, childRun, grandchildRun, siblingRun];
    mockResolve = () => ({ run: childRun, source: "active" });
    mockTraceExecutions = [
      createMockStepExecution({
        id: "exec-root",
        task_id: "root",
        task_run_id: "run-root",
      }),
      createMockStepExecution({
        id: "exec-child",
        task_id: "child",
        task_run_id: "run-child",
      }),
      createMockStepExecution({
        id: "exec-grandchild",
        task_id: "grandchild",
        task_run_id: "run-grandchild",
      }),
      createMockStepExecution({
        id: "exec-sibling",
        task_id: "sibling",
        task_run_id: "run-sibling",
      }),
    ];
    mockTraceLogs = mockTraceExecutions.map((exec) => makeLog(exec.id!));

    renderAt("/traces/child");

    const threadSegments = screen
      .queryAllByTestId("unified-chat-event")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(threadSegments)).toEqual(
      new Set(["exec-child", "exec-grandchild"])
    );
    const markers = screen
      .queryAllByTestId("flight-strip-marker-main")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(markers)).toEqual(
      new Set(["exec-child", "exec-grandchild"])
    );

    fireEvent.click(screen.getByTestId("trace-mode-option-corridor"));
    let nodes = screen
      .queryAllByTestId("corridor-node")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(nodes)).toEqual(new Set(["exec-child", "exec-grandchild"]));

    const runRows = screen.getAllByTestId("run-history-row");
    expect(runRows[0].getAttribute("data-run-id")).toBe("run-root");
    fireEvent.click(screen.getAllByTestId("run-history-row-button")[0]);
    expect(currentSearchParams().get("runId")).toBe("run-root");
    expect(currentSearchParams().get("scope")).toBe("lineage");
    nodes = screen
      .queryAllByTestId("corridor-node")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(nodes)).toEqual(
      new Set(["exec-root", "exec-child", "exec-grandchild", "exec-sibling"])
    );
  });
});
