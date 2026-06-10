import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fireEvent,
  screen,
  render as rtlRender,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  createMockTask,
  createMockTaskRun,
  createMockStepExecution,
} from "../test/test-utils";
import { useTaskStore } from "../stores/taskStore";
import { queryClient } from "../query/queryClient";
import { TracesPage } from "./TracesPage";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom"
    );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

/** Per-test task fixtures served by the mocked `getTask` / `listTasks`. */
const taskFixtures: Record<string, ReturnType<typeof createMockTask>> = {};

vi.mock("../bindings", () => ({
  commands: {
    getTask: vi.fn(async (id: string) =>
      taskFixtures[id]
        ? { status: "ok", data: taskFixtures[id] }
        : { status: "error", error: { message: "not found" } }
    ),
    listTasks: vi.fn(async (filter: { children_of?: string | null } | null) => {
      const all = Object.values(taskFixtures);
      const parentId = filter?.children_of ?? null;
      return {
        status: "ok",
        data: parentId ? all.filter((t) => t.parent_id === parentId) : all,
      };
    }),
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
let lastRunsTaskId: string | null = null;

vi.mock("../hooks", () => ({
  useTask: () => ({
    task: mockTask,
    isLoading: mockTaskLoading,
    error: mockTaskError,
    refetch: vi.fn(),
  }),
  useTaskRuns: (taskId: string | null) => {
    lastRunsTaskId = taskId;
    return {
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
    };
  },
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
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/traces/:taskId" element={<TracesPage />} />
          <Route path="/traces" element={<TracesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TracesPage (single-run)", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    for (const key of Object.keys(taskFixtures)) delete taskFixtures[key];
    taskFixtures["root"] = createMockTask({
      id: "root",
      title: "Root Epic",
      level: "epic",
    });
    mockTask = taskFixtures["root"];
    mockTaskLoading = false;
    mockTaskError = null;
    mockRuns = [];
    mockActiveRun = null;
    mockExecutions = [];
    lastRunsTaskId = null;
    useTaskStore.setState({
      tasks: [
        createMockTask({ id: "root", title: "Root Epic", level: "epic" }),
      ],
      activeFilter: null,
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

  it("fetches the full task list for the picker instead of relying on store residue", async () => {
    taskFixtures["other"] = createMockTask({
      id: "other",
      title: "Never-run task",
      level: "ticket",
    });
    // Store starts empty — e.g. fresh launch where only realtime events would
    // otherwise populate it.
    useTaskStore.setState({ tasks: [] });

    renderAt("/traces");

    await waitFor(() => {
      expect(
        screen.getByTestId("task-picker-option-other")
      ).toBeInTheDocument();
      expect(screen.getByTestId("task-picker-option-root")).toBeInTheDocument();
    });
  });

  describe("TASKS tree selection", () => {
    function visibleTaskRowIds(): string[] {
      return screen
        .queryAllByTestId("run-history-task-row")
        .map((el) => el.getAttribute("data-task-id") ?? "");
    }

    beforeEach(() => {
      taskFixtures["c1"] = createMockTask({
        id: "c1",
        title: "Child One",
        level: "ticket",
        parent_id: "root",
      });
      taskFixtures["c2"] = createMockTask({
        id: "c2",
        title: "Child Two",
        level: "ticket",
        parent_id: "root",
      });
    });

    it("keeps the parent and siblings visible when a child is selected", async () => {
      renderAt("/traces/root");
      await waitFor(() => {
        expect(visibleTaskRowIds()).toEqual(["root", "c1", "c2"]);
      });

      const childRow = screen
        .getAllByTestId("run-history-task-row-button")
        .find((el) => el.closest("li")?.getAttribute("data-task-id") === "c1");
      fireEvent.click(childRow!);

      await waitFor(() => {
        expect(lastRunsTaskId).toBe("c1");
      });
      // The tree stays scoped to the entry task's subtree...
      expect(visibleTaskRowIds()).toEqual(["root", "c1", "c2"]);
      // ...with the clicked child highlighted as current.
      const c1Row = screen
        .getAllByTestId("run-history-task-row")
        .find((el) => el.getAttribute("data-task-id") === "c1");
      expect(c1Row?.getAttribute("data-active")).toBe("true");
      // No navigation happened — selection lives in the `task` search param.
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it("re-selects the entry task when its row is clicked", async () => {
      renderAt("/traces/root?task=c1");
      await waitFor(() => {
        expect(lastRunsTaskId).toBe("c1");
      });

      const rootRow = screen
        .getAllByTestId("run-history-task-row-button")
        .find(
          (el) => el.closest("li")?.getAttribute("data-task-id") === "root"
        );
      fireEvent.click(rootRow!);

      await waitFor(() => {
        expect(lastRunsTaskId).toBe("root");
      });
    });
  });
});
