/**
 * Flow direction: every committed fixture compiles, lays out and routes in
 * all four directions as the turned picture of its left-to-right layout,
 * with the same topology, parts on the turned sides and upright text.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import burstOptions from "./__fixtures__/burstOptions.flow.yaml?raw";
import everyMark from "./__fixtures__/everyMark.flow.yaml?raw";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import mechanisms from "./__fixtures__/mechanisms.flow.yaml?raw";
import sessionMigration from "./__fixtures__/sessionMigration.flow.yaml?raw";
import planarCases from "./__fixtures__/planarRouting.json";
import { MACHINE_PARTS } from "../parts";
import {
  apply,
  partTurn,
  turnSide,
  FLOW_DIRECTIONS,
  type FlowDirection,
} from "../orientation";
import { FlowDiagram } from "./FlowDiagram";
import { compileFlowOrThrow, type DiagramTimeline } from "./compile";
import { railCrossings } from "./crossings";
import { createFlowRegistry } from "./defaults";
import {
  labelCollisions,
  overlaps,
  partExtent,
  partFrame,
  railLabels,
} from "./extent";
import { flowSpecJsonSchema } from "./jsonSchema";
import {
  LANE_GAP,
  compileFlowLaidOut,
  levelKey,
  resetLayoutCache,
} from "./layout";
import { sharesBadStretch } from "./layoutTestHelpers";
import { fixedPortPlanarity } from "./layoutPlanarityOracle";
import { parseFlowSpec } from "./parse";
import { portPlanarity } from "./portTopology";
import { ROUTING_EXAMPLES } from "./routingExamples";
import type { FlowSpec } from "./spec";
import { portFacing } from "./turn";
import { validateFlowSpec } from "./validate";

beforeEach(resetLayoutCache);
afterEach(cleanup);

const yaml = (source: string): FlowSpec => {
  const parsed = parseFlowSpec(source);
  if (!parsed.ok) throw new Error("fixture does not parse");
  return parsed.value as FlowSpec;
};

const FIXTURES: readonly (readonly [string, FlowSpec])[] = [
  ["burst options", yaml(burstOptions)],
  ["every mark", yaml(everyMark)],
  ["inline discussions", yaml(inlineDiscussions)],
  ["mechanisms", yaml(mechanisms)],
  ["session migration", yaml(sessionMigration)],
  ...ROUTING_EXAMPLES.map((e) => [`routing ${e.name}`, e.spec] as const),
  ...(planarCases as { name: string; spec: FlowSpec }[]).map(
    (c) => [`planar ${c.name}`, c.spec] as const
  ),
];

const TURNED = FLOW_DIRECTIONS.filter((d) => d !== "right");

async function laidOut(spec: FlowSpec, direction?: FlowDirection) {
  const r = await compileFlowLaidOut(direction ? { ...spec, direction } : spec);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.flow;
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Ports as drawn: turned side and turned part-space position. */
function drawn(d: DiagramTimeline): DiagramTimeline {
  return {
    ...d,
    parts: d.parts.map((p) => {
      const dir = p.direction ?? "right";
      return {
        ...p,
        ports: Object.fromEntries(
          Object.entries(p.ports).map(([name, port]) => [
            name,
            {
              ...port,
              side: turnSide(dir, port.side),
              local: apply(partTurn(dir), port.local),
            },
          ])
        ),
      };
    }),
  };
}

const crossings = (d: DiagramTimeline) =>
  d.rails.flatMap((a, i) =>
    d.rails.slice(i + 1).flatMap((b) => railCrossings(a.points, b.points))
  ).length;

function railCuts(d: DiagramTimeline): string[] {
  const out: string[] = [];
  for (const r of d.rails)
    for (let i = 1; i < r.points.length; i++) {
      const [a, b] = [r.points[i - 1], r.points[i]];
      const seg = {
        x0: Math.min(a[0], b[0]),
        y0: Math.min(a[1], b[1]),
        x1: Math.max(a[0], b[0]),
        y1: Math.max(a[1], b[1]),
      };
      for (const p of d.parts) {
        const own =
          (i === 1 && p.id === r.from.part) ||
          (i === r.points.length - 1 && p.id === r.to.part);
        if (own || p.presence === "absent") continue;
        const f = partFrame(p);
        if (seg.x0 < f.x1 && f.x0 < seg.x1 && seg.y0 < f.y1 && f.y0 < seg.y1)
          out.push(`${r.id} × ${p.id}`);
      }
    }
  return out;
}

function frameOverlaps(d: DiagramTimeline): string[] {
  const out: string[] = [];
  d.parts.forEach((p, i) => {
    for (const q of d.parts.slice(i + 1))
      if (overlaps(partFrame(p), partFrame(q))) out.push(`${p.id} × ${q.id}`);
  });
  return out;
}

describe("flow direction: fixtures", () => {
  it.each(FIXTURES)(
    "%s: right is the default",
    async (_n, spec) => {
      const plain = await laidOut(spec);
      resetLayoutCache();
      const right = await laidOut(spec, "right");
      expect(right).toEqual(plain);
      expect(levelKey(right.arrangements)).toBe(levelKey(plain.arrangements));
    },
    60_000
  );

  for (const dir of TURNED)
    it.each(FIXTURES)(
      `%s: lays out and routes ${dir}`,
      async (_n, spec) => {
        const right = await laidOut(spec);
        const turned = await laidOut(spec, dir);
        expect(turned.direction).toBe(dir);
        const forward = turnSide(dir, "E");
        right.arrangements.forEach((r, k) => {
          const t = turned.arrangements[k];
          expect(t.direction).toBe(dir);
          for (const q of t.parts) {
            expect(q.direction).toBe(dir);
            expect(q.cell).toBeDefined();
            // Ports sit where the turned drawing puts them, on turned sides.
            for (const [name, port] of Object.entries(q.ports)) {
              const [lx, ly] = apply(partTurn(dir), port.local);
              expect(port.x).toBeCloseTo(q.position.x + lx * q.scale, 6);
              expect(port.y).toBeCloseTo(q.position.y + ly * q.scale, 6);
              expect(portFacing(q, name)).toBe(turnSide(dir, port.side));
            }
          }
          // Rails start and end on their ports.
          for (const rail of t.rails) {
            const from = t.parts.find((p) => p.id === rail.from.part)!.ports[
              rail.from.port
            ];
            const to = t.parts.find((p) => p.id === rail.to.part)!.ports[
              rail.to.port
            ];
            expect(rail.points[0]).toEqual([from.x, from.y]);
            expect(rail.points[rail.points.length - 1]).toEqual([to.x, to.y]);
            for (let i = 1; i < rail.points.length; i++) {
              const [a, b] = [rail.points[i - 1], rail.points[i]];
              expect(
                close(a[0], b[0]) || close(a[1], b[1]),
                `${rail.id} is orthogonal`
              ).toBe(true);
            }
          }
          // Laid-out parts are ordered along the flow like left to right.
          const along = (q: DiagramTimeline["parts"][number]) => {
            const f = partFrame(q);
            return { E: f.x0, W: -f.x1, S: f.y0, N: -f.y1 }[forward];
          };
          const auto = r.parts.filter((p) => p.positioned === "layout");
          for (const [i, p] of auto.entries())
            for (const q of auto.slice(i + 1)) {
              const fp = partFrame(p);
              const fq = partFrame(q);
              if (fp.x1 <= fq.x0) {
                const tp = t.parts.find((x) => x.id === p.id)!;
                const tq = t.parts.find((x) => x.id === q.id)!;
                expect(along(tp), `${p.id} before ${q.id}`).toBeLessThan(
                  along(tq)
                );
              }
            }
          // Nothing reaches off the canvas.
          for (const p of t.parts) {
            const e = partExtent(p);
            expect(e.x0, p.id).toBeGreaterThanOrEqual(-1e-6);
            expect(e.y0, p.id).toBeGreaterThanOrEqual(-1e-6);
            expect(e.x1).toBeLessThanOrEqual(t.width + 1e-6);
            expect(e.y1).toBeLessThanOrEqual(t.height + 1e-6);
          }
          for (const rail of t.rails) {
            for (const [x, y] of rail.points) {
              expect(x).toBeGreaterThanOrEqual(-1e-6);
              expect(y).toBeGreaterThanOrEqual(-1e-6);
            }
            for (const b of railLabels(rail)) {
              expect(b.x0, rail.id).toBeGreaterThanOrEqual(-1e-6);
              expect(b.y0, rail.id).toBeGreaterThanOrEqual(-1e-6);
            }
          }
          for (const g of t.regions) {
            expect(g.x).toBeGreaterThanOrEqual(-1e-6);
            expect(g.y).toBeGreaterThanOrEqual(-1e-6);
          }
          // No part overlaps another, no rail runs through a part and no
          // label collides wherever left to right is clean.
          if (!frameOverlaps(r).length) expect(frameOverlaps(t)).toEqual([]);
          if (!railCuts(r).length) expect(railCuts(t)).toEqual([]);
          if (!labelCollisions(r).length)
            expect(labelCollisions(t)).toEqual([]);
        });
      },
      60_000
    );
});

describe("flow direction: topology", () => {
  for (const dir of TURNED)
    it.each(FIXTURES)(
      `%s: ${dir} keeps the port planarity verdict and crossing count`,
      async (_n, spec) => {
        const right = await laidOut(spec);
        const turned = await laidOut(spec, dir);
        right.arrangements.forEach((r, k) => {
          const t = turned.arrangements[k];
          const verdict = fixedPortPlanarity(drawn(r));
          expect(fixedPortPlanarity(drawn(t))).toBe(verdict);
          expect(portPlanarity(t)).toBe(portPlanarity(r));
          // Crossing-free wherever left to right is.
          if (crossings(r) === 0) expect(crossings(t)).toBe(0);
        });
      },
      60_000
    );
});

describe("flow direction: return rails", () => {
  const loop: FlowSpec = {
    version: 1,
    parts: ["a", "b", "c"].map((id) => ({ id, kind: "aggregator" })),
    rails: [
      { id: "ab", from: "a.out", to: "b.in" },
      { id: "bc", from: "b.out", to: "c.in" },
      { id: "back", from: "c.out", to: "a.in" },
    ],
  };
  /** Across-flow offset of the return channel from the parts' centre line. */
  const channel = (d: DiagramTimeline, dir: FlowDirection) => {
    const back = d.rails.find((r) => r.id === "back")!;
    const across = dir === "right" || dir === "left" ? 1 : 0;
    const centre =
      d.parts.reduce((s, p) => {
        const f = partFrame(p);
        return s + (across ? (f.y0 + f.y1) / 2 : (f.x0 + f.x1) / 2);
      }, 0) / d.parts.length;
    const along = back.points.map((p) => p[across] - centre);
    return along.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  };

  it.each(FLOW_DIRECTIONS)(
    "%s: the return runs across the flow, clear of the forward rails",
    async (dir) => {
      const flow = await laidOut(loop, dir);
      const d = flow.arrangements[0];
      const right = (await laidOut(loop)).arrangements[0];
      const offset = channel(d, dir);
      // Left to right returns run above or below; turned flows beside.
      expect(Math.abs(offset)).toBeGreaterThan(0);
      expect(Math.abs(offset)).toBeGreaterThan(LANE_GAP);
      // Kept separate from the forward rails (no shared stretch, no crossing).
      expect(crossings(d)).toBe(crossings(right));
      for (const r of d.rails)
        for (const q of d.rails)
          if (r.id < q.id)
            expect(sharesBadStretch(r, q), `${r.id} × ${q.id}`).toBe(false);
      expect(railCuts(d)).toEqual([]);
      // The forward rails run the way of the flow.
      const ab = d.rails.find((r) => r.id === "ab")!.points;
      const [from, to] = [ab[0], ab[ab.length - 1]];
      const forward = {
        right: to[0] - from[0],
        left: from[0] - to[0],
        down: to[1] - from[1],
        up: from[1] - to[1],
      }[dir];
      expect(forward).toBeGreaterThan(0);
    },
    30_000
  );
});

describe("flow direction: parts", () => {
  /** Every <text>'s accumulated linear transform, from the SVG root. */
  function textLinears(root: Element): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    const parse = (t: string | null): [number, number, number, number] => {
      let m: [number, number, number, number] = [1, 0, 0, 1];
      const mul = (n: [number, number, number, number]) => {
        const [a, b, c, d] = m;
        m = [
          a * n[0] + c * n[1],
          b * n[0] + d * n[1],
          a * n[2] + c * n[3],
          b * n[2] + d * n[3],
        ];
      };
      for (const [, op, args] of (t ?? "").matchAll(/(\w+)\(([^)]*)\)/g)) {
        const v = args.split(/[ ,]+/).filter(Boolean).map(Number);
        if (op === "matrix") mul([v[0], v[1], v[2], v[3]]);
        else if (op === "scale") mul([v[0], 0, 0, v[1] ?? v[0]]);
        else if (op === "rotate") {
          const r = (v[0] * Math.PI) / 180;
          mul([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r)]);
        }
      }
      return m;
    };
    for (const text of root.querySelectorAll("text")) {
      let m: [number, number, number, number] = [1, 0, 0, 1];
      for (let e: Element | null = text; e && e !== root; e = e.parentElement) {
        const [a, b, c, d] = parse(e.getAttribute("transform"));
        const [p, q, r, s] = m;
        m = [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s];
      }
      out.push(m);
    }
    return out;
  }

  const unit = (kind: string, direction: FlowDirection) =>
    compileFlowOrThrow({
      version: 1,
      direction,
      parts: [
        { id: "unit", kind, scale: 1, change: "changed", changeNote: "turned" },
      ],
    }).arrangements[1];

  for (const dir of FLOW_DIRECTIONS)
    it.each(Object.keys(MACHINE_PARTS))(
      `%s draws ${dir} with turned ports and upright text`,
      (kind) => {
        const d = unit(kind, dir);
        const part = d.parts[0];
        for (const name of Object.keys(part.ports))
          expect(portFacing(part, name)).toBe(
            turnSide(dir, part.ports[name].side)
          );
        const { container } = render(
          <FlowDiagram diagram={d} t={1} reducedMotion={false} />
        );
        const svg = container.querySelector("svg")!;
        const texts = textLinears(svg);
        expect(texts.length).toBeGreaterThan(0);
        for (const [a, b, c, dd] of texts) {
          // Upright: no rotation or mirror, only a positive scale.
          expect(Math.abs(b) + Math.abs(c)).toBeLessThan(1e-9);
          expect(a).toBeGreaterThan(0);
          expect(dd).toBeGreaterThan(0);
        }
        // The mechanism turns with the flow: its output faces the flow.
        const out = Object.values(part.ports).find((p) => p.side === "E");
        if (out)
          expect(turnSide(dir, out.side)).toBe(
            { right: "E", left: "W", down: "S", up: "N" }[dir]
          );
      }
    );
});

describe("flow direction: validation", () => {
  const registry = createFlowRegistry();
  const base = { version: 1, parts: [{ id: "a", kind: "worker" }] };

  it.each(FLOW_DIRECTIONS)("accepts direction %s", (direction) => {
    expect(validateFlowSpec({ ...base, direction }, registry)).toEqual([]);
  });

  it("rejects an unknown direction, naming the allowed ones", () => {
    const errors = validateFlowSpec(
      { ...base, direction: "sideways" },
      registry
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("direction");
    expect(errors[0].message).toContain("sideways");
    expect(errors[0].expected).toEqual([...FLOW_DIRECTIONS].sort());
  });

  it("describes direction in the JSON schema", () => {
    const schema = flowSpecJsonSchema(registry) as {
      properties: Record<string, { enum?: unknown[] }>;
    };
    expect(schema.properties.direction.enum).toEqual([...FLOW_DIRECTIONS]);
  });
});

describe("flow direction: placed part labels", () => {
  const policies = [
    { title: "shown", subtitle: "beside" },
    { title: "shown", subtitle: "below" },
  ] as const;
  for (const labels of policies)
    for (const dir of FLOW_DIRECTIONS)
      // Hand-placed cells are packed by their author; only laid-out
      // levels reserve room for headers above a turned frame.
      it.each(
        FIXTURES.slice(0, 5).filter(([, spec]) =>
          spec.parts.some((p) => !p.position)
        )
      )(
        `%s: ${labels.subtitle} labels stay clear ${dir}`,
        async (_n, spec) => {
          const right = await laidOut({ ...spec, labels } as FlowSpec);
          const turned = await laidOut({ ...spec, labels } as FlowSpec, dir);
          right.arrangements.forEach((r, k) => {
            if (labelCollisions(r).length) return;
            expect(labelCollisions(turned.arrangements[k])).toEqual([]);
          });
        },
        60_000
      );
});
