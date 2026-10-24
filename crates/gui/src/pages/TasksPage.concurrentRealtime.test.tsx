import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../bindings";
import {
  act,
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
  render,
  screen,
  waitFor,
  within,
} from "../test/test-utils";
import { TasksPage } from "./TasksPage";
import { useTaskChangeListener } from "../hooks/useTaskChangeListener";
import { useTaskRunChangeListener } from "../hooks/useTaskRunChangeListener";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { queryClient, queryKeys } from "../query";

const runtime = vi.hoisted(() => ({
  tasks: [] as Task[],
  list: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("../bindings", () => ({
  commands: {
    listTasks: () => {
      runtime.list();
      return Promise.resolve({ status: "ok", data: runtime.tasks });
    },
  },
  events: Object.fromEntries(
    [
      "taskChangedEvent",
      "taskStepChangedEvent",
      "taskRunStepChangedEvent",
      "taskRunChangedEvent",
    ].map((name) => [
      name,
      {
        listen: (handler: (event: { payload: unknown }) => void) => {
          runtime.handlers.set(name, handler);
          return Promise.resolve(() => {
            if (runtime.handlers.get(name) === handler)
              runtime.handlers.delete(name);
          });
        },
      },
    ])
  ),
}));
function RealtimeTasks() {
  useTaskChangeListener();
  useTaskRunChangeListener();
  return <TasksPage />;
}
function emit(name: string, payload: unknown) {
  const handler = runtime.handlers.get(name);
  if (!handler) throw new Error(`Listener not mounted: ${name}`);
  handler({ payload });
}

describe("TasksPage interleaved multi-task realtime updates", () => {
  beforeEach(() => {
    resetProjectScopedStores();
    runtime.list.mockClear();
    runtime.handlers.clear();
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("preserves each task's fields, location and run controls across mixed event bursts without refetching", async () => {
    runtime.tasks = Array.from({ length: 60 }, (_, i) =>
      createMockTask({
        id: `task-${i}`,
        title: `Initial ${i}`,
        workflow_id: "workflow",
        parent_id: null,
      })
    );
    render(<RealtimeTasks />);
    await waitFor(() =>
      expect(screen.getAllByTestId("task-tree-node-row")).toHaveLength(60)
    );
    const expected = runtime.tasks.map((task, i) => {
      const run = createMockTaskRun({
        id: `run-${i}`,
        task_id: task.id,
        status: i % 2 ? "waiting" : "executing",
      });
      return {
        ...task,
        title: `Final ${i}`,
        description: `Description ${i}`,
        priority: "high" as const,
        tags: [`tag-${i}`],
        current_step_id: `step-${i}`,
        run_controls: createMockTaskRunControls(run),
      };
    });
    // Different tasks' events interleave. A second burst changes fields after
    // movement/control events, matching independent workflow and task CDC paths.
    act(() => {
      for (let i = 0; i < expected.length; i++) {
        const task = expected[i];
        emit("taskChangedEvent", {
          task_id: task.id,
          change_type: "Updated",
          archived: false,
          task: {
            ...task,
            title: `Intermediate ${i}`,
            current_step_id: null,
            run_controls: null,
          },
        });
        emit("taskRunStepChangedEvent", {
          task_id: task.id,
          from_step_id: null,
          to_step_id: task.current_step_id,
        });
        emit("taskRunChangedEvent", {
          task_id: task.id,
          task_run: task.run_controls.active_run,
          run_controls: { kind: "present", controls: task.run_controls },
        });
      }
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("task-tree-node-run-chip")).toHaveLength(60)
    );
    act(() => {
      for (const task of [...expected].reverse())
        emit("taskChangedEvent", {
          task_id: task.id,
          change_type: "Updated",
          archived: false,
          task,
        });
    });
    await waitFor(() =>
      expect(screen.getByText("Final 59")).toBeInTheDocument()
    );
    for (let i = 0; i < expected.length; i++) {
      const row = screen
        .getByText(`Final ${i}`)
        .closest<HTMLElement>('[data-testid="task-tree-node-row"]')!;
      expect(within(row).getByText(`tag-${i}`)).toBeInTheDocument();
      expect(
        within(row).getByTestId("task-tree-node-priority")
      ).toHaveAttribute("data-priority", "high");
      expect(
        within(row).getByTestId("task-tree-node-run-chip")
      ).toHaveAttribute("data-run-status", i % 2 ? "waiting" : "executing");
    }
    expect(
      queryClient.getQueryData(
        queryKeys.tasks.list(getProjectScopeGeneration(), null)
      )
    ).toEqual(expected);
    expect(runtime.list).toHaveBeenCalledTimes(1);
  });
});
