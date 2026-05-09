import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createMockTask, createMockStepExecution } from "../test/test-utils";
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

let mockTask: ReturnType<typeof createMockTask> | null = null;

vi.mock("../hooks", () => ({
  useTask: () => ({
    task: mockTask,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskRuns: () => ({
    runs: [],
    activeRun: null,
    latestRun: null,
    resolveRun: () => ({ run: null, source: "none" }),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskRunTrace: () => ({
    trace: null,
    taskRuns: [],
    executions: [],
    sessionLogs: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../hooks/useSubtreeExecutions", () => ({
  useSubtreeExecutions: () => ({
    executions: [
      createMockStepExecution({ id: "ex-1", task_id: "root" }),
    ],
    rollups: { totalRuns: 1, totalCost: 0, totalTokens: 0, totalWallTimeMs: 0 },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    subtreeTaskIds: ["root"],
    isInSubtree: vi.fn(),
  }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/traces/:taskId" element={<TracesPage />} />
        <Route path="/traces" element={<TracesPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("TracesPage picker (empty state)", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTask = null;
    useTaskStore.setState({
      tasks: [
        createMockTask({ id: "abcd1234-aaaa", title: "Refactor router" }),
        createMockTask({ id: "ef567890-bbbb", title: "Add Traces nav" }),
      ],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
  });

  it("renders the TaskPicker on /traces with no taskId", () => {
    renderAt("/traces");
    expect(screen.getByTestId("traces-picker-rail")).toBeInTheDocument();
    expect(screen.getByTestId("task-picker-input")).toBeInTheDocument();
    // Both seeded tasks should appear in the listbox.
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
    useTaskStore.setState({
      tasks: [
        createMockTask({ id: "root", title: "Root" }),
        createMockTask({ id: "other-task-id", title: "Other Task" }),
      ],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
  });

  it("Switch button swaps the subtree rail for the picker rail", () => {
    renderAt("/traces/root");
    expect(screen.getByTestId("subtree-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("traces-picker-rail")).toBeNull();
    fireEvent.click(screen.getByTestId("subtree-rail-switch-task"));
    expect(screen.getByTestId("traces-picker-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("subtree-rail")).toBeNull();
    expect(screen.getByTestId("task-picker-input")).toBeInTheDocument();
  });

  it("selecting a task in the rail picker navigates and restores the subtree rail", () => {
    renderAt("/traces/root");
    fireEvent.click(screen.getByTestId("subtree-rail-switch-task"));
    fireEvent.click(screen.getByTestId("task-picker-option-other-task-id"));
    expect(mockNavigate).toHaveBeenCalledWith("/traces/other-task-id");
    // After selection, picker rail closes (subtree rail returns) on the same /traces/root view.
    expect(screen.queryByTestId("traces-picker-rail")).toBeNull();
    expect(screen.getByTestId("subtree-rail")).toBeInTheDocument();
  });
});
