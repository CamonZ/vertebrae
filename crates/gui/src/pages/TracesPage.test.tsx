import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render as rtlRender } from "@testing-library/react";
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
let mockTaskLoading = false;
let mockTaskError: string | null = null;

vi.mock("../hooks", () => ({
  useTask: () => ({
    task: mockTask,
    isLoading: mockTaskLoading,
    error: mockTaskError,
    refetch: vi.fn(),
  }),
}));

const subtreeRollups = {
  totalRuns: 4,
  totalCost: 0.42,
  totalTokens: 8000,
  totalWallTimeMs: 30000,
};

const subtreeExecutions = [
  createMockStepExecution({
    id: "ex-1",
    task_id: "root",
    status: "completed",
    step_name: "in_progress",
    cost: 0.2,
    duration_ms: 10000,
  }),
  createMockStepExecution({
    id: "ex-2",
    task_id: "child",
    status: "failed",
    step_name: "in_progress",
    cost: 0.22,
    duration_ms: 20000,
  }),
];

vi.mock("../hooks/useSubtreeExecutions", () => ({
  useSubtreeExecutions: () => ({
    executions: subtreeExecutions,
    rollups: subtreeRollups,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    subtreeTaskIds: ["root", "child"],
    isInSubtree: vi.fn(),
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

describe("TracesPage", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTask = createMockTask({
      id: "root",
      title: "Root Epic",
      level: "epic",
    });
    mockTaskLoading = false;
    mockTaskError = null;
    useTaskStore.setState({
      tasks: [
        createMockTask({ id: "root", title: "Root Epic", level: "epic" }),
        createMockTask({
          id: "child",
          title: "Child Ticket",
          level: "ticket",
          parent_id: "root",
        }),
      ],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
  });

  it("renders header with task title and subtree rollup", () => {
    renderAt("/traces/root");
    expect(screen.getByTestId("traces-title").textContent).toBe("Root Epic");
    expect(screen.getByTestId("traces-rollup-runs").textContent).toMatch(/4/);
    expect(screen.getByTestId("traces-rollup-cost").textContent).toMatch(
      /\$0\.42/
    );
  });

  it("renders the subtree rail with depth-ordered groups", () => {
    renderAt("/traces/root");
    const groups = screen.getAllByTestId("subtree-rail-group");
    expect(groups.map((g) => g.getAttribute("data-task-id"))).toEqual([
      "root",
      "child",
    ]);
  });

  it("renders the mode toggle and switches the placeholder when clicked", () => {
    renderAt("/traces/root");
    expect(screen.getByTestId("trace-mode-toggle")).toBeInTheDocument();
    expect(
      screen.getByTestId("trace-mode-placeholder").getAttribute("data-mode")
    ).toBe("thread");
    fireEvent.click(screen.getByTestId("trace-mode-option-corridor"));
    expect(
      screen.getByTestId("trace-mode-placeholder").getAttribute("data-mode")
    ).toBe("corridor");
  });

  it("collapses and expands the subtree rail", () => {
    renderAt("/traces/root");
    expect(screen.getByTestId("subtree-rail").getAttribute("data-collapsed")).toBe(
      "false"
    );
    fireEvent.click(screen.getByTestId("subtree-rail-toggle"));
    expect(screen.getByTestId("subtree-rail").getAttribute("data-collapsed")).toBe(
      "true"
    );
  });

  it("navigates back when the back button is clicked", () => {
    renderAt("/traces/root");
    fireEvent.click(screen.getByTestId("traces-back-button"));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it("shows an empty state when no taskId is provided", () => {
    renderAt("/traces");
    expect(screen.getByTestId("traces-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("traces-page")).toBeNull();
  });
});
