/**
 * Property tests of the composite layout (composite.ts), which lays out each
 * workflow region on its own and then places the regions and routes only the
 * handoffs between them. Hegel generates factories — workflows of every step
 * type, transitions inside a workflow (forward, back and onto themselves),
 * handoffs between workflows in both directions with long and short labels —
 * through the same Atlas adapter the Graph uses, and every composed picture
 * must keep the single-level layout's promises plus its own:
 *
 * - no label collides with a part, gate or other label; parts never overlap
 *   and stay on the canvas; every rail is drawn, starts and ends on its
 *   ports, runs orthogonally, never turns back on itself and never cuts
 *   through a part other than its own stub;
 * - regions never overlap and each frames exactly its own parts;
 * - a workflow's own picture does not depend on the others: editing one
 *   workflow leaves every other workflow's parts and inner rails where they
 *   were relative to its region, and recomputes only that workflow and the
 *   composition;
 * - the cache is transparent: a cached layout equals a fresh one.
 */
import { afterEach, beforeEach, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { PipelineSummary, PipelineWorkflow } from "../../../bindings";
import { buildMachineFlow } from "../../WorkflowAtlas/adapter/buildMachineFlow";
import {
  step,
  workflow,
} from "../../WorkflowAtlas/adapter/machineFlow.fixture";
import { compileFlowOrThrow, type DiagramTimeline } from "./compile";
import { layoutFlowComposite, unspiked } from "./composite";
import {
  CROSS_LABEL_SIZE,
  labelCollisions,
  overlaps,
  partExtent,
  partFrame,
  railLabelText,
  regionLabels,
  type Box,
} from "./extent";
import {
  labelBox,
  layoutFrom,
  resetLayoutCache,
  type FlowLayout,
} from "./layout";
import { setLayoutStore, type LayoutStore } from "./layoutStore";
import type { FlowSpec } from "./spec";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

beforeEach(resetLayoutCache);
afterEach(() => setLayoutStore(undefined));

const STEP_TYPES = [
  "llm_inference",
  "structured_inference",
  "execute",
  "human_input",
  "wait_children",
  "stop",
  "finish",
] as const;

const label = gs.oneOf(
  gs.sampledFrom(["ready", "repair", "done", "default"]),
  gs.sampledFrom([
    "intake-planning",
    "review units complete, export the findings",
    "needs attention after repeated failure",
  ])
);

/** One workflow's steps and the transitions between them. */
const steps = (name: string) =>
  gs.composite((tc) => {
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 7 }));
    const list = Array.from({ length: count }, (_, i) =>
      step(
        `${name}${i}`,
        i === count - 1 ? "finish" : tc.draw(gs.sampledFrom(STEP_TYPES)),
        i
      )
    );
    for (const [i, s] of list.entries()) {
      if (i === count - 1) continue;
      const targets = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: count - 1 }), {
          maxSize: 2,
        })
      );
      s.transitions_to = [...new Set([i + 1, ...targets])].map(
        (t) => list[t].id
      );
    }
    return list;
  });

/** A factory: 2–6 workflows and the handoffs between them. */
const factory = gs.composite<PipelineSummary>((tc) => {
  const count = tc.draw(gs.integers({ minValue: 2, maxValue: 6 }));
  const names = Array.from({ length: count }, (_, i) => `w${i}`);
  const workflows: PipelineWorkflow[] = names.map((name) =>
    workflow(name, tc.draw(steps(name)))
  );
  const handoffs = tc.draw(gs.integers({ minValue: 1, maxValue: 10 }));
  for (let h = 0; h < handoffs; h++) {
    const from = tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }));
    const to = tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }));
    if (from === to) continue;
    const target = workflows[to].workflow_steps;
    workflows[from].transitions.push({
      id: `h${h}`,
      from_workflow_id: names[from],
      to_workflow_id: names[to],
      target_step_id: tc.draw(gs.booleans())
        ? null
        : target[
            tc.draw(gs.integers({ minValue: 0, maxValue: target.length - 1 }))
          ].id,
      label: tc.draw(label),
    });
  }
  return { workflows };
});

const specOf = (summary: PipelineSummary): FlowSpec =>
  buildMachineFlow(summary).spec;

async function laidOut(spec: FlowSpec, cache = true) {
  const layout = await layoutFlowComposite(compileFlowOrThrow(spec), {
    cache,
  });
  return {
    layout,
    d: compileFlowOrThrow(spec, { layout: layoutFrom(layout) }).arrangements[0],
  };
}

/**
 * Handoff labels are drawn larger than other rail labels (CROSS_LABEL_SIZE),
 * which `labelCollisions` does not know: check them at their drawn size
 * against every part, region header and other label.
 */
function handoffLabels(d: DiagramTimeline): void {
  const regionOf = new Map(
    d.regions.flatMap((g) => g.parts.map((id) => [id, g.id] as const))
  );
  const labelled = d.rails.flatMap((r) => {
    const text = railLabelText(r);
    if (!text || !r.labelAt) return [];
    const handoff = regionOf.get(r.from.part) !== regionOf.get(r.to.part);
    return [
      {
        id: r.id,
        handoff,
        box: labelBox(r.labelAt, text, handoff ? CROSS_LABEL_SIZE : undefined),
      },
    ];
  });
  const crosses = (a: Box, b: Box) =>
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  for (const [i, l] of labelled.entries()) {
    if (!l.handoff) continue;
    for (const p of d.parts)
      check(
        !crosses(l.box, partFrame(p)),
        `handoff label ${l.id} covers ${p.id}`
      );
    for (const g of d.regions)
      for (const h of regionLabels(g))
        check(
          !crosses(l.box, h),
          `handoff label ${l.id} covers ${g.id}'s header`
        );
    for (const [k, o] of labelled.entries())
      if (k !== i)
        check(
          !crosses(l.box, o.box),
          `handoff label ${l.id} covers label ${o.id}`
        );
  }
}

function geometry(d: DiagramTimeline): void {
  const hit = labelCollisions(d);
  check(hit.length === 0, hit.join("; "));
  handoffLabels(d);
  const boxes = d.parts.map((p) => [p.id, partExtent(p)] as const);
  boxes.forEach(([a, ba], i) => {
    check(
      ba.x0 >= 0 && ba.y0 >= 0 && ba.x1 <= d.width && ba.y1 <= d.height,
      `${a} is outside the ${d.width}×${d.height} canvas`
    );
    for (const [b, bb] of boxes.slice(i + 1))
      check(!overlaps(ba, bb), `parts ${a} and ${b} overlap`);
  });
  for (const r of d.rails) {
    check(r.points.length >= 2, `rail ${r.id} is not drawn`);
    check(
      railLabelText(r) === undefined || r.labelAt != null,
      `rail ${r.id} lost its label "${railLabelText(r)}"`
    );
    const from = d.parts.find((p) => p.id === r.from.part)!.ports[r.from.port];
    const to = d.parts.find((p) => p.id === r.to.part)!.ports[r.to.port];
    const [first, last] = [r.points[0], r.points[r.points.length - 1]];
    check(
      Math.abs(first[0] - from.x) < 0.01 && Math.abs(first[1] - from.y) < 0.01,
      `rail ${r.id} leaves ${first} not its port ${[from.x, from.y]}`
    );
    check(
      Math.abs(last[0] - to.x) < 0.01 && Math.abs(last[1] - to.y) < 0.01,
      `rail ${r.id} arrives at ${last} not its port ${[to.x, to.y]}`
    );
    for (let i = 1; i < r.points.length; i++) {
      const [a, b] = [r.points[i - 1], r.points[i]];
      check(
        Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[1] - b[1]) < 0.01,
        `rail ${r.id} segment ${i} is diagonal`
      );
      const seg = {
        x0: Math.min(a[0], b[0]),
        y0: Math.min(a[1], b[1]),
        x1: Math.max(a[0], b[0]),
        y1: Math.max(a[1], b[1]),
      };
      for (const p of d.parts) {
        const ownStub =
          (i === 1 && p.id === r.from.part) ||
          (i === r.points.length - 1 && p.id === r.to.part);
        if (ownStub) continue;
        const f = partFrame(p);
        check(
          !(seg.x0 < f.x1 && f.x0 < seg.x1 && seg.y0 < f.y1 && f.y0 < seg.y1),
          `rail ${r.id} cuts through ${p.id}`
        );
      }
    }
    for (let i = 2; i < r.points.length; i++) {
      const [a, b, c] = [r.points[i - 2], r.points[i - 1], r.points[i]];
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      check(dot > -1, `rail ${r.id} turns back on itself at ${b}`);
    }
  }
  for (const [i, g] of d.regions.entries()) {
    for (const h of d.regions.slice(i + 1))
      check(
        g.x + g.width <= h.x ||
          h.x + h.width <= g.x ||
          g.y + g.height <= h.y ||
          h.y + h.height <= g.y,
        `regions ${g.id} and ${h.id} overlap`
      );
    for (const p of d.parts) {
      const e = partExtent(p);
      const inside =
        e.x0 >= g.x - 0.01 &&
        e.y0 >= g.y - 0.01 &&
        e.x1 <= g.x + g.width + 0.01 &&
        e.y1 <= g.y + g.height + 0.01;
      check(
        inside === g.parts.includes(p.id),
        `region ${g.id} ${inside ? "frames" : "misses"} part ${p.id}`
      );
    }
  }
}

/**
 * Stored layouts are written after the answer, once the key is hashed: wait
 * for `expected` writes however busy the machine is, then a few more turns
 * of the event loop so an unexpected extra write would show.
 */
async function writesLanded(count: () => number, expected: number) {
  for (let turns = 0; count() < expected && turns < 10_000; turns++)
    await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A workflow's parts and inner rails relative to its region's corner. */
function picture(d: DiagramTimeline, region: string) {
  const g = d.regions.find((r) => r.id === region)!;
  const own = new Set(g.parts);
  const rel = ([x, y]: readonly number[]) =>
    [+(x - g.x).toFixed(2), +(y - g.y).toFixed(2)] as const;
  return JSON.stringify({
    parts: d.parts
      .filter((p) => own.has(p.id))
      .map((p) => [p.id, rel([p.position.x, p.position.y])]),
    rails: d.rails
      .filter((r) => own.has(r.from.part) && own.has(r.to.part))
      .map((r) => [r.id, r.points.map(rel)]),
  });
}

test(
  "composed factories keep every layout promise",
  () =>
    hegel.testAsync(
      async (tc) => {
        resetLayoutCache();
        const { d } = await laidOut(specOf(tc.draw(factory)));
        geometry(d);
      },
      { testCases: 40 }
    ),
  240_000
);

test(
  "editing one workflow moves nothing inside the others and recomputes only it",
  () =>
    hegel.testAsync(
      async (tc) => {
        resetLayoutCache();
        const summary = tc.draw(factory);
        const edited = tc.draw(
          gs.integers({ minValue: 0, maxValue: summary.workflows.length - 1 })
        );
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
        const before = await laidOut(specOf(summary));
        // Every workflow and the composition.
        await writesLanded(() => writes, summary.workflows.length + 1);

        // Add a step before the edited workflow's finish.
        const wf = summary.workflows[edited];
        const added = step(`${wf.id}x`, "execute", wf.workflow_steps.length);
        const next: PipelineSummary = {
          workflows: summary.workflows.map((w, i) =>
            i === edited
              ? {
                  ...w,
                  workflow_steps: [
                    ...w.workflow_steps.map((s, k) =>
                      k === w.workflow_steps.length - 2
                        ? {
                            ...s,
                            transitions_to: [...s.transitions_to, added.id],
                          }
                        : s
                    ),
                    { ...added, workflow_id: w.id },
                  ],
                }
              : w
          ),
        };
        resetLayoutCache();
        writes = 0;
        const after = await laidOut(specOf(next));
        await writesLanded(() => writes, 2);
        check(
          writes === 2,
          `editing one workflow stored ${writes} layouts, not that workflow and the composition`
        );
        for (const g of before.d.regions) {
          if (g.label === wf.name) continue;
          check(
            picture(before.d, g.id) === picture(after.d, g.id),
            `workflow ${g.label} changed inside when ${wf.name} was edited`
          );
        }
        geometry(after.d);
      },
      { testCases: 20 }
    ),
  240_000
);

test(
  "a cached composite layout equals a fresh one",
  () =>
    hegel.testAsync(
      async (tc) => {
        resetLayoutCache();
        const spec = specOf(tc.draw(factory));
        const fresh: FlowLayout = (await laidOut(spec, false)).layout;
        const first = (await laidOut(spec)).layout;
        const again = (await laidOut(spec)).layout;
        check(
          JSON.stringify(first) === JSON.stringify(fresh),
          "the cached layout differs from a fresh one"
        );
        check(
          JSON.stringify(again) === JSON.stringify(fresh),
          "a cache hit differs from a fresh layout"
        );
      },
      { testCases: 15 }
    ),
  240_000
);

test("removing spikes keeps the ends, never turns back, and changes nothing else", () =>
  hegel.test(
    (tc) => {
      // An orthogonal walk with arbitrary reversals.
      const moves = tc.draw(
        gs.arrays(
          gs.tuples(gs.booleans(), gs.integers({ minValue: -5, maxValue: 5 })),
          { minSize: 1, maxSize: 12 }
        )
      );
      const points: [number, number][] = [[0, 0]];
      for (const [vertical, d] of moves) {
        if (d === 0) continue;
        const [x, y] = points[points.length - 1];
        points.push(vertical ? [x, y + d * 10] : [x + d * 10, y]);
      }
      const out = unspiked(points);
      check(
        JSON.stringify(out[0]) === JSON.stringify(points[0]) &&
          JSON.stringify(out[out.length - 1]) ===
            JSON.stringify(points[points.length - 1]),
        "the ends moved"
      );
      for (let i = 2; i < out.length; i++) {
        const [a, b, c] = [out[i - 2], out[i - 1], out[i]];
        const collinear =
          (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
        const dot =
          (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
        check(!(collinear && dot < 0), `turns back at ${b}`);
      }
      for (let i = 1; i < out.length; i++)
        check(
          out[i][0] === out[i - 1][0] || out[i][1] === out[i - 1][1],
          "a diagonal appeared"
        );
      check(
        JSON.stringify(unspiked(out)) === JSON.stringify(out),
        "removing spikes twice changes the route again"
      );
      // Every kept point is one of the route's own points.
      const own = new Set(points.map((p) => JSON.stringify(p)));
      check(
        out.every((p) => own.has(JSON.stringify(p))),
        "a new point appeared"
      );
    },
    { testCases: 500 }
  ));
