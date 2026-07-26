import { describe, expect, it } from "vitest";
import type {
  PipelineStep,
  PipelineSummary,
  PipelineWorkflow,
  PipelineWorkflowTransition,
} from "../../../bindings";
import { UNPHASED } from "../layout/types";
import { buildAtlasModel, kindFor, roleFor, stepRef } from "./buildAtlasModel";

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
    is_final: false,
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
    is_final: false,
    display_order: 0,
    workflow_steps: steps,
    transitions: [],
    ...overrides,
  };
}

function makeTransition(
  overrides: Partial<PipelineWorkflowTransition> &
    Pick<PipelineWorkflowTransition, "from_workflow_id" | "to_workflow_id">
): PipelineWorkflowTransition {
  return {
    id: `${overrides.from_workflow_id}->${overrides.to_workflow_id}`,
    target_step_id: null,
    label: "",
    ...overrides,
  };
}

/* ── kindFor / roleFor ─────────────────────────────────────────── */

describe("kindFor", () => {
  it("maps StepType through the Atlas vocabulary", () => {
    const cases: Array<[string | null, string]> = [
      ["execute", "execute"],
      ["evaluate", "eval"],
      ["wait_children", "wait"],
      ["human_input", "human"],
      ["route", "route"],
      ["finish", "finish"],
      [null, "execute"],
      ["totally-unknown", "execute"],
    ];
    for (const [type, expected] of cases) {
      expect(kindFor({ step_type: type })).toBe(expected);
    }
  });

  it("maps the real type even for initial / final steps (no synthetic kinds)", () => {
    // entry/final are NOT kinds — the real backend type always wins.
    expect(kindFor({ step_type: "route" })).toBe("route");
    expect(kindFor({ step_type: "execute" })).toBe("execute");
  });
});

describe("roleFor", () => {
  it("labels the first step entry", () => {
    expect(roleFor("execute", true, false)).toBe("entry");
  });
  it("labels route / terminal steps exit", () => {
    expect(roleFor("route", false, false)).toBe("exit");
    expect(roleFor("execute", false, true)).toBe("exit");
    expect(roleFor("finish", false, false)).toBe("exit");
  });
  it("labels everything else process", () => {
    expect(roleFor("execute", false, false)).toBe("process");
    expect(roleFor("eval", false, false)).toBe("process");
  });
});

/* ── buildAtlasModel ───────────────────────────────────────────── */

describe("buildAtlasModel", () => {
  it("derives step kinds with the right precedence and roles", () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow(
          "wf",
          [
            makeStep("entry", "wf", 0),
            makeStep("ai", "wf", 1, { step_type: "execute" }),
            makeStep("gate", "wf", 2, { step_type: "evaluate" }),
            makeStep("router", "wf", 3, { step_type: "route" }),
            makeStep("done", "wf", 4, { step_type: "finish" }),
          ],
          { initial_step_id: "entry" }
        ),
      ],
    };

    const model = buildAtlasModel(summary);
    const byId = new Map(model.steps.map((s) => [s.stepId, s]));

    // kind is always the REAL backend step type — the initial step ("entry")
    // and the terminal step ("done") both keep their real backend type.
    expect(byId.get("entry")!.kind).toBe("execute");
    expect(byId.get("ai")!.kind).toBe("execute");
    expect(byId.get("gate")!.kind).toBe("eval");
    expect(byId.get("router")!.kind).toBe("route");
    expect(byId.get("done")!.kind).toBe("finish");
    expect(byId.get("done")!.isFinal).toBe(false);
    expect(byId.get("done")!.role).toBe("exit");
    expect(byId.get("gate")!.stepType).toBe("evaluate");
    expect(byId.get("router")!.stepType).toBe("route");

    // role still carries flow position (first → entry, route/terminal → exit).
    expect(byId.get("entry")!.role).toBe("entry");
    expect(byId.get("ai")!.role).toBe("process");
    expect(byId.get("router")!.role).toBe("exit");
    expect(byId.get("done")!.role).toBe("exit");

    // step ids are globally namespaced refs
    expect(byId.get("entry")!.id).toBe(stepRef("wf", "entry"));
  });

  it("orders phase columns by min member display_order, Unphased last", () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow("u", [makeStep("u1", "u", 0)], {
          kanban_column: null,
          display_order: 1,
        }),
        makeWorkflow("b1", [makeStep("b1s", "b1", 0)], {
          kanban_column: "Build",
          display_order: 5,
        }),
        makeWorkflow("b2", [makeStep("b2s", "b2", 0)], {
          kanban_column: "Build",
          display_order: 3,
        }),
        makeWorkflow("p", [makeStep("p1", "p", 0)], {
          kanban_column: "Plan",
          display_order: 2,
        }),
      ],
    };

    const model = buildAtlasModel(summary);

    // Plan(min=2) before Build(min=3); Unphased always last despite order=1.
    expect(model.phases.map((p) => p.name)).toEqual([
      "Plan",
      "Build",
      UNPHASED,
    ]);
    expect(model.phases.map((p) => p.index)).toEqual([0, 1, 2]);

    // members within a column sorted by display_order
    const build = model.phases.find((p) => p.name === "Build")!;
    expect(build.members).toEqual(["b2", "b1"]);

    // workflows carry their resolved phase
    const wfPhase = new Map(model.workflows.map((w) => [w.id, w.phase]));
    expect(wfPhase.get("u")).toBe(UNPHASED);
    expect(wfPhase.get("p")).toBe("Plan");
  });

  it("treats blank kanban_column as Unphased", () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow("w", [makeStep("s", "w", 0)], { kanban_column: "  " }),
      ],
    };
    expect(buildAtlasModel(summary).workflows[0].phase).toBe(UNPHASED);
  });

  it("emits loop-back edges but never forward intra links", () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow(
          "wf",
          [
            makeStep("a", "wf", 0, { transitions_to: ["b"] }), // forward
            makeStep("b", "wf", 1, { transitions_to: ["c", "a"] }), // forward + loop
            makeStep("c", "wf", 2, { transitions_to: ["b"] }), // loop
          ],
          { initial_step_id: "a" }
        ),
      ],
    };

    const model = buildAtlasModel(summary);
    const intra = model.edges.filter((e) => e.kind === "loop");

    // only the two backward transitions (b->a, c->b) survive
    const pairs = intra.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual([
      `${stepRef("wf", "b")}->${stepRef("wf", "a")}`,
      `${stepRef("wf", "c")}->${stepRef("wf", "b")}`,
    ]);

    // no forward edges emitted at all
    expect(model.edges.some((e) => e.kind === "forward")).toBe(false);
  });

  it("synthesises cross-workflow edge refs on both ends", () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow(
          "src",
          [
            makeStep("s0", "src", 0),
            makeStep("s1", "src", 1, { step_type: "route" }),
          ],
          {
            initial_step_id: "s0",
            transitions: [
              makeTransition({
                id: "t1",
                from_workflow_id: "src",
                to_workflow_id: "dst",
                target_step_id: "d1",
                label: "approved",
              }),
              makeTransition({
                id: "t2",
                from_workflow_id: "src",
                to_workflow_id: "dst",
                target_step_id: "missing", // invalid → falls back to initial
              }),
              makeTransition({
                id: "t3",
                from_workflow_id: "src",
                to_workflow_id: "ghost", // dangling target → dropped
              }),
            ],
          }
        ),
        makeWorkflow(
          "dst",
          [makeStep("d0", "dst", 0), makeStep("d1", "dst", 1)],
          { initial_step_id: "d0" }
        ),
      ],
    };

    const model = buildAtlasModel(summary);
    const cross = model.edges.filter((e) => e.kind === "cross");

    // dangling target dropped, two remain
    expect(cross).toHaveLength(2);

    const t1 = cross.find((e) => e.id === "X_t1")!;
    // source resolves to the terminal route step s1
    expect(t1.from).toBe(stepRef("src", "s1"));
    // target uses the declared (valid) target_step_id
    expect(t1.to).toBe(stepRef("dst", "d1"));
    expect(t1.fromWorkflow).toBe("src");
    expect(t1.toWorkflow).toBe("dst");
    expect(t1.label).toBe("approved");

    const t2 = cross.find((e) => e.id === "X_t2")!;
    // invalid target_step_id falls back to the target's initial step
    expect(t2.to).toBe(stepRef("dst", "d0"));
    // empty label normalises to null
    expect(t2.label).toBeNull();
  });

  it("derives running from active TaskRuns and drops fake aggregates", () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow("hot", [
          makeStep("h", "hot", 0, {
            pipeline_counts: { epic: 0, ticket: 0, task: 0, active: 2 },
          }),
        ]),
        makeWorkflow("cold", [makeStep("c", "cold", 0)]),
      ],
    };

    const model = buildAtlasModel(summary);
    const running = new Map(model.workflows.map((w) => [w.id, w.running]));
    expect(running.get("hot")).toBe(2);
    expect(running.get("cold")).toBe(0);

    // no runs24h / avg fields — nor the dropped `live` ambient flag — leak in
    expect(model.workflows[0]).not.toHaveProperty("runs24h");
    expect(model.workflows[0]).not.toHaveProperty("avg");
    expect(model.workflows[0]).not.toHaveProperty("live");
  });

  it("totals all work-item levels per step and sums them per workflow", () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow("wf", [
          makeStep("a", "wf", 0, {
            // total = epic + ticket + task = 1 + 2 + 3 = 6; running = 1
            pipeline_counts: { epic: 1, ticket: 2, task: 3, active: 1 },
          }),
          makeStep("b", "wf", 1, {
            // total = 0 + 0 + 4 = 4; running = 2
            pipeline_counts: { epic: 0, ticket: 0, task: 4, active: 2 },
          }),
        ]),
      ],
    };

    const model = buildAtlasModel(summary);

    const stepA = model.steps.find((s) => s.id === "wf.a")!;
    const stepB = model.steps.find((s) => s.id === "wf.b")!;
    expect(stepA.total).toBe(6);
    expect(stepA.running).toBe(1);
    expect(stepB.total).toBe(4);
    expect(stepB.running).toBe(2);

    // workflow rolls up the per-step totals
    const wf = model.workflows[0];
    expect(wf.total).toBe(10);
    expect(wf.running).toBe(3);
  });
});
