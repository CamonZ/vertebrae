import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, render as rtlRender } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TaskDetailPage } from "./TaskDetailPage";
import { useTaskStore } from "../stores";
import type { Task } from "../bindings";
import { createMockTask } from "../test/test-utils";

// Stub WindowLayout so we don't pull in GlobalListeners + ToastContainer
// (and their backend wiring) in this focused test.
vi.mock("../components/WindowLayout", () => ({
  WindowLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="window-layout">{children}</div>
  ),
}));

// Hoisted mocks — vi.mock factories run before module-level code, so any
// vars referenced inside them must come from vi.hoisted.
const { useTasksMock, takeStashedTaskMock } = vi.hoisted(() => ({
  useTasksMock: vi.fn(),
  takeStashedTaskMock: vi.fn<
    (taskId: string) => { task: Task; related: Task[] } | null
  >(),
}));

vi.mock("../hooks", () => ({
  useTasks: () => useTasksMock(),
}));

vi.mock("../utils", async () => {
  const actual = await vi.importActual<typeof import("../utils")>("../utils");
  return {
    ...actual,
    takeStashedTask: takeStashedTaskMock,
  };
});

// Capture the props TaskDetailPanel receives so we can assert on the
// route-driven taskId, the standalone flag, and inter-task navigation.
const lastProps: { taskId: string | null; standalone?: boolean }[] = [];
vi.mock("../components/TaskDetail", () => ({
  TaskDetailPanel: ({
    taskId,
    standalone,
    onTaskSelect,
  }: {
    taskId: string | null;
    standalone?: boolean;
    onTaskSelect?: (id: string) => void;
  }) => {
    lastProps.push({ taskId, standalone });
    return (
      <div data-testid="task-detail-panel">
        <span data-testid="active-task-id">{taskId ?? ""}</span>
        <span data-testid="standalone-flag">{String(Boolean(standalone))}</span>
        <button
          data-testid="navigate-dep"
          onClick={() => onTaskSelect?.("dep-task-456")}
        >
          go to dep
        </button>
      </div>
    );
  },
}));

function renderAt(path: string) {
  return rtlRender(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/task/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TaskDetailPage", () => {
  beforeEach(() => {
    lastProps.length = 0;
    useTasksMock.mockClear();
    takeStashedTaskMock.mockReset();
    takeStashedTaskMock.mockReturnValue(null);
    useTaskStore.getState().setTasks([]);
  });

  it("renders TaskDetailPanel with the route taskId in standalone mode inside WindowLayout", () => {
    renderAt("/task/abc-123");

    expect(screen.getByTestId("window-layout")).toBeInTheDocument();
    expect(screen.getByTestId("active-task-id")).toHaveTextContent("abc-123");
    expect(screen.getByTestId("standalone-flag")).toHaveTextContent("true");
    expect(lastProps[0]).toEqual({ taskId: "abc-123", standalone: true });
  });

  it("updates the active task in-place when onTaskSelect fires (e.g. clicking a dependency)", () => {
    renderAt("/task/abc-123");

    expect(screen.getByTestId("active-task-id")).toHaveTextContent("abc-123");

    fireEvent.click(screen.getByTestId("navigate-dep"));

    expect(screen.getByTestId("active-task-id")).toHaveTextContent(
      "dep-task-456",
    );
  });

  it("seeds the task store from the parent's stash so the first paint has full data", () => {
    const focal = createMockTask({ id: "abc-123", title: "Focal" });
    const child = createMockTask({ id: "child-1", parent_id: "abc-123" });
    takeStashedTaskMock.mockReturnValue({ task: focal, related: [child] });

    renderAt("/task/abc-123");

    expect(takeStashedTaskMock).toHaveBeenCalledWith("abc-123");
    const ids = useTaskStore.getState().tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["abc-123", "child-1"]);
  });

  it("leaves the store empty when no stash is present (background fetch handles hydration)", () => {
    renderAt("/task/abc-123");

    expect(takeStashedTaskMock).toHaveBeenCalledWith("abc-123");
    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(useTasksMock).toHaveBeenCalled();
  });
});
