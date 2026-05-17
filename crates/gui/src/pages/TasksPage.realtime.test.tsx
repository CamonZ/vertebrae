import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, waitFor, screen, render } from "../test/test-utils";
import type { TaskStepChangedEvent } from "../bindings";
import { createMockTask } from "../test/test-utils";
import { resetProjectScopedStores } from "../stores/projectScopedStores";
import { useTaskChangeListener } from "../hooks/useTaskChangeListener";
import { TasksPage } from "./TasksPage";

const mockListTasks = vi.fn();
const mockGetTask = vi.fn();
let taskStepChangedHandler:
  | ((event: { payload: TaskStepChangedEvent }) => void)
  | null = null;

vi.mock("../bindings", () => ({
  commands: {
    listTasks: (...args: unknown[]) => mockListTasks(...args),
    getTask: (...args: unknown[]) => mockGetTask(...args),
  },
  events: {
    taskChangedEvent: {
      listen: vi.fn(async () => vi.fn()),
    },
    taskStepChangedEvent: {
      listen: (handler: (event: { payload: TaskStepChangedEvent }) => void) => {
        taskStepChangedHandler = handler;
        return Promise.resolve(() => {});
      },
    },
    taskRunStepChangedEvent: {
      listen: vi.fn(async () => vi.fn()),
    },
  },
}));

vi.mock("../components/TaskDetail", () => ({
  TaskDetailPanel: () => null,
}));

function TasksPageWithRealtime() {
  useTaskChangeListener();
  return <TasksPage />;
}

describe("TasksPage realtime task membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    taskStepChangedHandler = null;
    resetProjectScopedStores();
  });

  it("updates the visible step badge from a websocket step-change event without refetching the page", async () => {
    const original = createMockTask({
      id: "task-realtime-step",
      title: "Realtime ticket",
      workflow_id: "workflow-1",
      workflow_name: "Implementation",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    const updated = {
      ...original,
      current_step_id: "step-review",
      step_name: "pending_review",
    };
    mockListTasks.mockResolvedValue({ status: "ok", data: [original] });
    mockGetTask.mockResolvedValue({ status: "ok", data: updated });

    render(<TasksPageWithRealtime />);

    await waitFor(() => {
      expect(screen.getByText("Todo")).toBeInTheDocument();
    });

    if (!taskStepChangedHandler) throw new Error("step listener not registered");
    act(() => {
      taskStepChangedHandler!({
        payload: {
          task_id: "task-realtime-step",
          from_step_id: "step-todo",
          to_step_id: "step-review",
          workflow_id: "workflow-1",
          level: "ticket",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Pending review")).toBeInTheDocument();
    });
    expect(screen.queryByText("Todo")).not.toBeInTheDocument();
    expect(mockListTasks).toHaveBeenCalledTimes(1);
  });
});
