import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { render, screen } from "../test/test-utils";
import { AllWorkflowsPipeline } from "./AllWorkflowsPipeline";

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
      stepChangedEvent: createEventListener("stepChanged"),
      workflowTransitionChangedEvent: createEventListener(
        "workflowTransitionChanged",
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
  taskCounts = { epic: 0, ticket: 0, task: 0 },
  activeCount = 0,
) {
  return {
    id,
    name,
    workflow_id: workflowId,
    goal: null,
    step_order: order,
    step_type: "execute",
    is_final: false,
    transitions_to: [] as string[],
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
              makeStep("s1", "wf-1", "backlog", 0, { epic: 1, ticket: 2, task: 3 }, 1),
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
    // The summary may be fetched more than once in test mode (StrictMode +
    // visibilitychange listeners can refetch); we just want at least one call.
    expect(
      vi.mocked(commands.getPipelineSummary).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
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
                epic: 0,
                ticket: 0,
                task: 1,
              }, 2),
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

  it("refetches authoritative pipeline aggregates after task and TaskRun events", async () => {
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
          workflow_steps: [makeStep("s1", "wf-1", "todo", 0)],
          transitions: [],
        },
      ],
    };
    const taskUpdatedSummary = {
      workflows: [
        {
          ...initialSummary.workflows[0],
          workflow_steps: [
            makeStep("s1", "wf-1", "todo", 0, {
              epic: 0,
              ticket: 0,
              task: 1,
            }),
          ],
        },
      ],
    };
    const runUpdatedSummary = {
      workflows: [
        {
          ...initialSummary.workflows[0],
          workflow_steps: [
            makeStep("s1", "wf-1", "todo", 0, {
              epic: 0,
              ticket: 0,
              task: 1,
            }, 1),
          ],
        },
      ],
    };

    vi.mocked(commands.getPipelineSummary)
      .mockResolvedValueOnce({ status: "ok", data: initialSummary })
      .mockResolvedValueOnce({ status: "ok", data: taskUpdatedSummary })
      .mockResolvedValue({ status: "ok", data: runUpdatedSummary });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
    });
    const initialCallCount = vi.mocked(commands.getPipelineSummary).mock.calls
      .length;

    emitEvent("taskChanged", {
      task_id: "task-1",
      change_type: "Updated",
      task: null,
    });

    await waitFor(() => {
      expect(screen.getByTitle("1 task(s)")).toBeInTheDocument();
    });
    const afterTaskEventCallCount = vi.mocked(commands.getPipelineSummary).mock
      .calls.length;
    expect(afterTaskEventCallCount).toBeGreaterThan(initialCallCount);

    emitEvent("taskRunChanged", {
      task_run_id: "run-1",
      task_id: "task-1",
      status: "executing",
      change_type: "Updated",
      task_run: null,
      run_controls: null,
    });

    await waitFor(() => {
      expect(screen.getByTitle("1 active")).toBeInTheDocument();
    });
    expect(
      vi.mocked(commands.getPipelineSummary).mock.calls.length,
    ).toBeGreaterThan(afterTaskEventCallCount);
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
});
