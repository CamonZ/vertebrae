import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor, within } from "@testing-library/react";
import { fireEvent, render, screen } from "../test/test-utils";
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
