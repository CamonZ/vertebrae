import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineStep,
  PipelineSummary,
  PipelineWorkflow,
  Step,
} from "../../../bindings";
import { buildAtlasModel } from "../adapter/buildAtlasModel";
import { StepInspector } from "./StepInspector";
import { WorkflowInspector } from "./WorkflowInspector";
import type { AtlasSelection } from "./selection";

/* `useStep` (from the hooks barrel) hits the Tauri bridge — mock it. */
vi.mock("../../../hooks", () => ({ useStep: vi.fn() }));
import { useStep } from "../../../hooks";

/* ── fixtures ──────────────────────────────────────────────────── */

function makeStep(
  id: string,
  workflowId: string,
  order: number,
  overrides: Partial<PipelineStep> = {}
): PipelineStep {
  return {
    id,
    name: id,
    workflow_id: workflowId,
    goal: null,
    step_order: order,
    step_type: "execute",
    transitions_to: [],
    task_counts: { epic: 0, ticket: 0, task: 0 },
    pipeline_counts: { epic: 0, ticket: 0, task: 0, active: 0 },
    active_count: 0,
    ...overrides,
  };
}

function makeWorkflow(
  id: string,
  steps: PipelineStep[],
  overrides: Partial<PipelineWorkflow> = {}
): PipelineWorkflow {
  return {
    id,
    name: id,
    description: null,
    initial_step_id: steps[0]?.id ?? null,
    kanban_column: null,
    is_default: false,
    display_order: 0,
    workflow_steps: steps,
    transitions: [],
    ...overrides,
  };
}

const SUMMARY: PipelineSummary = {
  workflows: [
    makeWorkflow(
      "wf-build",
      [
        makeStep("s1", "wf-build", 0, {
          name: "Plan",
          // total = ticket + task = 1 + 2 = 3; running = 1
          pipeline_counts: { epic: 0, ticket: 1, task: 2, active: 1 },
        }),
        makeStep("s2", "wf-build", 1, {
          name: "Execute",
          transitions_to: ["s1"], // backward → loop
        }),
        makeStep("s3", "wf-build", 2, {
          name: "Ship",
          step_type: "route",
        }),
      ],
      { kanban_column: "Build", description: "Builds things." }
    ),
    makeWorkflow(
      "wf-review",
      [makeStep("r1", "wf-review", 0, { name: "Review" })],
      { kanban_column: "Review" }
    ),
  ],
};
// cross-workflow handoff wf-build → wf-review (declared on the source workflow).
SUMMARY.workflows[0].transitions = [
  {
    id: "t1",
    from_workflow_id: "wf-build",
    to_workflow_id: "wf-review",
    target_step_id: "r1",
    label: "approved",
  },
];

const MODEL = buildAtlasModel(SUMMARY);
const STOP_MODEL = buildAtlasModel({
  workflows: [
    makeWorkflow("wf-stop", [
      makeStep("pause", "wf-stop", 0, {
        name: "Pause run",
        step_type: "stop",
        transitions_to: ["next"],
      }),
      makeStep("next", "wf-stop", 1, { name: "Continue" }),
    ]),
  ],
});

const stepFixture = (overrides: Partial<Step> = {}): Step => ({
  id: "s1",
  name: "Plan",
  workflow_id: "wf-build",
  goal: "Lay out the plan",
  prompt: "Plan for {{ task.title }}",
  agents: ["planner"],
  skills: ["estimate"],
  agent_config: {
    model: "claude-opus",
    codex_model_provider: null,
    fallback_model: null,
    reasoning_effort: null,
    system_prompt: null,
    append_system_prompt: null,
    agents: null,
    permission_mode: null,
    max_budget_usd: null,
    json_schema: null,
  },
  step_type: "execute",
  transitions_to: [],
  order: 0,
  created_at: null,
  updated_at: null,
  ...overrides,
});

function mockUseStep(step: Step | null, isLoading = false) {
  vi.mocked(useStep).mockReturnValue({
    step,
    isLoading,
    error: null,
    refetch: vi.fn(),
    applyUpdate: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseStep(stepFixture());
});

describe("WorkflowInspector", () => {
  it("renders the workflow's name, phase, step list, and routes", () => {
    const { container } = render(
      <WorkflowInspector
        model={MODEL}
        workflowId="wf-build"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("wf-build")).toBeInTheDocument();
    expect(screen.getByText("Builds things.")).toBeInTheDocument();
    // step list (kind-colored buttons) — scoped, since step names also appear in
    // the loop-back row now that loop-backs render step names (not uuids).
    const stepList = container.querySelector(".wfd-steps") as HTMLElement;
    expect(within(stepList).getByText("Plan")).toBeInTheDocument();
    expect(within(stepList).getByText("Execute")).toBeInTheDocument();
    expect(within(stepList).getByText("Ship")).toBeInTheDocument();
    // task counts: 3 parked, 1 running (s1 carries ticket 1 + task 2, active 1)
    expect(screen.getByText("3 · 1")).toBeInTheDocument();
    expect(screen.getByText("1 running")).toBeInTheDocument();
    // routes out section names the target workflow
    expect(screen.getByText("wf-review")).toBeInTheDocument();
    // loop-back surfaced (sub line + section label)
    expect(screen.getAllByText(/loop-back/i).length).toBeGreaterThan(0);
    // loop-back row shows step NAMES (Execute → Plan), never a raw uuid
    const loopRow = container.querySelector(".wfd-tr.loop") as HTMLElement;
    expect(loopRow.textContent).toContain("Execute");
    expect(loopRow.textContent).toContain("Plan");
    expect(loopRow.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    // carries the kindspine + data-no-pan
    const root = document.querySelector(".wfd.kindspine");
    expect(root).toHaveAttribute("data-no-pan");
  });

  it("walks the topology: clicking a step row selects that step", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <WorkflowInspector
        model={MODEL}
        workflowId="wf-build"
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );

    const stepList = container.querySelector(".wfd-steps") as HTMLElement;
    fireEvent.click(within(stepList).getByText("Execute"));
    expect(onSelect).toHaveBeenCalledWith({
      type: "step",
      workflowId: "wf-build",
      stepId: "s2",
    });
  });

  it("walks the topology: clicking an out-route selects the target workflow", () => {
    const onSelect = vi.fn();
    render(
      <WorkflowInspector
        model={MODEL}
        workflowId="wf-build"
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("wf-review"));
    expect(onSelect).toHaveBeenCalledWith({
      type: "workflow",
      workflowId: "wf-review",
    });
  });

  it("renders a close button that invokes onClose", () => {
    const onClose = vi.fn();
    render(
      <WorkflowInspector
        model={MODEL}
        workflowId="wf-build"
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("emits onHoverEdge with the edge id on enter and null on leave", () => {
    const onHoverEdge = vi.fn();
    render(
      <WorkflowInspector
        model={MODEL}
        workflowId="wf-build"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onHoverEdge={onHoverEdge}
      />
    );
    // the single out-route row → wf-review
    const row = screen.getByText("wf-review").closest("button")!;
    fireEvent.mouseEnter(row);
    expect(onHoverEdge).toHaveBeenCalledTimes(1);
    const edgeId = onHoverEdge.mock.calls[0][0];
    expect(typeof edgeId).toBe("string");
    // it names a real model edge
    expect(MODEL.edges.some((e) => e.id === edgeId)).toBe(true);

    fireEvent.mouseLeave(row);
    expect(onHoverEdge).toHaveBeenLastCalledWith(null);
  });

  it("shows a 'default' badge only for the default workflow", () => {
    // MODEL's workflows are not default → no badge.
    const { rerender } = render(
      <WorkflowInspector
        model={MODEL}
        workflowId="wf-build"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByText("default")).not.toBeInTheDocument();

    const defaultModel = buildAtlasModel({
      workflows: [
        makeWorkflow(
          "wf-def",
          [makeStep("s1", "wf-def", 0, { name: "Plan" })],
          { is_default: true, kanban_column: "Build" }
        ),
      ],
    });
    rerender(
      <WorkflowInspector
        model={defaultModel}
        workflowId="wf-def"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("default")).toBeInTheDocument();
  });

});

describe("StepInspector", () => {
  it("renders goal, prompt, agents, skills, model, and transitions from useStep", () => {
    render(
      <StepInspector
        model={MODEL}
        workflowId="wf-build"
        stepId="s1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Lay out the plan")).toBeInTheDocument();
    // prompt rendered via LiquidHighlight
    expect(screen.getByTestId("liquid-highlight")).toBeInTheDocument();
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.getByText("estimate")).toBeInTheDocument();
    expect(screen.getByText("claude-opus")).toBeInTheDocument();
    // task counts in the overview: 3 parked, 1 running
    expect(screen.getByText("Tasks parked")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(document.querySelector(".wfd-status.live")).toBeInTheDocument();
    // implicit forward transition to the next step
    expect(screen.getByText("Execute")).toBeInTheDocument();
    // carries the kind carrier + data-no-pan
    const root = document.querySelector(".wfd.kindspine");
    expect(root).toHaveAttribute("data-no-pan");
    expect(root).toHaveClass("k-execute"); // s1's real backend step type
  });

  it("shows placeholders when config is absent", () => {
    mockUseStep(
      stepFixture({ goal: null, prompt: null, agents: [], skills: [] })
    );
    render(
      <StepInspector
        model={MODEL}
        workflowId="wf-build"
        stepId="s1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("No goal set")).toBeInTheDocument();
    expect(screen.getByText("No prompt")).toBeInTheDocument();
    expect(screen.getByText("No agents")).toBeInTheDocument();
    expect(screen.getByText("No skills")).toBeInTheDocument();
    expect(screen.getByText("No output schema")).toBeInTheDocument();
  });

  it("renders the structured output schema tree when present", () => {
    mockUseStep(
      stepFixture({
        output_schema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
      })
    );
    render(
      <StepInspector
        model={MODEL}
        workflowId="wf-build"
        stepId="s1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Output Schema")).toBeInTheDocument();
    expect(screen.getByTestId("schema-tree")).toBeInTheDocument();
    expect(screen.getByTestId("schema-node-verdict")).toBeInTheDocument();
  });

  it("walks the topology: clicking the forward transition selects the next step", () => {
    const onSelect = vi.fn();
    render(
      <StepInspector
        model={MODEL}
        workflowId="wf-build"
        stepId="s1"
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("Execute"));
    expect(onSelect).toHaveBeenCalledWith({
      type: "step",
      workflowId: "wf-build",
      stepId: "s2",
    });
  });

  it("names the loop-back target step instead of showing its raw id", () => {
    const onSelect = vi.fn();
    // s2 (Execute) loops back to s1 (Plan). The chip must read "Plan", not "s1".
    render(
      <StepInspector
        model={MODEL}
        workflowId="wf-build"
        stepId="s2"
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );
    const loopChip = document.querySelector(
      ".wfd-trans.loop"
    ) as HTMLElement | null;
    expect(loopChip).not.toBeNull();
    expect(loopChip!.textContent).toContain("Plan");
    expect(loopChip!.textContent).not.toContain("s1");
    // and clicking it walks to the named step
    fireEvent.click(loopChip!);
    expect(onSelect).toHaveBeenCalledWith({
      type: "step",
      workflowId: "wf-build",
      stepId: "s1",
    });
  });

  it("renders a close button that invokes onClose", () => {
    const onClose = vi.fn();
    render(
      <StepInspector
        model={MODEL}
        workflowId="wf-build"
        stepId="s1"
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders stop as a run boundary with one explicit continuation", () => {
    mockUseStep(
      stepFixture({
        id: "pause",
        name: "Pause run",
        step_type: "stop",
        prompt: null,
        transitions_to: ["next"],
      })
    );
    render(
      <StepInspector
        model={STOP_MODEL}
        workflowId="wf-stop"
        stepId="pause"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const root = document.querySelector(".wfd.kindspine");
    expect(root).toHaveClass("k-stop");
    expect(screen.queryByText("Run boundary")).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal step")).not.toBeInTheDocument();
    expect(
      screen.getByText("No prompt — run boundary is not dispatched")
    ).toBeInTheDocument();
    expect(screen.getByText("Continue")).toBeInTheDocument();
  });
});

/** type guard sanity: selection union compiles. */
const _sel: AtlasSelection = { type: "workflow", workflowId: "x" };
void _sel;
