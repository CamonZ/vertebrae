import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor, within } from "@testing-library/react";
import { fireEvent, render, screen } from "../test/test-utils";
import {
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
} from "../test/test-utils";
import {
  AllWorkflowsPipeline,
  buildRenderableWorkflowTransitions,
  buildStepTransitionEdges,
} from "./AllWorkflowsPipeline";
import type { PipelineStep } from "../hooks/usePipelineSummary";
import {
  applyStepTransitionCreated,
  applyStepTransitionDeleted,
} from "../hooks/pipelineSummaryReducer";
import { ROUTE_BACK_EDGE_TYPE } from "../components/WorkflowPipeline";
import { useTaskStore } from "../stores";

type EventCallback = (event: { payload: Record<string, unknown> }) => void;

const { mockEvents, eventListeners, emitEvent } = vi.hoisted(() => {
  const listeners: Record<string, EventCallback[]> = {};

  function createEventListener(eventName: string) {
    return {
      listen: vi.fn((callback: EventCallback) => {
        listeners[eventName] = listeners[eventName] || [];
        listeners[eventName].push(callback);
        return Promise.resolve(() => {
          const idx = listeners[eventName].indexOf(callback);
          if (idx > -1) listeners[eventName].splice(idx, 1);
        });
      }),
    };
  }

  return {
    mockEvents: {
      taskChangedEvent: createEventListener("taskChanged"),
      taskRunChangedEvent: createEventListener("taskRunChanged"),
      taskStepChangedEvent: createEventListener("taskStepChanged"),
      taskRunStepChangedEvent: createEventListener("taskRunStepChanged"),
      stepChangedEvent: createEventListener("stepChanged"),
      stepTransitionChangedEvent: createEventListener("stepTransitionChanged"),
      workflowChangedEvent: createEventListener("workflowChanged"),
      workflowTransitionChangedEvent: createEventListener(
        "workflowTransitionChanged"
      ),
    },
    eventListeners: listeners,
    emitEvent: (eventName: string, payload: Record<string, unknown>) => {
      const callbacks = listeners[eventName] || [];
      callbacks.forEach((callback) => callback({ payload }));
    },
  };
});

vi.mock("../bindings", () => ({
  commands: {
    getPipelineSummary: vi.fn(),
    getTaskRunTrace: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    runWorkflow: vi.fn(),
    stopRun: vi.fn(),
    getWebsocketStatus: vi.fn().mockResolvedValue({
      status: "ok",
      data: "connected",
    }),
  },
  events: mockEvents,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { commands } from "../bindings";

function makeStep(
  id: string,
  workflowId: string,
  name: string,
  order: number,
  options: {
    taskCounts?: { epic: number; ticket: number; task: number };
    activeCount?: number;
    stepType?: string;
    transitionsTo?: string[];
  } = {}
): PipelineStep {
  const {
    taskCounts = { epic: 0, ticket: 0, task: 0 },
    activeCount = 0,
    stepType = "execute",
    transitionsTo = [],
  } = options;

  return {
    id,
    name,
    workflow_id: workflowId,
    goal: null,
    step_order: order,
    step_type: stepType,
    is_final: false,
    transitions_to: transitionsTo,
    task_counts: taskCounts,
    pipeline_counts: { ...taskCounts, active: activeCount },
    active_count: activeCount,
  };
}

describe("AllWorkflowsPipeline + usePipelineSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(eventListeners).forEach((key) => {
      eventListeners[key] = [];
    });
    useTaskStore.getState().reset();
    vi.mocked(commands.listTasks).mockResolvedValue({
      status: "ok",
      data: [],
    });
    vi.mocked(commands.getTaskRunTrace).mockResolvedValue({
      status: "ok",
      data: {
        root_task_run_id: "run-empty",
        task_runs: [],
        step_executions: [],
        session_logs: [],
      },
    });
    vi.mocked(commands.getTask).mockImplementation(async (id: string) => ({
      status: "ok",
      data: createMockTask({ id, title: `Task ${id}` }),
    }));
    vi.mocked(commands.runWorkflow).mockResolvedValue({
      status: "ok",
      data: createMockTaskRun(),
    });
    vi.mocked(commands.stopRun).mockResolvedValue({
      status: "ok",
      data: null,
    });
  });

  it("renders workflow names from getPipelineSummary", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Pipeline Alpha",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [
              makeStep("s1", "wf-1", "backlog", 0, {
                taskCounts: { epic: 1, ticket: 2, task: 3 },
                activeCount: 1,
              }),
              makeStep("s2", "wf-1", "in_progress", 1),
            ],
            transitions: [],
          },
          {
            id: "wf-2",
            name: "Pipeline Beta",
            description: null,
            initial_step_id: "s3",
            kanban_column: null,
            is_default: false,
            is_final: false,
            display_order: 1,
            workflow_steps: [makeStep("s3", "wf-2", "todo", 0)],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
      expect(screen.getByText("Pipeline Beta")).toBeInTheDocument();
    });
    expect(screen.getByText("2 workflows visualized")).toBeInTheDocument();
    const railItems = screen.getAllByTestId("workflow-rail-item");
    expect(railItems).toHaveLength(2);
    expect(railItems[0]).toHaveTextContent("Pipeline Alpha");
    expect(railItems[0]).toHaveTextContent(/2 steps.*6 tasks/);
    expect(railItems[0]).toHaveTextContent("1");
    expect(railItems[1]).toHaveTextContent("Pipeline Beta");
    expect(railItems[1]).toHaveTextContent(/1 steps.*0 tasks/);

    fireEvent.change(screen.getByLabelText("Search workflows"), {
      target: { value: "Beta" },
    });
    const filteredRailItems = screen.getAllByTestId("workflow-rail-item");
    expect(filteredRailItems).toHaveLength(1);
    expect(filteredRailItems[0]).toHaveTextContent("Pipeline Beta");
    expect(filteredRailItems[0]).not.toHaveTextContent("Pipeline Alpha");

    // The summary may be fetched more than once in test mode (StrictMode +
    // visibilitychange listeners can refetch); we just want at least one call.
    expect(
      vi.mocked(commands.getPipelineSummary).mock.calls.length
    ).toBeGreaterThanOrEqual(1);
  });

  it("does not render a collapse toggle and keeps step nodes visible after c is pressed", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Pipeline Alpha",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [
              makeStep("s1", "wf-1", "backlog", 0),
              makeStep("s2", "wf-1", "review", 1),
            ],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByTestId("step-node-backlog")).toBeInTheDocument();
      expect(screen.getByTestId("step-node-review")).toBeInTheDocument();
    });

    expect(screen.queryByTitle("Press 'c' to toggle")).not.toBeInTheDocument();
    expect(screen.queryByText("Expanded")).not.toBeInTheDocument();
    expect(screen.queryByText("Collapsed")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "c" });
    fireEvent.keyDown(window, { key: "C" });

    expect(screen.getByTestId("step-node-backlog")).toBeInTheDocument();
    expect(screen.getByTestId("step-node-review")).toBeInTheDocument();
  });

  it("maps TaskRun-backed active counts into step nodes", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Pipeline Alpha",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [
              makeStep("s1", "wf-1", "active step", 0, {
                taskCounts: { epic: 0, ticket: 0, task: 1 },
                activeCount: 2,
              }),
            ],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByTitle("2 active")).toBeInTheDocument();
    });
    expect(screen.queryByTitle("2 running")).not.toBeInTheDocument();
  });

  it("renders a floating running tasks panel with task, workflow, and step names", async () => {
    const runA = createMockTaskRun({
      id: "run-alpha",
      task_id: "task-alpha",
      status: "executing",
      started_at: "2026-05-23T10:00:00.000Z",
      inserted_at: "2026-05-23T10:00:00.000Z",
    });
    const runB = createMockTaskRun({
      id: "run-beta",
      task_id: "task-beta",
      status: "waiting",
      started_at: "2026-05-23T10:01:00.000Z",
      inserted_at: "2026-05-23T10:01:00.000Z",
    });
    const taskA = createMockTask({
      id: "task-alpha",
      title: "Implement trace rail",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s1",
      step_name: "code",
      run_controls: createMockTaskRunControls(runA),
    });
    const taskB = createMockTask({
      id: "task-beta",
      title: "Review pipeline events",
      workflow_id: "wf-2",
      workflow_name: "Review",
      current_step_id: "s2",
      step_name: "human_check",
      run_controls: createMockTaskRunControls(runB),
    });
    const childTask = createMockTask({
      id: "child-alpha",
      title: "Child implementation task",
      parent_id: "task-alpha",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s1",
      step_name: "todo",
    });
    const childRun = createMockTaskRun({
      id: "run-child",
      task_id: "child-alpha",
      status: "executing",
      started_at: "2026-05-23T10:02:00.000Z",
      inserted_at: "2026-05-23T10:02:00.000Z",
    });
    const runningChildTask = {
      ...childTask,
      run_controls: createMockTaskRunControls(childRun),
    };
    const completedChildTask = createMockTask({
      id: "child-completed",
      title: "Completed child task",
      parent_id: "task-alpha",
      completed_at: "2026-05-23T10:03:00.000Z",
      step_name: "done",
    });
    useTaskStore
      .getState()
      .setTasks([taskA, taskB, runningChildTask, completedChildTask]);
    vi.mocked(commands.listTasks).mockResolvedValue({
      status: "ok",
      data: [taskA, taskB, runningChildTask, completedChildTask],
    });

    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Implementation",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [makeStep("s1", "wf-1", "code", 0)],
            transitions: [],
          },
          {
            id: "wf-2",
            name: "Review",
            description: null,
            initial_step_id: "s2",
            kanban_column: null,
            is_default: false,
            is_final: false,
            display_order: 1,
            workflow_steps: [makeStep("s2", "wf-2", "human_check", 0)],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    const panel = await screen.findByRole("region", {
      name: "Pipeline task launcher",
    });
    expect(within(panel).getByText("Implement trace rail")).toBeInTheDocument();
    expect(
      within(panel).getByText("Review pipeline events")
    ).toBeInTheDocument();
    const rows = screen.getAllByTestId("pipeline-active-run");
    expect(
      within(rows[0]).getByText("Review pipeline events")
    ).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("Review");
    expect(rows[0]).toHaveTextContent("Human check");
    expect(
      within(rows[1]).getByText("Implement trace rail")
    ).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Implementation");
    expect(rows[1]).toHaveTextContent("Code");
    expect(rows).toHaveLength(2);
    expect(
      screen.getAllByTestId("pipeline-active-run-task-id")[0]
    ).toHaveTextContent("task-bet");
    const childRows = screen.getAllByTestId("pipeline-active-run-child");
    expect(childRows).toHaveLength(1);
    expect(childRows[0]).toHaveTextContent("child-al");
    expect(childRows[0]).toHaveTextContent("Child implementation task");
    expect(childRows[0]).toHaveTextContent("Implementation");
    expect(childRows[0]).toHaveTextContent("Todo");
    expect(within(childRows[0]).getByLabelText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Completed child task")).not.toBeInTheDocument();
  });

  it("uses step type taxonomy for running task status indicators", async () => {
    const queuedTask = createMockTask({
      id: "task-queued",
      title: "Queued task",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s1",
      step_name: "queued_display",
      run_controls: createMockTaskRunControls(
        createMockTaskRun({
          id: "run-queued",
          task_id: "task-queued",
          status: "queued",
          inserted_at: "2026-05-23T10:00:00.000Z",
        })
      ),
    });
    const waitChildrenTask = createMockTask({
      id: "task-wait-children",
      title: "Waiting on child work",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s2",
      step_name: "custom_gate_name",
      run_controls: createMockTaskRunControls(
        createMockTaskRun({
          id: "run-wait-children",
          task_id: "task-wait-children",
          status: "waiting",
          inserted_at: "2026-05-23T10:01:00.000Z",
        })
      ),
    });
    const humanInputTask = createMockTask({
      id: "task-human-input",
      title: "Waiting for approval",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s3",
      step_name: "wait_children",
      run_controls: createMockTaskRunControls(
        createMockTaskRun({
          id: "run-human-input",
          task_id: "task-human-input",
          status: "waiting",
          inserted_at: "2026-05-23T10:02:00.000Z",
        })
      ),
    });
    vi.mocked(commands.listTasks).mockResolvedValue({
      status: "ok",
      data: [queuedTask, waitChildrenTask, humanInputTask],
    });
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Implementation",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [
              makeStep("s1", "wf-1", "queued_display", 0),
              makeStep("s2", "wf-1", "custom_gate_name", 1, {
                stepType: "wait_children",
              }),
              makeStep("s3", "wf-1", "wait_children", 2, {
                stepType: "human_input",
              }),
            ],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    const panel = await screen.findByRole("region", {
      name: "Pipeline task launcher",
    });
    expect(within(panel).getByLabelText("Queued")).toBeInTheDocument();
    expect(
      within(panel).getByLabelText("Waiting on children")
    ).toBeInTheDocument();
    expect(
      within(panel).getByLabelText("Waiting for human input")
    ).toBeInTheDocument();
  });

  it("loads running tasks for a fresh pipeline visit before websocket events arrive", async () => {
    const runningRun = createMockTaskRun({
      id: "run-initial",
      task_id: "task-initial",
      status: "executing",
    });
    vi.mocked(commands.listTasks).mockResolvedValue({
      status: "ok",
      data: [
        createMockTask({
          id: "task-initial",
          title: "Already running task",
          workflow_id: "wf-1",
          workflow_name: "Implementation",
          current_step_id: "s1",
          step_name: "code",
          run_controls: createMockTaskRunControls(runningRun),
        }),
      ],
    });
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Implementation",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [makeStep("s1", "wf-1", "code", 0)],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    const panel = await screen.findByRole("region", {
      name: "Pipeline task launcher",
    });
    expect(within(panel).getByText("Already running task")).toBeInTheDocument();
    expect(commands.listTasks).toHaveBeenCalledWith({
      step_names: null,
      levels: null,
      tags: null,
      root_only: null,
      children_of: null,
      search: null,
      workflow_id: null,
      step_id: null,
    });
  });

  it("shows ready tasks on the ready tab with details actions but no trace action", async () => {
    const readyTask = createMockTask({
      id: "task-ready",
      title: "Ready implementation task",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s1",
      step_name: "todo",
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
    });
    const otherReadyTask = createMockTask({
      id: "task-ready-other",
      title: "Other ready task",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s1",
      step_name: "todo",
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
    });
    vi.mocked(commands.listTasks).mockResolvedValue({
      status: "ok",
      data: [readyTask, otherReadyTask],
    });
    vi.mocked(commands.getTask).mockImplementation(async (id: string) => ({
      status: "ok",
      data: id === readyTask.id ? readyTask : otherReadyTask,
    }));
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Implementation",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [makeStep("s1", "wf-1", "todo", 0)],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    fireEvent.click(await screen.findByRole("tab", { name: /Ready 2/ }));

    const panel = await screen.findByRole("region", {
      name: "Pipeline task launcher",
    });
    expect(
      within(panel).getByText("Ready implementation task")
    ).toBeInTheDocument();
    expect(
      within(panel).queryByLabelText(
        "Show traces for Ready implementation task"
      )
    ).toBeNull();

    fireEvent.click(
      within(panel).getByLabelText(
        "Start orchestration for Ready implementation task"
      )
    );
    await waitFor(() => {
      expect(commands.runWorkflow).toHaveBeenCalledWith("task-ready");
    });

    fireEvent.click(
      within(panel).getByLabelText("Show details for Ready implementation task")
    );

    expect(commands.getTask).toHaveBeenCalledWith("task-ready");
    expect(await screen.findByTestId("task-detail-id")).toHaveTextContent(
      "task-rea"
    );

    fireEvent.click(
      within(panel).getByLabelText("Show details for Ready implementation task")
    );
    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-id")).not.toBeInTheDocument();
    });

    fireEvent.click(
      within(panel).getByLabelText("Show details for Other ready task")
    );
    await waitFor(() => {
      expect(commands.getTask).toHaveBeenCalledWith("task-ready-other");
    });
  });

  it("opens a live trace panel below the running panel when a run row is clicked", async () => {
    const runningRun = createMockTaskRun({
      id: "run-trace",
      task_id: "task-trace",
      status: "executing",
      latest_step_execution_id: "exec-trace",
    });
    const task = createMockTask({
      id: "task-trace",
      title: "Traceable running task",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s1",
      step_name: "code",
      run_controls: createMockTaskRunControls(runningRun),
    });
    const otherRun = createMockTaskRun({
      id: "run-other-trace",
      task_id: "task-other-trace",
      status: "executing",
      started_at: "2026-05-23T10:01:00.000Z",
      inserted_at: "2026-05-23T10:01:00.000Z",
    });
    const otherTask = createMockTask({
      id: "task-other-trace",
      title: "Other traceable task",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s1",
      step_name: "code",
      run_controls: createMockTaskRunControls(otherRun),
    });
    vi.mocked(commands.listTasks).mockResolvedValue({
      status: "ok",
      data: [task, otherTask],
    });
    vi.mocked(commands.getTaskRunTrace).mockResolvedValue({
      status: "ok",
      data: {
        root_task_run_id: "run-trace",
        task_runs: [runningRun],
        step_executions: [],
        session_logs: [],
      },
    });
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Implementation",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [makeStep("s1", "wf-1", "code", 0)],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    fireEvent.click(
      await screen.findByLabelText(
        "Stop orchestration for Traceable running task"
      )
    );
    await waitFor(() => {
      expect(commands.stopRun).toHaveBeenCalledWith({
        task_run_id: "run-trace",
        task_id: null,
      });
    });

    fireEvent.click(
      await screen.findByLabelText("Show traces for Traceable running task")
    );

    const tracePanel = await screen.findByTestId(
      "pipeline-active-run-trace-panel"
    );
    expect(tracePanel).toHaveAttribute("data-run-id", "run-trace");
    expect(tracePanel).toHaveTextContent("Live trace");
    expect(commands.getTaskRunTrace).toHaveBeenCalledWith("run-trace");
    expect(commands.getTask).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByLabelText("Show traces for Traceable running task")
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("pipeline-active-run-trace-panel")
      ).not.toBeInTheDocument();
    });

    fireEvent.click(
      await screen.findByLabelText("Show traces for Traceable running task")
    );
    expect(
      await screen.findByTestId("pipeline-active-run-trace-panel")
    ).toHaveAttribute("data-run-id", "run-trace");

    fireEvent.click(
      await screen.findByLabelText("Show traces for Other traceable task")
    );
    expect(
      await screen.findByTestId("pipeline-active-run-trace-panel")
    ).toHaveAttribute("data-run-id", "run-other-trace");
  });

  it("updates the running tasks panel from store changes for run start, step change, and completion", async () => {
    const runningRun = createMockTaskRun({
      id: "run-live",
      task_id: "task-live",
      status: "executing",
      started_at: "2026-05-23T10:00:00.000Z",
      inserted_at: "2026-05-23T10:00:00.000Z",
    });
    const task = createMockTask({
      id: "task-live",
      title: "Live workflow task",
      workflow_id: "wf-1",
      workflow_name: "Implementation",
      current_step_id: "s1",
      step_name: "todo",
      run_controls: null,
    });

    useTaskStore.getState().setTasks([task]);
    vi.mocked(commands.listTasks).mockResolvedValue({
      status: "ok",
      data: [task],
    });
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Implementation",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            is_final: false,
            display_order: 0,
            workflow_steps: [
              makeStep("s1", "wf-1", "todo", 0),
              makeStep("s2", "wf-1", "review", 1),
            ],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-active-run")).toBeNull();
    });
    await waitFor(() => {
      expect(commands.listTasks).toHaveBeenCalled();
    });

    act(() => {
      useTaskStore
        .getState()
        .replaceTaskRunControls(
          "task-live",
          createMockTaskRunControls(runningRun)
        );
    });

    const panel = await screen.findByRole("region", {
      name: "Pipeline task launcher",
    });
    expect(within(panel).getByText("Live workflow task")).toBeInTheDocument();
    expect(
      within(panel).getByText("todo", { exact: false })
    ).toBeInTheDocument();

    act(() => {
      useTaskStore.getState().reconcileTask({
        ...task,
        current_step_id: "s2",
        step_name: "review",
        run_controls: createMockTaskRunControls(runningRun),
      });
    });

    await waitFor(() => {
      expect(
        within(panel).getByText("review", { exact: false })
      ).toBeInTheDocument();
    });
    expect(within(panel).queryByText("todo", { exact: false })).toBeNull();

    act(() => {
      useTaskStore.getState().replaceTaskRunControls("task-live", null);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-active-run")).toBeNull();
    });
  });

  it("preserves pipeline workflow final status for the zone badge and detail toggle", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-final",
            name: "Release Complete",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: false,
            is_final: true,
            display_order: 0,
            workflow_steps: [makeStep("s1", "wf-final", "done", 0)],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    let workflowButton: HTMLElement;
    await waitFor(() => {
      workflowButton = screen.getByRole("button", { name: "Release Complete" });
      expect(workflowButton).toBeInTheDocument();
      expect(
        within(workflowButton.closest("div") as HTMLElement).getByText("Final")
      ).toBeInTheDocument();
    });

    fireEvent.click(workflowButton!);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Final workflow: enabled" })
      ).toHaveAttribute("aria-checked", "true");
    });
  });

  it("applies task_run_step_changed deltas incrementally without refetching", async () => {
    const initialSummary = {
      workflows: [
        {
          id: "wf-1",
          name: "Pipeline Alpha",
          description: null,
          initial_step_id: "s1",
          kanban_column: null,
          is_default: true,
          is_final: false,
          display_order: 0,
          workflow_steps: [
            makeStep("s1", "wf-1", "todo", 0, {
              taskCounts: { epic: 0, ticket: 1, task: 0 },
              activeCount: 1,
            }),
            makeStep("s2", "wf-1", "in_progress", 1),
          ],
          transitions: [],
        },
      ],
    };

    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: initialSummary,
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
    });
    const initialCallCount = vi.mocked(commands.getPipelineSummary).mock.calls
      .length;

    emitEvent("taskRunStepChanged", {
      task_run_id: "run-1",
      task_id: "task-1",
      from_step_id: "s1",
      to_step_id: "s2",
      status: "executing",
      level: "ticket",
    });

    // s2 should now show 1 ticket and 1 active without any extra refetch.
    await waitFor(() => {
      const activeBadges = screen.getAllByTitle("1 active");
      expect(activeBadges.length).toBeGreaterThan(0);
    });
    expect(vi.mocked(commands.getPipelineSummary).mock.calls.length).toBe(
      initialCallCount
    );
  });

  it("shows empty state when no workflows are returned", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: { workflows: [] },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("No workflows yet")).toBeInTheDocument();
    });
  });

  it("shows error state when getPipelineSummary fails", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "error",
      error: { message: "Connection refused" },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Error Loading Workflows")).toBeInTheDocument();
      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });
  });

  it("classifies route-step back transitions as routed loop edges", () => {
    const workflowId = "wf-route";
    const workflow_steps = [
      makeStep("s-a", workflowId, "A", 0),
      makeStep("s-b", workflowId, "B", 1),
      makeStep("s-route", workflowId, "Route", 2, {
        stepType: "route",
        transitionsTo: ["s-a"],
      }),
    ];
    const edges = buildStepTransitionEdges([
      {
        id: workflowId,
        name: "Route Workflow",
        description: null,
        initial_step_id: "s-a",
        kanban_column: null,
        is_default: true,
        is_final: false,
        display_order: 0,
        workflow_steps,
        transitions: [],
      },
    ]);

    expect(edges).toEqual([
      expect.objectContaining({
        id: "edge-wf-route-s-route-s-a",
        source: "step-wf-route-2",
        target: "step-wf-route-0",
        type: ROUTE_BACK_EDGE_TYPE,
        data: { loopLane: 0, loopSide: "bottom" },
        style: expect.objectContaining({ strokeDasharray: "5,5" }),
      }),
    ]);
  });

  it("alternates multiple route-step back transitions in the same workflow", () => {
    const workflowId = "wf-route";
    const workflow_steps = [
      makeStep("s-a", workflowId, "A", 0),
      makeStep("s-b", workflowId, "B", 1),
      makeStep("s-c", workflowId, "C", 2),
      makeStep("s-route", workflowId, "Route", 3, {
        stepType: "route",
        transitionsTo: ["s-a", "s-b", "s-c"],
      }),
    ];

    const edges = buildStepTransitionEdges([
      {
        id: workflowId,
        name: "Route Workflow",
        description: null,
        initial_step_id: "s-a",
        kanban_column: null,
        is_default: true,
        is_final: false,
        display_order: 0,
        workflow_steps,
        transitions: [],
      },
    ]);

    expect(edges).toEqual([
      expect.objectContaining({
        id: "edge-wf-route-s-route-s-a",
        type: ROUTE_BACK_EDGE_TYPE,
        data: { loopLane: 0, loopSide: "bottom" },
      }),
      expect.objectContaining({
        id: "edge-wf-route-s-route-s-b",
        type: ROUTE_BACK_EDGE_TYPE,
        data: { loopLane: 0, loopSide: "top" },
      }),
      expect.objectContaining({
        id: "edge-wf-route-s-route-s-c",
        type: ROUTE_BACK_EDGE_TYPE,
        data: { loopLane: 1, loopSide: "bottom" },
      }),
    ]);
  });

  it("keeps forward same-workflow transitions on the default smoothstep edge", () => {
    const workflowId = "wf-forward";
    const workflow_steps = [
      makeStep("s-a", workflowId, "A", 0, {
        transitionsTo: ["s-b"],
      }),
      makeStep("s-b", workflowId, "B", 1),
    ];
    const edges = buildStepTransitionEdges([
      {
        id: workflowId,
        name: "Forward Workflow",
        description: null,
        initial_step_id: "s-a",
        kanban_column: null,
        is_default: true,
        is_final: false,
        display_order: 0,
        workflow_steps,
        transitions: [],
      },
    ]);

    expect(edges).toEqual([
      expect.objectContaining({
        id: "edge-wf-forward-s-a-s-b",
        source: "step-wf-forward-0",
        target: "step-wf-forward-1",
        type: "smoothstep",
      }),
    ]);
    expect(edges[0].style).not.toHaveProperty("strokeDasharray");
  });

  it("marks selected step transitions with highlighted edge styling", () => {
    const workflowId = "wf-selected-step-edge";
    const workflow_steps = [
      makeStep("s-a", workflowId, "A", 0, {
        transitionsTo: ["s-b"],
      }),
      makeStep("s-b", workflowId, "B", 1),
    ];
    const edgeId = "edge-wf-selected-step-edge-s-a-s-b";
    const edges = buildStepTransitionEdges(
      [
        {
          id: workflowId,
          name: "Selected Step Edge Workflow",
          description: null,
          initial_step_id: "s-a",
          kanban_column: null,
          is_default: true,
          is_final: false,
          display_order: 0,
          workflow_steps,
          transitions: [],
        },
      ],
      new Set(),
      edgeId
    );

    expect(edges).toEqual([
      expect.objectContaining({
        id: edgeId,
        selected: true,
        selectable: true,
        interactionWidth: 20,
        style: expect.objectContaining({
          stroke: "#f59e0b",
          strokeWidth: 2.5,
        }),
        markerEnd: "url(#transition-arrow-selected)",
      }),
    ]);
  });

  it("updates route back edge sets from reducer-applied realtime transition events", () => {
    const workflowId = "wf-realtime";
    const workflow_steps = [
      makeStep("s-a", workflowId, "A", 0),
      makeStep("s-b", workflowId, "B", 1),
      makeStep("s-route", workflowId, "Route", 2, { stepType: "route" }),
    ];
    const summary = {
      workflows: [
        {
          id: workflowId,
          name: "Realtime Workflow",
          description: null,
          initial_step_id: "s-a",
          kanban_column: null,
          is_default: true,
          is_final: false,
          display_order: 0,
          workflow_steps,
          transitions: [],
        },
      ],
    };

    const created = applyStepTransitionCreated(summary, {
      transition_id: "transition-route-a",
      from_step_id: "s-route",
      to_step_id: "s-a",
      change_type: "Created",
    });
    const createdEdges = buildStepTransitionEdges(created.workflows);
    expect(createdEdges.map((edge) => edge.id)).toEqual([
      "edge-wf-realtime-s-route-s-a",
    ]);
    expect(createdEdges[0]).toHaveProperty("type", ROUTE_BACK_EDGE_TYPE);

    const deleted = applyStepTransitionDeleted(created, {
      transition_id: "transition-route-a",
      from_step_id: "s-route",
      to_step_id: "s-a",
      change_type: "Deleted",
    });
    const deletedEdges = buildStepTransitionEdges(deleted.workflows);
    expect(deletedEdges).toEqual([]);
  });

  it("uses compact ELK edge ids when self workflow transitions are skipped", () => {
    const renderableTransitions = buildRenderableWorkflowTransitions([
      {
        id: "self-transition",
        from_workflow_id: "wf-a",
        from_workflow_name: "Workflow A",
        to_workflow_id: "wf-a",
        to_workflow_name: "Workflow A",
        label: "self",
        target_step_id: null,
      },
      {
        id: "actual-transition",
        from_workflow_id: "wf-a",
        from_workflow_name: "Workflow A",
        to_workflow_id: "wf-b",
        to_workflow_name: "Workflow B",
        label: "handoff",
        target_step_id: null,
      },
    ]);

    expect(renderableTransitions).toEqual([
      expect.objectContaining({
        elkEdgeId: "elk-edge-0",
        transition: expect.objectContaining({ id: "actual-transition" }),
      }),
    ]);
  });
});
