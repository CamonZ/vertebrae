import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createMockTask, createMockTaskRun } from "../test/test-utils";
import type { Task } from "../bindings";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { queryClient } from "../query/queryClient";
import { queryKeys } from "../query/queryKeys";
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

vi.mock("../bindings", () => ({
  commands: {
    getTask: vi.fn(async () => ({
      status: "error",
      error: { message: "not found" },
    })),
    listTasks: vi.fn(async () => ({ status: "ok", data: [] })),
    getExecutionLogs: vi.fn(async () => ({ status: "ok", data: [] })),
    getTaskExecutions: vi.fn(async () => ({ status: "ok", data: [] })),
  },
}));

let mockTask: ReturnType<typeof createMockTask> | null = null;
let mockRuns: ReturnType<typeof createMockTaskRun>[] = [];
let mockActiveRun: ReturnType<typeof createMockTaskRun> | null = null;

vi.mock("../hooks", () => ({
  useTask: () => ({
    task: mockTask,
    isLoading: false,
    error: null,
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
    stepExecutions: [],
    logsByExecutionId: {},
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function renderAt(path: string) {
  return render(
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

function seedPickerTasks(tasks: Task[]) {
  queryClient.setQueryData(
    queryKeys.tasks.list(getProjectScopeGeneration(), null),
    tasks
  );
}

describe("TracesPage picker (empty state)", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTask = null;
    mockRuns = [];
    mockActiveRun = null;
    seedPickerTasks([
      createMockTask({ id: "abcd1234-aaaa", title: "Refactor router" }),
      createMockTask({ id: "ef567890-bbbb", title: "Add Traces nav" }),
    ]);
  });

  it("renders the TaskPicker on /traces with no taskId", () => {
    renderAt("/traces");
    expect(screen.getByTestId("traces-picker-rail")).toBeInTheDocument();
    expect(screen.getByTestId("task-picker-input")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("typing filters the list and Enter navigates to /traces/:taskId", () => {
    renderAt("/traces");
    const input = screen.getByTestId("task-picker-input");
    fireEvent.change(input, { target: { value: "router" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockNavigate).toHaveBeenCalledWith("/traces/abcd1234-aaaa");
  });

  it("clicking a result navigates to /traces/:taskId", () => {
    renderAt("/traces");
    fireEvent.click(screen.getByTestId("task-picker-option-ef567890-bbbb"));
    expect(mockNavigate).toHaveBeenCalledWith("/traces/ef567890-bbbb");
  });

  it("'/' key focuses the picker input", () => {
    renderAt("/traces");
    const input = screen.getByTestId("task-picker-input") as HTMLInputElement;
    input.blur();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(input);
  });
});

describe("TracesPage switch-task (rail swap)", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTask = createMockTask({ id: "root", title: "Root", level: "task" });
    mockRuns = [createMockTaskRun({ id: "run-1", task_id: "root" })];
    mockActiveRun = mockRuns[0];
    seedPickerTasks([
      createMockTask({ id: "root", title: "Root" }),
      createMockTask({ id: "other-task-id", title: "Other Task" }),
    ]);
  });

  it("Switch button swaps the run-history rail for the picker rail", () => {
    renderAt("/traces/root");
    expect(screen.getByTestId("run-history-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("traces-picker-rail")).toBeNull();
    fireEvent.click(screen.getByTestId("run-history-rail-switch-task"));
    expect(screen.getByTestId("traces-picker-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("run-history-rail")).toBeNull();
    expect(screen.getByTestId("task-picker-input")).toBeInTheDocument();
  });

  it("selecting a task in the rail picker navigates and restores the run rail", () => {
    renderAt("/traces/root");
    fireEvent.click(screen.getByTestId("run-history-rail-switch-task"));
    fireEvent.click(screen.getByTestId("task-picker-option-other-task-id"));
    expect(mockNavigate).toHaveBeenCalledWith("/traces/other-task-id");
    expect(screen.queryByTestId("traces-picker-rail")).toBeNull();
    expect(screen.getByTestId("run-history-rail")).toBeInTheDocument();
  });
});
