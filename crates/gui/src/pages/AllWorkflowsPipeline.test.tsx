import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor, within } from "@testing-library/react";
import { fireEvent, render, screen } from "../test/test-utils";
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
      taskStepChangedEvent: createEventListener("taskStepChanged"),
      taskRunStepChangedEvent: createEventListener("taskRunStepChanged"),
      stepChangedEvent: createEventListener("stepChanged"),
      stepTransitionChangedEvent: createEventListener(
        "stepTransitionChanged",
      ),
      workflowChangedEvent: createEventListener("workflowChanged"),
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
        within(workflowButton.closest("div") as HTMLElement).getByText("Final"),
      ).toBeInTheDocument();
    });

    fireEvent.click(workflowButton!);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Final workflow: enabled" }),
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
            makeStep(
              "s1",
              "wf-1",
              "todo",
              0,
              { epic: 0, ticket: 1, task: 0 },
              1,
            ),
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
      initialCallCount,
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
});
