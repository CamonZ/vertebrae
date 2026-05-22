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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import {
  createMockTask,
  createMockStepExecution,
  createMockTaskRun,
} from "../test/test-utils";
import { useTaskStore } from "../stores/taskStore";
import { useSessionLogStore } from "../stores/sessionLogStore";
import { TracesPage } from "./TracesPage";
import type { SessionLog, Task, TaskRun } from "../bindings";

const bindingMocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  listTasks: vi.fn(),
  stopRun: vi.fn(),
}));

vi.mock("../bindings", async () => {
  const actual =
    await vi.importActual<typeof import("../bindings")>("../bindings");
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getTask: bindingMocks.getTask,
      listTasks: bindingMocks.listTasks,
      stopRun: bindingMocks.stopRun,
    },
  };
});

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
let mockRailRuns: TaskRun[] | null = null;
let mockResolve: (selectedRunId: string | null) => {
  run: TaskRun | null;
  source: "active" | "latest" | "selected" | "none";
} = () => ({ run: null, source: "none" });

let mockTraceExecutions: ReturnType<typeof createMockStepExecution>[] = [];
let mockTraceRuns: TaskRun[] = [];
let mockTraceLogs: SessionLog[] = [];
let lastTraceRootId: string | null = null;

vi.mock("../hooks", async () => {
  const { useSessionLogStore } = await vi.importActual<
    typeof import("../stores/sessionLogStore")
  >("../stores/sessionLogStore");

  return {
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
    useTaskRunsForTasks: () => ({
      runs: mockRailRuns ?? mockRuns,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
    useTaskRunTrace: (rootTaskRunId: string | null) => {
      lastTraceRootId = rootTaskRunId;
      const liveBuckets = useSessionLogStore(
        (state) => state.logsByExecutionId
      );
      const executionIds = new Set(
        mockTraceExecutions
          .map((execution) => execution.id)
          .filter((id): id is string => !!id)
      );
      const liveLogs = Array.from(executionIds).flatMap(
        (executionId) => liveBuckets[executionId] ?? []
      );
      return {
        trace: rootTaskRunId ? { root_task_run_id: rootTaskRunId } : null,
        taskRuns: rootTaskRunId ? mockTraceRuns : [],
        executions: rootTaskRunId ? mockTraceExecutions : [],
        sessionLogs: rootTaskRunId ? [...mockTraceLogs, ...liveLogs] : [],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      };
    },
  };
});

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
    mockRailRuns = null;
    mockResolve = () => ({ run: null, source: "none" });
    mockTraceExecutions = [];
    mockTraceRuns = [];
    mockTraceLogs = [];
    lastTraceRootId = null;
    bindingMocks.getTask.mockResolvedValue({
      status: "ok",
      data: createMockTask({ id: "root", title: "Root", level: "epic" }),
    });
    bindingMocks.listTasks.mockResolvedValue({ status: "ok", data: [] });
    bindingMocks.stopRun.mockResolvedValue({ status: "ok", data: null });
    useSessionLogStore.setState({ logsByExecutionId: {} });
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

  it("clicking a run in the rail updates the runId URL parameter", async () => {
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

    await waitFor(() =>
      expect(screen.getByTestId("traces-active-run")).toHaveAttribute(
        "data-run-id",
        "run-old"
      )
    );
    const indicator = screen.getByTestId("traces-active-run");
    expect(indicator.getAttribute("data-run-source")).toBe("selected");
    expect(currentSearchParams().get("runId")).toBe("run-old");
    expect(currentSearchParams().get("scope")).toBe("lineage");
  });

  it("shows every durable run for the current task even when the selected trace lineage has one run", () => {
    const latestRun = makeRun({
      id: "run-latest",
      status: "completed",
      root_task_run_id: "run-latest",
      started_at: "2026-01-03T00:00:00.000Z",
    });
    const stoppedRun = makeRun({
      id: "run-stopped",
      status: "stopped",
      root_task_run_id: "run-stopped",
      started_at: "2026-01-02T00:00:00.000Z",
    });
    const olderRun = makeRun({
      id: "run-older",
      status: "completed",
      root_task_run_id: "run-older",
      started_at: "2026-01-01T00:00:00.000Z",
    });
    mockRuns = [latestRun, stoppedRun, olderRun];
    mockTraceRuns = [latestRun];
    mockResolve = () => ({ run: latestRun, source: "latest" });
    mockTraceExecutions = [
      createMockStepExecution({
        id: "trace-ex-latest",
        task_id: "root",
        task_run_id: "run-latest",
      }),
    ];

    renderAt("/traces/root");

    expect(lastTraceRootId).toBe("run-latest");
    expect(
      screen
        .getAllByTestId("run-history-row")
        .map((row) => row.getAttribute("data-run-id"))
    ).toEqual(["run-latest", "run-stopped", "run-older"]);
  });

  it("loads child tasks for the rail when they are not already in the task store", async () => {
    const rootTask = createMockTask({
      id: "root",
      title: "Root",
      level: "ticket",
    });
    const childTask = createMockTask({
      id: "child",
      title: "Child",
      level: "task",
      parent_id: "root",
    });
    const rootRun = makeRun({
      id: "run-root",
      task_id: "root",
      status: "completed",
    });
    const childRun = makeRun({
      id: "run-child",
      task_id: "child",
      status: "completed",
    });
    mockRuns = [rootRun];
    mockRailRuns = [childRun];
    mockResolve = () => ({ run: rootRun, source: "latest" });
    bindingMocks.getTask.mockResolvedValue({ status: "ok", data: rootTask });
    bindingMocks.listTasks.mockImplementation(
      async (filter: { children_of: string | null }) => ({
        status: "ok" as const,
        data: filter.children_of === "root" ? [childTask] : ([] as Task[]),
      })
    );
    useTaskStore.setState({
      tasks: [rootTask],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });

    renderAt("/traces/root");

    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("run-history-task-group")
          .map((group) => group.getAttribute("data-task-id"))
      ).toEqual(["root", "child"]);
    });
    expect(bindingMocks.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ children_of: "root" })
    );
  });

  it("treats a run whose parent is absent from the rail as a root selection", async () => {
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

    await waitFor(() =>
      expect(screen.getByTestId("traces-active-run")).toHaveAttribute(
        "data-run-id",
        "run-detached"
      )
    );
    const indicator = screen.getByTestId("traces-active-run");
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

  it("keeps a child run selected while fetching that specific run trace", () => {
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
    expect(lastTraceRootId).toBe("run-child");
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
    expect(railRows).toEqual([["run-child", "2"]]);
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
    expect(lastTraceRootId).toBe("run-child");
    const segments = screen
      .queryAllByTestId("unified-chat-event")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(segments)).toEqual(new Set(["exec-child"]));
  });

  it("live-tails TaskRun trace session logs without navigation", () => {
    const activeRun = makeRun({
      id: "run-active",
      status: "executing",
      root_task_run_id: "run-active",
    });
    mockRuns = [activeRun];
    mockTraceRuns = [activeRun];
    mockResolve = () => ({ run: activeRun, source: "active" });
    mockTraceExecutions = [
      createMockStepExecution({
        id: "trace-ex-1",
        task_id: "root",
        task_run_id: "run-active",
      }),
    ];
    mockTraceLogs = [makeLog("trace-ex-1", "initial trace log")];

    renderAt("/traces/root?runId=run-active#exec=trace-ex-1");

    expect(screen.getByText(/initial trace log/)).toBeTruthy();
    expect(screen.queryByText(/live trace log/)).toBeNull();

    act(() => {
      useSessionLogStore.getState().appendLog("trace-ex-1", {
        ...makeLog("trace-ex-1", "live trace log"),
        id: "log-trace-ex-1-live",
      });
    });

    expect(screen.getByText(/live trace log/)).toBeTruthy();
    expect(currentSearchParams().get("runId")).toBe("run-active");
    const active = document.querySelector('[data-active="1"]');
    expect(active?.getAttribute("data-segment-execution-id")).toBe(
      "trace-ex-1"
    );
  });

  it("renders a newly started TaskRun trace step and log while the view stays mounted", () => {
    const activeRun = makeRun({
      id: "run-active",
      status: "executing",
      root_task_run_id: "run-active",
      latest_step_execution_id: "trace-ex-1",
    });
    mockRuns = [activeRun];
    mockTraceRuns = [activeRun];
    mockResolve = () => ({ run: activeRun, source: "active" });
    mockTraceExecutions = [
      createMockStepExecution({
        id: "trace-ex-1",
        task_id: "root",
        task_run_id: "run-active",
        step_name: "execute",
      }),
    ];
    mockTraceLogs = [makeLog("trace-ex-1", "initial trace log")];

    renderAt("/traces/root?runId=run-active");

    expect(screen.getByText(/initial trace log/)).toBeTruthy();
    expect(screen.queryByText(/second step log/)).toBeNull();

    act(() => {
      mockTraceRuns = [
        {
          ...activeRun,
          latest_step_execution_id: "trace-ex-2",
        },
      ];
      mockTraceExecutions = [
        ...mockTraceExecutions,
        createMockStepExecution({
          id: "trace-ex-2",
          task_id: "root",
          task_run_id: "run-active",
          step_name: "evaluate",
        }),
      ];
      useSessionLogStore
        .getState()
        .appendLog("trace-ex-2", makeLog("trace-ex-2", "second step log"));
    });

    expect(screen.getByText(/second step log/)).toBeTruthy();
    expect(currentSearchParams().get("runId")).toBe("run-active");
    const segments = screen
      .queryAllByTestId("unified-chat-event")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(segments).toContain("trace-ex-1");
    expect(segments).toContain("trace-ex-2");
  });

  it("clicking a child run from the trace rail scopes THREAD and flight strip to that child", async () => {
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
    mockRailRuns = [rootRun, childRun, siblingRun];
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

    await waitFor(() =>
      expect(screen.getByTestId("traces-active-run")).toHaveAttribute(
        "data-run-id",
        "run-child"
      )
    );
    const indicator = screen.getByTestId("traces-active-run");
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
    mockRailRuns = [rootRun, childRun, grandchildRun, siblingRun];
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
