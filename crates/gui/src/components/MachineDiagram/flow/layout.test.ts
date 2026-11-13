import { sharesBadStretch } from "./layoutTestHelpers";
import { describe, expect, it } from "vitest";
import burstOptions from "./__fixtures__/burstOptions.flow.yaml?raw";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import mechanisms from "./__fixtures__/mechanisms.flow.yaml?raw";
import {
  compileFlowLaidOut,
  compileFlowOrThrow,
  layoutFlow,
  needsAutoLayout,
  parseFlowSpec,
  partExtent,
  partFrame,
  returnRails,
  labelCollisions,
  overlaps,
  type CompiledFlow,
  type FlowSpec,
  type PartSpec,
} from "./index";

const spec = (source: string): FlowSpec => {
  const parsed = parseFlowSpec(source);
  if (!parsed.ok) throw new Error("fixture does not parse");
  return parsed.value as FlowSpec;
};

const withoutPosition = (p: PartSpec): PartSpec => {
  const q = { ...p };
  delete (q as { position?: unknown }).position;
  return q;
};

/** The reference example with every hand-given position removed. */
const unplaced = (s: FlowSpec): FlowSpec => ({
  ...s,
  parts: s.parts.map(withoutPosition),
});

async function laidOut(s: FlowSpec): Promise<CompiledFlow> {
  const r = await compileFlowLaidOut(s);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.flow;
}

const REFERENCE = [
  ["inline discussions", inlineDiscussions],
  ["mechanisms", mechanisms],
  ["three options", burstOptions],
] as const;

describe("auto-layout", () => {
  it("separates rails connected through different shared ports", async () => {
    const flow = await laidOut({
      version: 1,
      parts: [0, 1, 2, 3].map((i) => ({ id: `p${i}`, kind: "aggregator" })),
      rails: [
        { id: "r0", from: "p0.out", to: "p0.in" },
        { id: "r1", from: "p0.out", to: "p1.in" },
        { id: "r2", from: "p3.out", to: "p1.in" },
      ],
    });
    for (const d of flow.arrangements)
      for (const [i, r] of d.rails.entries())
        for (const q of d.rails.slice(i + 1))
          expect(sharesBadStretch(r, q), `${r.id} × ${q.id}`).toBe(false);
  });

  it("keeps a rerouted forward fork orthogonal at fractional port coordinates", async () => {
    const flow = await laidOut({
      version: 1,
      parts: ["aggregator", "event rail", "queue", "aggregator", "alert"].map(
        (kind, i) => ({ id: `p${i}`, kind })
      ),
      rails: [
        { id: "r0", from: "p2.out", to: "p3.in" },
        { id: "r1", from: "p2.out", to: "p4.in", change: "added" },
        { id: "r2", from: "p2.out", to: "p1.in" },
      ],
    });
    for (const d of flow.arrangements)
      for (const [i, r] of d.rails.entries()) {
        for (const q of d.rails.slice(i + 1))
          expect(sharesBadStretch(r, q)).toBe(false);
        for (let j = 1; j < r.points.length; j++) {
          const [a, b] = [r.points[j - 1], r.points[j]];
          expect(
            Math.min(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
          ).toBeLessThan(0.01);
        }
      }
  });

  it("keeps signal-port forks separate without doubling back", async () => {
    const flow = await laidOut({
      version: 1,
      parts: [
        "decider",
        "inference step",
        "failure detector",
        "inference step",
        "version vector",
      ].map((kind, i) => ({ id: `p${i}`, kind })),
      rails: [
        { id: "r0", from: "p1.tools", to: "p1.tools" },
        { id: "r4", from: "p2.status", to: "p1.tools" },
        { id: "r5", from: "p1.tools", to: "p2.heartbeat" },
        { id: "r6", from: "p1.tools", to: "p3.tools" },
      ],
    });
    for (const d of flow.arrangements) {
      for (const [index, r] of d.rails.entries()) {
        for (const q of d.rails.slice(index + 1))
          expect(sharesBadStretch(r, q)).toBe(false);
        for (let i = 2; i < r.points.length; i++) {
          const [a, b, c] = [r.points[i - 2], r.points[i - 1], r.points[i]];
          expect(
            (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]),
            r.id
          ).toBeGreaterThan(-1);
        }
      }
    }
  });

  it("lets a same-port loop fork around forward reservations", async () => {
    const flow = await laidOut({
      version: 1,
      parts: [
        "decider",
        "inference step",
        "approval",
        "approval",
        "approval",
      ].map((kind, i) => ({ id: `p${i}`, kind })),
      rails: [
        { id: "r0", from: "p1.tools", to: "p1.tools" },
        { id: "r1", from: "p3.out", to: "p0.in", change: "added" },
        { id: "r2", from: "p3.out", to: "p1.in" },
      ],
    });
    for (const d of flow.arrangements)
      for (const [index, r] of d.rails.entries()) {
        for (const q of d.rails.slice(index + 1))
          expect(sharesBadStretch(r, q)).toBe(false);
        for (let i = 2; i < r.points.length; i++) {
          const [a, b, c] = [r.points[i - 2], r.points[i - 1], r.points[i]];
          expect(
            (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]),
            r.id
          ).toBeGreaterThan(-1);
        }
      }
  });

  it("separates the generated r2/r3 forward fork after a shared-port chain", async () => {
    const flow = await laidOut({
      version: 1,
      parts: [0, 1, 2, 3].map((i) => ({ id: `p${i}`, kind: "aggregator" })),
      rails: [
        { id: "r0", from: "p0.out", to: "p2.in" },
        { id: "r1", from: "p1.out", to: "p2.in" },
        { id: "r2", from: "p1.out", to: "p0.in" },
        { id: "r3", from: "p1.out", to: "p3.in" },
      ],
    });
    for (const d of flow.arrangements)
      for (const [i, r] of d.rails.entries())
        for (const q of d.rails.slice(i + 1))
          expect(sharesBadStretch(r, q), `${r.id} × ${q.id}`).toBe(false);
  });

  it.each(REFERENCE)(
    "%s: no label overlaps a part, gate or label when laid out",
    async (_name, source) => {
      const flow = await laidOut(unplaced(spec(source)));
      for (const d of flow.arrangements) expect(labelCollisions(d)).toEqual([]);
    }
  );

  it.each(REFERENCE)(
    "%s: every arrangement shares every position and rail",
    async (_name, source) => {
      const flow = await laidOut(unplaced(spec(source)));
      const [first, ...rest] = flow.arrangements;
      for (const d of rest) {
        expect(d.parts.map((p) => [p.id, p.position])).toEqual(
          first.parts.map((p) => [p.id, p.position])
        );
        expect(d.rails.map((r) => [r.id, r.points, r.labelAt])).toEqual(
          first.rails.map((r) => [r.id, r.points, r.labelAt])
        );
        expect([d.width, d.height]).toEqual([first.width, first.height]);
      }
    }
  );

  it("places parts without overlapping extents, flowing left to right", async () => {
    const flow = await laidOut(unplaced(spec(inlineDiscussions)));
    const d = flow.arrangements[1];
    const boxes = d.parts.map((p) => [p.id, partExtent(p)] as const);
    boxes.forEach(([a, ba], i) => {
      for (const [b, bb] of boxes.slice(i + 1))
        expect(overlaps(ba, bb), `${a} × ${b}`).toBe(false);
    });
    const x = (id: string) => d.parts.find((p) => p.id === id)!.position.x;
    expect(x("you")).toBeLessThan(x("process"));
    expect(x("process")).toBeLessThan(x("events"));
    expect(d.parts.every((p) => p.positioned === "layout")).toBe(true);
  });

  it("keeps rails on their ports", async () => {
    const flow = await laidOut(unplaced(spec(inlineDiscussions)));
    for (const d of flow.arrangements)
      for (const r of d.rails) {
        const from = d.parts.find((p) => p.id === r.from.part)!.ports[
          r.from.port
        ];
        const to = d.parts.find((p) => p.id === r.to.part)!.ports[r.to.port];
        expect(r.points[0]).toEqual([from.x, from.y]);
        expect(r.points[r.points.length - 1]).toEqual([to.x, to.y]);
        // orthogonal
        for (let i = 1; i < r.points.length; i++) {
          const [a, b] = [r.points[i - 1], r.points[i]];
          expect(
            Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[1] - b[1]) < 0.01,
            `${r.id} segment ${i}`
          ).toBe(true);
        }
      }
  });

  it("runs return rails in lanes along the bottom", async () => {
    const flow = await laidOut(unplaced(spec(inlineDiscussions)));
    const d = flow.arrangements[1];
    const deliver = d.rails.find((r) => r.id === "deliver")!;
    const lowest = Math.max(...deliver.points.map(([, y]) => y));
    for (const p of d.parts) expect(lowest).toBeGreaterThan(partExtent(p).y1);
    expect(deliver.labelAt?.[1]).toBeGreaterThan(lowest);
  });

  it("drops a branch below the main rail", async () => {
    const s: FlowSpec = {
      version: 1,
      parts: [
        { id: "src", kind: "source" },
        { id: "gate", kind: "guard" },
        { id: "ok", kind: "worker" },
        { id: "no", kind: "store" },
      ],
      rails: [
        { id: "a", from: "src.out", to: "gate.in" },
        { id: "b", from: "gate.allow", to: "ok.in" },
        { id: "c", from: "gate.deny", to: "no.in", label: "deny" },
      ],
    };
    const d = (await laidOut(s)).arrangements[0];
    const y = (id: string) => partFrame(d.parts.find((p) => p.id === id)!).y0;
    expect(y("no")).toBeGreaterThan(y("ok"));
    const a = d.rails.find((r) => r.id === "a")!;
    expect(a.points.every(([, py]) => py === a.points[0][1])).toBe(true);
    expect(labelCollisions(d)).toEqual([]);
  });

  it("keeps hand-given positions and lays out only the rest", async () => {
    const s = spec(inlineDiscussions);
    const mixed: FlowSpec = {
      ...s,
      parts: s.parts.map((p) => (p.id === "you" ? p : withoutPosition(p))),
    };
    const d = (await laidOut(mixed)).arrangements[0];
    const you = d.parts.find((p) => p.id === "you")!;
    expect(you.position).toEqual({ x: 0, y: 100 });
    expect(you.positioned).toBe("given");
    expect(d.parts.find((p) => p.id === "process")!.positioned).toBe("layout");
  });

  it("compiles a fully hand-placed spec once, unchanged", async () => {
    const s = spec(inlineDiscussions);
    const sync = compileFlowOrThrow(s);
    expect(needsAutoLayout(sync)).toBe(false);
    expect(await laidOut(s)).toEqual(sync);
  });

  it("frames a region as a compound node around its parts", async () => {
    const s: FlowSpec = {
      ...unplaced(spec(inlineDiscussions)),
      regions: [
        { id: "proc", label: "SACRUM PROCESS", parts: ["process", "tools"] },
      ],
    };
    const flow = await laidOut(s);
    for (const d of flow.arrangements) {
      const [g] = d.regions;
      const box = {
        x0: g.x,
        y0: g.y,
        x1: g.x + g.width,
        y1: g.y + g.height,
      };
      for (const p of d.parts) {
        const e = partExtent(p);
        const inside =
          e.x0 >= box.x0 && e.x1 <= box.x1 && e.y0 >= box.y0 && e.y1 <= box.y1;
        expect(inside, p.id).toBe(g.parts.includes(p.id));
        if (!g.parts.includes(p.id))
          expect(overlaps(e, box), `${p.id} inside region`).toBe(false);
      }
      expect(labelCollisions(d)).toEqual([]);
    }
    expect(flow.arrangements[0].regions).toEqual(flow.arrangements[1].regions);
  });

  it("lays out each drill-down level on its own", async () => {
    const inner = unplaced(spec(mechanisms));
    const s: FlowSpec = {
      version: 1,
      parts: [
        { id: "a", kind: "source" },
        { id: "b", kind: "worker", drill: { spec: inner } },
      ],
      rails: [{ id: "r", from: "a.out", to: "b.in" }],
    };
    const flow = compileFlowOrThrow(s);
    const layout = await layoutFlow(flow);
    expect(Object.keys(layout.drills ?? {})).toEqual(["b"]);
    const laid = await laidOut(s);
    const drill = laid.arrangements[0].parts[1].drill;
    expect(drill?.kind).toBe("inline");
    if (drill?.kind !== "inline") return;
    expect(labelCollisions(drill.flow.arrangements[0])).toEqual([]);
    expect(drill.flow.arrangements[0].parts[0].position).toEqual(
      layout.drills!.b.positions.source
    );
  });

  it("forks a labelled rail off a shared port instead of climbing over it", async () => {
    const d = (await laidOut(unplaced(spec(inlineDiscussions))))
      .arrangements[1];
    const rail = (id: string) => d.rails.find((r) => r.id === id)!;
    const [ask, stop] = [rail("ask"), rail("stop")];
    const ys = stop.points.map(([, y]) => y);
    const [top, bottom] = [stop.points[0][1], stop.points.at(-1)![1]];
    // `stop` leaves you.request with `ask` and steps down to process.resume
    // without rising above the port it shares.
    expect(Math.min(...ys)).toBe(top);
    expect(Math.max(...ys)).toBe(bottom);
    expect(stop.points[0]).toEqual(ask.points[0]);
    expect(stop.labelAt![1]).toBeLessThan(bottom);
    expect(stop.labelAt![1]).toBeGreaterThan(top);
    expect(labelCollisions(d)).toEqual([]);
  });

  it.each([
    ["one port", { id: "loop", from: "q.r1", to: "q.r1" }],
    ["two stacked ports", { id: "loop", from: "q.r1", to: "q.r2" }],
  ])("draws a self-loop on %s as a loop beside the part", async (_n, loop) => {
    const s: FlowSpec = {
      version: 1,
      parts: [
        { id: "q", kind: "quorum" },
        { id: "below", kind: "aggregator" },
      ],
      rails: [loop],
    };
    const d = (await laidOut(s)).arrangements[0];
    const r = d.rails[0];
    const verticals = r.points
      .slice(1)
      .flatMap((b, i) => (r.points[i][0] === b[0] ? [b[0]] : []));
    // Down and back up on two different lines, never through a part.
    expect(new Set(verticals).size).toBeGreaterThanOrEqual(2);
    for (let i = 2; i < r.points.length; i++) {
      const [a, b, c] = [r.points[i - 2], r.points[i - 1], r.points[i]];
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      expect(dot, `turns back at ${b}`).toBeGreaterThan(-1);
    }
    const lane = Math.max(...r.points.map(([, y]) => y));
    for (const p of d.parts) expect(lane).toBeGreaterThan(partExtent(p).y1);
  });

  it("brings a return rail into a top port from above, around its part", async () => {
    const s: FlowSpec = {
      version: 1,
      parts: [{ id: "gate", kind: "human gate" }],
      rails: [{ id: "ask", from: "gate.out", to: "gate.reviewer" }],
    };
    const d = (await laidOut(s)).arrangements[0];
    const [r] = d.rails;
    const frame = partFrame(d.parts[0]);
    const [x, y] = r.points.at(-1)!;
    expect(r.points.at(-2)).toEqual([x, expect.any(Number)]);
    expect(r.points.at(-2)![1]).toBeLessThan(y);
    for (let i = 1; i < r.points.length - 1; i++) {
      const [a, b] = [r.points[i - 1], r.points[i]];
      const seg = {
        x0: Math.min(a[0], b[0]),
        y0: Math.min(a[1], b[1]),
        x1: Math.max(a[0], b[0]),
        y1: Math.max(a[1], b[1]),
      };
      expect(overlaps(seg, frame), `segment ${i} cuts the gate`).toBe(false);
    }
  });

  it.each([
    {
      name: "stacked parts beside the return legs",
      parts: [
        { id: "p0", kind: "two-phase commit" },
        { id: "p1", kind: "aggregator" },
        { id: "p2", kind: "aggregator" },
        { id: "p3", kind: "aggregator" },
        { id: "p4", kind: "alert" },
      ],
      forward: { id: "r3", from: "p0.p2", to: "p4.in" },
    },
    {
      name: "an approval beside the return legs",
      parts: [
        { id: "p0", kind: "two-phase commit" },
        { id: "p1", kind: "approval" },
      ],
      forward: { id: "r3", from: "p0.p1", to: "p1.person" },
    },
  ])(
    "keeps disjoint self-loops apart with $name",
    async ({ parts, forward }) => {
      // Shrunk Hegel counterexamples: r0 and r2 have distinct ports, while
      // the intervening r1 joins the two ports used by those self-loops.
      const d = (
        await laidOut({
          version: 1,
          parts,
          rails: [
            { id: "r0", from: "p0.p1", to: "p0.p1" },
            { id: "r1", from: "p0.p1", to: "p0.p2" },
            { id: "r2", from: "p0.p2", to: "p0.p2" },
            forward,
          ],
        })
      ).arrangements[0];
      const [a, b] = [d.rails[0], d.rails[2]];
      for (const r of [a, b]) {
        expect(Math.max(...r.points.map(([, y]) => y))).toBeGreaterThan(
          Math.max(...d.parts.map((p) => partExtent(p).y1))
        );
      }
      for (let i = 1; i < a.points.length; i++)
        for (let j = 1; j < b.points.length; j++) {
          const [p, q, r, s] = [
            a.points[i - 1],
            a.points[i],
            b.points[j - 1],
            b.points[j],
          ];
          for (const k of [0, 1] as const) {
            const o = 1 - k;
            if (
              [
                Math.abs(p[o] - q[o]),
                Math.abs(r[o] - s[o]),
                Math.abs(p[o] - r[o]),
              ].some((distance) => distance >= 0.5)
            )
              continue;
            const overlap =
              Math.min(Math.max(p[k], q[k]), Math.max(r[k], s[k])) -
              Math.max(Math.min(p[k], q[k]), Math.min(r[k], s[k]));
            expect(
              overlap,
              JSON.stringify([a.points, b.points])
            ).toBeLessThanOrEqual(1);
          }
        }
      expect(labelCollisions(d)).toEqual([]);
    }
  );

  it("steps a cramped same-port loop aside instead of doubling back", async () => {
    // Hegel counterexample: p3 lands so close to p2 that the loop's stub sits
    // in p3's extent and neither leg finds a way to the lane.
    const d = (
      await laidOut({
        version: 1,
        parts: [
          { id: "p0", kind: "route step" },
          { id: "p1", kind: "retry" },
          { id: "p2", kind: "two-phase commit" },
          { id: "p3", kind: "alert" },
          { id: "p4", kind: "aggregator" },
        ],
        rails: [
          { id: "r0", from: "p0.out1", to: "p3.in" },
          { id: "r1", from: "p2.p1", to: "p2.p1" },
          { id: "r2", from: "p2.p1", to: "p3.in" },
        ],
      })
    ).arrangements[0];
    const { points } = d.rails.find((r) => r.id === "r1")!;
    for (let i = 2; i < points.length; i++) {
      const [a, b, c] = [points[i - 2], points[i - 1], points[i]];
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      expect(dot, `turns back at ${b}`).toBeGreaterThan(-1);
    }
  });

  it("drops a boxed-in self-loop beside a rail that shares its port", async () => {
    // Hegel counterexample: r1 passes just past p0.out's stub, so r0's first
    // leg finds no way down and used to drop along r2's step.
    const d = (
      await laidOut({
        version: 1,
        parts: [
          { id: "p0", kind: "aggregator" },
          { id: "p1", kind: "aggregator" },
          { id: "p2", kind: "approval" },
          { id: "p3", kind: "aggregator" },
          { id: "p4", kind: "aggregator" },
          { id: "p5", kind: "aggregator" },
        ],
        rails: [
          { id: "r0", from: "p0.out", to: "p0.in" },
          { id: "r1", from: "p3.out", to: "p1.in" },
          { id: "r2", from: "p0.out", to: "p3.in" },
          { id: "r3", from: "p0.out", to: "p1.in" },
        ],
      })
    ).arrangements[0];
    for (const [i, a] of d.rails.entries())
      for (const b of d.rails.slice(i + 1))
        expect(sharesBadStretch(a, b), `${a.id} runs along ${b.id}`).toBe(
          false
        );
  });

  it("finds return rails by model order", () => {
    const parts = ["a", "b", "c"].map((id) => ({ id }));
    expect(
      returnRails(parts, [
        { id: "1", from: "a", to: "b" },
        { id: "2", from: "b", to: "c" },
        { id: "3", from: "c", to: "a" },
        { id: "4", from: "b", to: "b" },
      ])
    ).toEqual(new Set(["3", "4"]));
  });
});
