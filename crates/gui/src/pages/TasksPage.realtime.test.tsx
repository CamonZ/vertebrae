import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, waitFor, screen, render } from "../test/test-utils";
import type {
  Task,
  TaskFilterOptions,
  TaskStepChangedEvent,
} from "../bindings";
import { createMockTask } from "../test/test-utils";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { useTaskChangeListener } from "../hooks/useTaskChangeListener";
import { queryClient, queryKeys } from "../query";
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

const INITIAL_FILTERS: TaskFilterOptions = {
  step_names: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  search: null,
  workflow_id: null,
  step_id: null,
};

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

  it("applies a websocket step-change event in place without refetching the page", async () => {
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
      expect(screen.getByText("Realtime ticket")).toBeInTheDocument();
    });

    if (!taskStepChangedHandler)
      throw new Error("step listener not registered");
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

    // The row no longer surfaces the step, so assert the in-place update via the
    // query cache and confirm the event did not trigger a page-list refetch.
    await waitFor(() => {
      expect(
        queryClient
          .getQueryData<
            Task[]
          >(queryKeys.tasks.list(getProjectScopeGeneration(), INITIAL_FILTERS))
          ?.find((t) => t.id === "task-realtime-step")?.step_name
      ).toBe("pending_review");
    });
    expect(mockListTasks).toHaveBeenCalledTimes(1);
  });
});
