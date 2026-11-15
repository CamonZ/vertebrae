import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PipelineSummary } from "../../../bindings";
import {
  step,
  workflow,
} from "../../WorkflowAtlas/adapter/machineFlow.fixture";
import { buildMachineFlow } from "../../WorkflowAtlas/adapter/buildMachineFlow";
import { compileFlowOrThrow, type CompiledFlow } from "./compile";
import { layoutFlowComposite } from "./composite";
import { partExtent, type Box } from "./extent";
import { layoutFrom, resetLayoutCache } from "./layout";
import { setLayoutStore, type LayoutStore } from "./layoutStore";
import type { FlowSpec } from "./spec";

const pipeline = (names: readonly string[], extra = 0): PipelineSummary => {
  const workflows = names.map((name, w) =>
    workflow(
      name,
      Array.from({ length: 3 + (w === 1 ? extra : 0) }, (_, i) =>
        step(`${name}${i}`, i === 2 ? "finish" : "llm_inference", i)
      )
    )
  );
  // a → b → c → a: handoffs in both directions between boxes.
  return {
    workflows: workflows.map((wf, i) => ({
      ...wf,
      transitions: [
        {
          id: `h${i}`,
          from_workflow_id: wf.id,
          to_workflow_id: workflows[(i + 1) % workflows.length].id,
          target_step_id: null,
          label: `handoff ${i}`,
        },
      ],
    })),
  };
};

const specOf = (summary: PipelineSummary): FlowSpec =>
  buildMachineFlow(summary).spec;

const laidOut = async (spec: FlowSpec) => {
  const first = compileFlowOrThrow(spec);
  const layout = await layoutFlowComposite(first);
  return {
    layout,
    flow: compileFlowOrThrow(spec, { layout: layoutFrom(layout) }),
  };
};

const inside = (b: Box, [x, y]: readonly [number, number]) =>
  b.x0 + 0.5 < x && x < b.x1 - 0.5 && b.y0 + 0.5 < y && y < b.y1 - 0.5;

/** Whether an axis-aligned segment passes through the interior of a box. */
const cuts = (b: Box, a: readonly number[], c: readonly number[]) => {
  const [x0, x1] = [Math.min(a[0], c[0]), Math.max(a[0], c[0])];
  const [y0, y1] = [Math.min(a[1], c[1]), Math.max(a[1], c[1])];
  return x0 < b.x1 - 0.5 &&
    b.x0 + 0.5 < x1 + 0.01 &&
    y0 < b.y1 - 0.5 &&
    b.y0 + 0.5 < y1 + 0.01
    ? x0 === x1
      ? b.x0 + 0.5 < x0 && x0 < b.x1 - 0.5
      : b.y0 + 0.5 < y0 && y0 < b.y1 - 0.5
    : false;
};

describe("composite layout", () => {
  beforeEach(() => resetLayoutCache());
  afterEach(() => setLayoutStore(undefined));

  it("places every workflow region apart and routes every rail around parts", async () => {
    const spec = specOf(pipeline(["a", "b", "c"]));
    const { layout, flow } = await laidOut(spec);
    const d: CompiledFlow["arrangements"][0] = flow.arrangements[0];
    expect(Object.keys(layout.routes ?? {}).sort()).toEqual(
      d.rails.map((r) => r.id).sort()
    );
    // Regions never overlap.
    for (const [i, g] of d.regions.entries())
      for (const h of d.regions.slice(i + 1))
        expect(
          g.x + g.width <= h.x ||
            h.x + h.width <= g.x ||
            g.y + g.height <= h.y ||
            h.y + h.height <= g.y
        ).toBe(true);
    const handoffs = d.rails.filter((r) => r.id.startsWith("atlas_7_"));
    expect(handoffs).toHaveLength(3);
    for (const r of handoffs) {
      const points = r.points;
      for (const [k, p] of points.slice(1).entries()) {
        const q = points[k];
        // Orthogonal.
        expect(
          Math.abs(p[0] - q[0]) < 0.01 || Math.abs(p[1] - q[1]) < 0.01
        ).toBe(true);
      }
      // Between the stubs at its ports, a handoff crosses no part.
      for (const part of d.parts) {
        const box = partExtent(part);
        for (let k = 2; k < points.length - 2; k++)
          expect(cuts(box, points[k - 1], points[k])).toBe(false);
        for (const p of points.slice(2, -2)) expect(inside(box, p)).toBe(false);
      }
    }
  });

  it("docks each workflow's endpoint on the east edge of its steps", async () => {
    const { flow } = await laidOut(specOf(pipeline(["a", "b", "c"])));
    const d = flow.arrangements[0];
    const byId = new Map(d.parts.map((p) => [p.id, p]));
    for (const region of d.regions) {
      const [endpoint, ...steps] = region.parts.map((id) => byId.get(id)!);
      const handle = partExtent(endpoint);
      const east = Math.max(...steps.map((p) => partExtent(p).x1));
      expect(handle.x0).toBeGreaterThan(east);
      expect(endpoint.scale).toBeLessThan(1);
    }
  });

  it("relays out only the edited workflow and reuses stored layouts", async () => {
    const stored = new Map<string, unknown>();
    let writes = 0;
    const store: LayoutStore = {
      get: async (id) => stored.get(id) as never,
      put: async (id, layout) => {
        writes++;
        stored.set(id, layout);
      },
    };
    setLayoutStore(store);
    await laidOut(specOf(pipeline(["a", "b", "c"])));
    // three workflows and the composition
    await expect.poll(() => writes).toBe(4);

    // A cold process (fresh memory) finds everything in the store.
    resetLayoutCache();
    writes = 0;
    const again = await laidOut(specOf(pipeline(["a", "b", "c"])));
    expect(writes).toBe(0);
    expect(again.layout.positions).toBeDefined();

    // Adding a step to b lays out b and the composition only.
    resetLayoutCache();
    await laidOut(specOf(pipeline(["a", "b", "c"], 1)));
    await expect.poll(() => writes).toBe(2);
  });

  it("matches the single-level layout for a flow without regions", async () => {
    const spec: FlowSpec = {
      version: 1,
      parts: [
        { id: "a", kind: "worker" },
        { id: "b", kind: "store" },
      ],
      rails: [{ id: "r", from: "b.out", to: "a.in" }],
    };
    const { layout } = await laidOut(spec);
    expect(Object.keys(layout.positions).sort()).toEqual(["a", "b"]);
  });
});
