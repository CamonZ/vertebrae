import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineStep,
  PipelineSummary,
  Task,
  TaskRun,
  TaskRunStatus,
} from "../../bindings";
import { RunConsole } from "./RunConsole";
import { queryClient } from "../../query";

/* ── mocks ─────────────────────────────────────────────────────────
   The task feed and the heavyweight TaskDetailPanel are stubbed so the test
   exercises only the console's split + actions. `commands` is mocked the way
   the existing panel tests do (spread the real module, override the two we
   assert on). */

const mockTasks = vi.fn<() => Task[]>(() => []);
vi.mock("./hooks/useRunConsoleTasks", () => ({
  useRunConsoleTasks: () => ({
    tasks: mockTasks(),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/useTaskRuns", () => ({
  useActiveTaskRunsForTasks: () => ({
    activeRunsByTaskId: new Map(
      mockTasks().flatMap((task) =>
        task.run_controls?.active_run
          ? [[task.id, task.run_controls.active_run] as const]
          : []
      )
    ),
  }),
}));

vi.mock("../TaskDetail", () => ({
  TaskDetailPanel: ({ taskId }: { taskId: string | null }) => (
    <div data-testid="task-detail-panel">{taskId}</div>
  ),
}));

// Hoisted so the `vi.mock` factory (which is itself hoisted) can reference them.
const { runWorkflow, stopRun } = vi.hoisted(() => ({
  runWorkflow: vi.fn(async () => ({ status: "ok", data: {} })),
  stopRun: vi.fn(async () => ({ status: "ok", data: null })),
}));
vi.mock("../../bindings", async () => {
  const actual =
    await vi.importActual<typeof import("../../bindings")>("../../bindings");
  return {
    ...actual,
    commands: { runWorkflow, stopRun },
  };
});

/* ── fixtures ──────────────────────────────────────────────────── */

function makeRun(status: TaskRunStatus): TaskRun {
  return {
    id: "run",
    task_id: "t",
    project_id: "p",
    user_id: null,
    status,
    started_at: "2024-01-01T00:00:00Z",
    ended_at: null,
    stop_requested_at: null,
    latest_step_execution_id: null,
    inserted_at: "2024-01-01T00:00:00Z",
  } as TaskRun;
}

function makeTask(id: string, run: TaskRun | null, title: string): Task {
  return {
    id,
    title,
    description: null,
    level: "task",
    priority: null,
    tags: [],
    workflow_id: "wf-build",
    current_step_id: "s1",
    workflow_name: "Build",
    step_name: null,
    step_type: "execute",
    run_controls: {
      runnable: !run,
      stoppable: !!run,
      disabled_reason_code: null,
      disabled_reason: null,
      active_run: run,
    },
    archived: false,
    worktree: null,
    rejection_reason: null,
    parent_id: null,
    dependency_ids: [],
    sections: [],
    code_refs: [],
    created_at: null,
    updated_at: null,
    started_at: null,
    completed_at: null,
  } as Task;
}

function makeStep(id: string, order: number): PipelineStep {
  return {
    id,
    name: id,
    workflow_id: "wf-build",
    goal: null,
    step_order: order,
    step_type: "execute",
    transitions_to: [],
    task_counts: { epic: 0, ticket: 0, task: 0 },
    pipeline_counts: { epic: 0, ticket: 0, task: 0, active: 0 },
    active_count: 0,
  } as PipelineStep;
}

const SUMMARY: PipelineSummary = {
  workflows: [
    {
      id: "wf-build",
      name: "Build",
      description: null,
      initial_step_id: "s1",
      kanban_column: null,
      is_default: false,
      display_order: 0,
      workflow_steps: [makeStep("s1", 0), makeStep("s2", 1)],
      transitions: [],
    },
  ],
} as PipelineSummary;

const READY = makeTask("ready-aaaa", null, "Ready task");
const RUNNING = makeTask("runn-bbbb", makeRun("executing"), "Running task");

function openConsole() {
  fireEvent.click(screen.getByTestId("run-console-fab"));
}

function renderConsole() {
  return render(
    <QueryClientProvider client={queryClient}>
      <RunConsole summary={SUMMARY} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mockTasks.mockReturnValue([]);
});

/* ── tests ─────────────────────────────────────────────────────── */

describe("RunConsole", () => {
  it("splits tasks into Ready / Running tabs from the feed", () => {
    mockTasks.mockReturnValue([READY, RUNNING]);
    renderConsole();
    openConsole();

    const console_ = screen.getByTestId("run-console");
    // Ready tab is the default — shows the ready task only.
    expect(within(console_).getByText("Ready task")).toBeInTheDocument();
    expect(
      within(console_).queryByText("Running task")
    ).not.toBeInTheDocument();

    // Tab counts reflect the split.
    const tabs = within(console_).getAllByRole("tab");
    expect(tabs[0]).toHaveTextContent("Ready1");
    expect(tabs[1]).toHaveTextContent("Running1");

    // Switch to Running → shows the active run only.
    fireEvent.click(tabs[1]);
    expect(within(console_).getByText("Running task")).toBeInTheDocument();
    expect(within(console_).queryByText("Ready task")).not.toBeInTheDocument();
  });

  it("Run fires runWorkflow with the task id", () => {
    mockTasks.mockReturnValue([READY]);
    renderConsole();
    openConsole();

    fireEvent.click(screen.getByRole("button", { name: "Run task" }));
    expect(runWorkflow).toHaveBeenCalledExactlyOnceWith("ready-aaaa");
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("Stop fires stopRun with the task id", () => {
    mockTasks.mockReturnValue([RUNNING]);
    renderConsole();
    openConsole();

    // Jump to the Running tab where the Stop control lives.
    fireEvent.click(
      within(screen.getByTestId("run-console")).getAllByRole("tab")[1]
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(stopRun).toHaveBeenCalledExactlyOnceWith({
      task_run_id: null,
      task_id: "runn-bbbb",
    });
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("Run all fires runWorkflow for the ready head", () => {
    mockTasks.mockReturnValue([READY, RUNNING]);
    renderConsole();
    openConsole();

    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(runWorkflow).toHaveBeenCalledExactlyOnceWith("ready-aaaa");
  });

  it("opens the task detail panel on row click", () => {
    mockTasks.mockReturnValue([READY]);
    renderConsole();
    openConsole();

    fireEvent.click(screen.getByText("Ready task"));
    expect(screen.getByTestId("task-detail-panel")).toHaveTextContent(
      "ready-aaaa"
    );
  });

  it("collapses on Escape via the shared glass-panel focus stack", () => {
    mockTasks.mockReturnValue([READY]);
    renderConsole();
    openConsole();
    expect(screen.getByTestId("run-console")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByTestId("run-console")).not.toBeInTheDocument();
    expect(screen.getByTestId("run-console-fab")).toBeInTheDocument();
  });
});
