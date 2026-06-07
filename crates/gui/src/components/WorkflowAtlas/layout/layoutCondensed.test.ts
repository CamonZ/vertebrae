import { describe, expect, it } from "vitest";
import { layoutCondensed } from "./layoutCondensed";
import type {
  AtlasEdge,
  AtlasModel,
  AtlasPhase,
  AtlasStep,
  AtlasWorkflow,
  CondensedLayout,
  Point,
} from "./types";

/* ── fixtures ──────────────────────────────────────────────────── */

function wf(
  id: string,
  phase: string,
  displayOrder: number,
  stepIds: string[],
): AtlasWorkflow {
  return {
    id,
    name: id,
    description: null,
    initialStepId: stepIds[0] ?? null,
    phase,
    displayOrder,
    isDefault: false,
    isFinal: false,
    stepIds,
    total: 0,
    running: 0,
  };
}

function step(id: string, workflowId: string, order: number): AtlasStep {
  return {
    id: `${workflowId}.${id}`,
    stepId: id,
    workflowId,
    name: id,
    kind: "execute",
    role: "process",
    order,
    transitionsTo: [],
    isFinal: false,
    total: 0,
    running: 0,
  };
}

function crossEdge(
  fromWf: string,
  fromStep: string,
  toWf: string,
  toStep: string,
  label: string | null = null,
): AtlasEdge {
  return {
    id: `${fromWf}.${fromStep}->${toWf}.${toStep}`,
    kind: "cross",
    from: `${fromWf}.${fromStep}`,
    to: `${toWf}.${toStep}`,
    fromWorkflow: fromWf,
    toWorkflow: toWf,
    label,
  };
}

function phasesFromWorkflows(workflows: AtlasWorkflow[]): AtlasPhase[] {
  const order: string[] = [];
  for (const w of workflows) if (!order.includes(w.phase)) order.push(w.phase);
  return order.map((name, index) => ({
    index,
    name,
    members: workflows.filter((w) => w.phase === name).map((w) => w.id),
  }));
}

function model(
  workflows: AtlasWorkflow[],
  steps: AtlasStep[],
  edges: AtlasEdge[],
): AtlasModel {
  return { workflows, steps, edges, phases: phasesFromWorkflows(workflows) };
}

/** A three-column model: Plan | Build | Ship, one workflow each, chained. */
function threeColumnModel(): AtlasModel {
  const workflows = [
    wf("plan", "Plan", 0, ["p1"]),
    wf("build", "Build", 1, ["b1"]),
    wf("ship", "Ship", 2, ["s1"]),
  ];
  const steps = [
    step("p1", "plan", 0),
    step("b1", "build", 0),
    step("s1", "ship", 0),
  ];
  const edges = [
    crossEdge("plan", "p1", "build", "b1", "ready"),
    crossEdge("build", "b1", "ship", "s1", "approved"),
  ];
  return model(workflows, steps, edges);
}

function everyPoint(layout: CondensedLayout): Point[] {
  const pts: Point[] = [];
  for (const n of layout.nodes) {
    pts.push({ x: n.x, y: n.y }, { x: n.cx, y: n.cy });
  }
  for (const e of layout.edges) {
    pts.push(...e.points);
    if (e.labelPos) pts.push(e.labelPos);
  }
  for (const c of layout.columns) pts.push({ x: c.x, y: c.top });
  return pts;
}

function assertNoNaN(layout: CondensedLayout): void {
  expect(Number.isNaN(layout.width)).toBe(false);
  expect(Number.isNaN(layout.height)).toBe(false);
  for (const p of everyPoint(layout)) {
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
  }
}

/* ── columns ───────────────────────────────────────────────────── */

describe("layoutCondensed — columns", () => {
  it("produces one column per phase in declared order", () => {
    const out = layoutCondensed(threeColumnModel());
    expect(out.columns.map((c) => c.phase)).toEqual(["Plan", "Build", "Ship"]);
    expect(out.columns.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("places each workflow in its phase's column", () => {
    const out = layoutCondensed(threeColumnModel());
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("plan")!.col).toBe(0);
    expect(byId.get("build")!.col).toBe(1);
    expect(byId.get("ship")!.col).toBe(2);
    // column x increases left → right
    expect(byId.get("plan")!.x).toBeLessThan(byId.get("build")!.x);
    expect(byId.get("build")!.x).toBeLessThan(byId.get("ship")!.x);
  });

  it("drops phases with no members from the column list", () => {
    const workflows = [wf("a", "Plan", 0, ["a1"])];
    const steps = [step("a1", "a", 0)];
    const m: AtlasModel = {
      workflows,
      steps,
      edges: [],
      phases: [
        { index: 0, name: "Plan", members: ["a"] },
        { index: 1, name: "Ghost", members: [] },
      ],
    };
    const out = layoutCondensed(m);
    expect(out.columns.map((c) => c.phase)).toEqual(["Plan"]);
  });
});

/* ── vertical centring ─────────────────────────────────────────── */

describe("layoutCondensed — vertical centring", () => {
  it("centres a short column against the tallest column", () => {
    // col A has 3 members, col B has 1 → B is centred vertically against A.
    const workflows = [
      wf("a1", "A", 0, ["s"]),
      wf("a2", "A", 1, ["s"]),
      wf("a3", "A", 2, ["s"]),
      wf("b1", "B", 0, ["s"]),
    ];
    const steps = workflows.map((w) => step("s", w.id, 0));
    const out = layoutCondensed(model(workflows, steps, []));
    const byId = new Map(out.nodes.map((n) => [n.id, n]));

    const colA = [byId.get("a1")!, byId.get("a2")!, byId.get("a3")!];
    const aTop = Math.min(...colA.map((n) => n.y));
    const aBot = Math.max(...colA.map((n) => n.y + n.h));
    const aCentre = (aTop + aBot) / 2;

    const b = byId.get("b1")!;
    expect(b.cy).toBeCloseTo(aCentre);
  });

  it("stacks members in display order within a column", () => {
    const workflows = [
      wf("second", "A", 1, ["s"]),
      wf("first", "A", 0, ["s"]),
    ];
    const steps = workflows.map((w) => step("s", w.id, 0));
    const out = layoutCondensed(model(workflows, steps, []));
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("first")!.y).toBeLessThan(byId.get("second")!.y);
  });
});

/* ── router lanes ──────────────────────────────────────────────── */

describe("layoutCondensed — router", () => {
  it("routes an adjacent forward edge through the gap bus (4 points)", () => {
    const out = layoutCondensed(threeColumnModel());
    const e = out.edges.find((x) => x.from === "plan" && x.to === "build")!;
    expect(e.points).toHaveLength(4);
    // gap bus x sits between the two columns
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    const busX = e.points[1].x;
    expect(busX).toBeGreaterThan(byId.get("plan")!.right);
    expect(busX).toBeLessThan(byId.get("build")!.left);
  });

  it("routes a distant forward edge through the top corridor (6 points)", () => {
    const m = threeColumnModel();
    m.edges.push(crossEdge("plan", "p1", "ship", "s1", "skip"));
    m.phases = phasesFromWorkflows(m.workflows);
    const out = layoutCondensed(m);
    const e = out.edges.find((x) => x.from === "plan" && x.to === "ship")!;
    expect(e.points).toHaveLength(6);
    // the corridor lane is above the cards (small y)
    const minNodeY = Math.min(...out.nodes.map((n) => n.y));
    const laneY = e.points[2].y;
    expect(laneY).toBeLessThan(minNodeY);
  });

  it("routes a backward edge through the bottom corridor (6 points)", () => {
    const m = threeColumnModel();
    m.edges.push(crossEdge("ship", "s1", "plan", "p1", "reject"));
    m.phases = phasesFromWorkflows(m.workflows);
    const out = layoutCondensed(m);
    const e = out.edges.find((x) => x.from === "ship" && x.to === "plan")!;
    expect(e.points).toHaveLength(6);
    const maxNodeBottom = Math.max(...out.nodes.map((n) => n.y + n.h));
    const laneY = e.points[2].y;
    expect(laneY).toBeGreaterThan(maxNodeBottom);
  });

  it("routes a same-column edge through the left side-bus (4 points)", () => {
    const workflows = [
      wf("a1", "A", 0, ["s"]),
      wf("a2", "A", 1, ["s"]),
    ];
    const steps = workflows.map((w) => step("s", w.id, 0));
    const edges = [crossEdge("a1", "s", "a2", "s", "loop")];
    const out = layoutCondensed(model(workflows, steps, edges));
    const e = out.edges[0];
    expect(e.points).toHaveLength(4);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    // bus sits to the left of the column
    expect(e.points[1].x).toBeLessThan(byId.get("a1")!.left);
  });

  it("assigns distinct lanes to multiple same-column edges", () => {
    const workflows = [
      wf("a1", "A", 0, ["s"]),
      wf("a2", "A", 1, ["s"]),
      wf("a3", "A", 2, ["s"]),
    ];
    const steps = workflows.map((w) => step("s", w.id, 0));
    const edges = [
      crossEdge("a1", "s", "a2", "s"),
      crossEdge("a2", "s", "a3", "s"),
    ];
    const out = layoutCondensed(model(workflows, steps, edges));
    const busXs = out.edges.map((e) => e.points[1].x);
    expect(new Set(busXs).size).toBe(busXs.length);
  });

  it("aggregates duplicate workflow→workflow labels distinctly", () => {
    const workflows = [
      wf("plan", "Plan", 0, ["p1", "p2"]),
      wf("build", "Build", 1, ["b1"]),
    ];
    const steps = [
      step("p1", "plan", 0),
      step("p2", "plan", 1),
      step("b1", "build", 0),
    ];
    const edges = [
      crossEdge("plan", "p1", "build", "b1", "fast"),
      crossEdge("plan", "p2", "build", "b1", "slow"),
      crossEdge("plan", "p1", "build", "b1", "fast"), // duplicate label
    ];
    const out = layoutCondensed(model(workflows, steps, edges));
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].labels).toEqual(["fast", "slow"]);
  });
});

/* ── determinism & no-NaN ──────────────────────────────────────── */

describe("layoutCondensed — determinism", () => {
  it("produces identical geometry across runs", () => {
    const a = layoutCondensed(threeColumnModel());
    const b = layoutCondensed(threeColumnModel());
    expect(a).toEqual(b);
  });

  it("never emits NaN coordinates", () => {
    const m = threeColumnModel();
    m.edges.push(crossEdge("plan", "p1", "ship", "s1")); // distant
    m.edges.push(crossEdge("ship", "s1", "plan", "p1")); // backward
    m.phases = phasesFromWorkflows(m.workflows);
    assertNoNaN(layoutCondensed(m));
  });

  it("handles an empty model without NaN", () => {
    const out = layoutCondensed({
      workflows: [],
      steps: [],
      edges: [],
      phases: [],
    });
    expect(out.nodes).toEqual([]);
    expect(out.columns).toEqual([]);
    assertNoNaN(out);
  });
});
