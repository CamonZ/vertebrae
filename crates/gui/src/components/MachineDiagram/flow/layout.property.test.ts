/**
 * Property tests of flow auto-layout (layout.ts). Hegel generates valid flow
 * specs from the starter parts — random kinds, rails between compatible
 * ports (branches, loops and self-loops included), change marks that split
 * Before from After, rail labels and regions — and every laid-out picture
 * must keep the layout's promises: no label collides with a part, gate or
 * label; part extents never overlap; Before and After share one geometry;
 * rails start and end on their ports and run orthogonally; return rails run
 * below everything; regions frame exactly their members; hand-given
 * positions win; and the same spec always lays out the same way.
 */
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  compileFlow,
  compileFlowLaidOut,
  compileFlowOrThrow,
  createFlowRegistry,
  labelCollisions,
  overlaps,
  partExtent,
  partFrame,
  returnRails,
  type Box,
  type CompiledFlow,
  type DiagramTimeline,
  type FlowSpec,
  type PartSpec,
  type RailSpec,
  type RegionSpec,
} from "./index";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const registry = createFlowRegistry();

interface PortInfo {
  readonly name: string;
  readonly tokens: readonly string[];
}

interface KindInfo {
  readonly kind: string;
  readonly outs: readonly PortInfo[];
  readonly ins: readonly PortInfo[];
}

/** Starter kinds with at least one port, and which ports rails can use. */
const KINDS: readonly KindInfo[] = registry.parts
  .kinds()
  .map((kind) => {
    const ports = Object.entries(registry.parts.get(kind)!.ports);
    const of = (dir: "in" | "out") =>
      ports
        .filter(([, d]) => d.direction === dir || d.direction === "both")
        .map(([name, d]) => ({ name, tokens: d.tokens }));
    return { kind, outs: of("out"), ins: of("in") };
  })
  .filter((k) => k.outs.length + k.ins.length > 0);

const LABELS = ["", "", "ok", "deny", "retry later", "tool call"] as const;
const PART_CHANGES = [
  "unchanged",
  "unchanged",
  "unchanged",
  "added",
  "removed",
  "changed",
] as const;
const RAIL_CHANGES = ["unchanged", "unchanged", "added", "removed"] as const;

interface Generated {
  readonly spec: FlowSpec;
  /** Ids of the parts that carry a hand-given position. */
  readonly placed: ReadonlySet<string>;
}

/** A flow spec over the starter parts; `placing` lets some parts carry a position. */
const flowSpec = (placing: boolean) =>
  gs.composite<Generated>((tc) => {
    const n = tc.draw(gs.integers({ minValue: 2, maxValue: 6 }));
    const kinds = Array.from({ length: n }, () =>
      tc.draw(gs.sampledFrom(KINDS))
    );
    const placed = new Set<string>();
    const parts: PartSpec[] = kinds.map((k, i) => {
      const id = `p${i}`;
      const change = tc.draw(gs.sampledFrom(PART_CHANGES));
      const position =
        placing && tc.draw(gs.booleans())
          ? {
              x: tc.draw(gs.integers({ minValue: 0, maxValue: 2400 })),
              y: tc.draw(gs.integers({ minValue: 0, maxValue: 1200 })),
            }
          : undefined;
      if (position) placed.add(id);
      return {
        id,
        kind: k.kind,
        ...(change !== "unchanged" ? { change } : {}),
        ...(change === "changed" ? { changeNote: "now different" } : {}),
        ...(position ? { position } : {}),
      };
    });
    // Every rail a valid spec could draw between these parts.
    const candidates: [string, string][] = [];
    kinds.forEach((a, i) =>
      kinds.forEach((b, j) => {
        for (const o of a.outs)
          for (const p of b.ins)
            if (o.tokens.some((t) => p.tokens.includes(t)))
              candidates.push([`p${i}.${o.name}`, `p${j}.${p.name}`]);
      })
    );
    tc.assume(candidates.length > 0);
    const m = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
    const rails: RailSpec[] = [];
    const used = new Set<string>();
    for (let r = 0; r < m; r++) {
      const [from, to] = tc.draw(gs.sampledFrom(candidates));
      if (used.has(`${from}>${to}`)) continue;
      used.add(`${from}>${to}`);
      const label = tc.draw(gs.sampledFrom(LABELS));
      const change = tc.draw(gs.sampledFrom(RAIL_CHANGES));
      rails.push({
        id: `r${r}`,
        from,
        to,
        ...(label ? { label } : {}),
        ...(change !== "unchanged" ? { change } : {}),
      });
    }
    const regions: RegionSpec[] = [];
    if (tc.draw(gs.booleans())) {
      const members = parts
        .filter(() => tc.draw(gs.booleans()))
        .map((p) => p.id);
      if (members.length > 0)
        regions.push({
          id: "g0",
          ...(tc.draw(gs.booleans()) ? { label: "REGION" } : {}),
          parts: members,
        });
    }
    const spec: FlowSpec = {
      version: 1,
      parts,
      rails,
      ...(regions.length > 0 ? { regions } : {}),
    };
    // Change marks have their own rules (a rail on an added part must be
    // added, …); keep only the specs the compiler accepts.
    tc.assume(compileFlow(spec, { registry }).ok);
    return { spec, placed };
  });

async function laidOut(spec: FlowSpec): Promise<CompiledFlow> {
  const r = await compileFlowLaidOut(spec, { registry });
  if (!r.ok) throw new Error(`layout rejected: ${JSON.stringify(r.errors)}`);
  return r.flow;
}

const regionBox = (g: DiagramTimeline["regions"][number]): Box => ({
  x0: g.x,
  y0: g.y,
  x1: g.x + g.width,
  y1: g.y + g.height,
});

const inside = (a: Box, b: Box) =>
  a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;

/** Whether two routes run along one line for more than a pixel. */
function sharesStretch(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[]
): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, s] = [a[i - 1], a[i], b[j - 1], b[j]];
      for (const k of [0, 1] as const) {
        const o = 1 - k;
        // both segments on the line where coordinate o is constant
        if (!near(p[o], q[o]) || !near(r[o], s[o]) || !near(p[o], r[o]))
          continue;
        const lo = Math.max(Math.min(p[k], q[k]), Math.min(r[k], s[k]));
        const hi = Math.min(Math.max(p[k], q[k]), Math.max(r[k], s[k]));
        if (hi - lo > 1) return true;
      }
    }
  return false;
}

const SETTINGS = { testCases: 100 };
/** ELK lays out every generated spec; a run takes seconds, not milliseconds. */
const TIMEOUT = 120_000;

test(
  "laid-out diagrams keep labels, parts, rails and regions apart",
  () =>
    hegel.testAsync(async (tc) => {
      const { spec } = tc.draw(flowSpec(false));
      const flow = await laidOut(spec);
      const backs = returnRails(
        spec.parts,
        (spec.rails ?? []).map((r) => ({
          id: r.id,
          from: r.from.split(".")[0],
          to: r.to.split(".")[0],
        }))
      );
      for (const d of flow.arrangements) {
        const where = `${d.arrangement}`;
        const hit = labelCollisions(d);
        check(hit.length === 0, `${where}: ${hit.join("; ")}`);

        const boxes = d.parts.map((p) => [p.id, partExtent(p)] as const);
        boxes.forEach(([a, ba], i) => {
          check(
            ba.x0 >= 0 && ba.y0 >= 0 && ba.x1 <= d.width && ba.y1 <= d.height,
            `${where}: ${a} is outside the ${d.width}×${d.height} canvas`
          );
          for (const [b, bb] of boxes.slice(i + 1))
            check(!overlaps(ba, bb), `${where}: parts ${a} and ${b} overlap`);
        });

        for (const r of d.rails) {
          const from = d.parts.find((p) => p.id === r.from.part)!.ports[
            r.from.port
          ];
          const to = d.parts.find((p) => p.id === r.to.part)!.ports[r.to.port];
          const [first, last] = [r.points[0], r.points[r.points.length - 1]];
          check(
            first[0] === from.x && first[1] === from.y,
            `${where}: rail ${r.id} leaves ${first} not its port ${[from.x, from.y]}`
          );
          check(
            last[0] === to.x && last[1] === to.y,
            `${where}: rail ${r.id} arrives at ${last} not its port ${[to.x, to.y]}`
          );
          for (let i = 1; i < r.points.length; i++) {
            const [a, b] = [r.points[i - 1], r.points[i]];
            check(
              Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[1] - b[1]) < 0.01,
              `${where}: rail ${r.id} segment ${i} is diagonal`
            );
          }
          for (const [x, y] of r.points)
            check(
              x >= 0 && y >= 0 && x <= d.width && y <= d.height,
              `${where}: rail ${r.id} leaves the canvas at ${[x, y]}`
            );
          for (let i = 2; i < r.points.length; i++) {
            const [a, b, c] = [r.points[i - 2], r.points[i - 1], r.points[i]];
            const dot =
              (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
            check(
              dot > -1, // tolerate floating-point noise at right angles
              `${where}: rail ${r.id} turns back on itself at ${b}`
            );
          }
          for (let i = 1; i < r.points.length; i++) {
            const [a, b] = [r.points[i - 1], r.points[i]];
            const seg = {
              x0: Math.min(a[0], b[0]),
              y0: Math.min(a[1], b[1]),
              x1: Math.max(a[0], b[0]),
              y1: Math.max(a[1], b[1]),
            };
            for (const p of d.parts) {
              // Some parts draw ports inside their frame (a boundary's
              // crossing); the stub from such a port to the border is theirs.
              const ownStub =
                (i === 1 && p.id === r.from.part) ||
                (i === r.points.length - 1 && p.id === r.to.part);
              if (ownStub) continue;
              const f = partFrame(p);
              check(
                !(
                  seg.x0 < f.x1 &&
                  f.x0 < seg.x1 &&
                  seg.y0 < f.y1 &&
                  f.y0 < seg.y1
                ),
                `${where}: rail ${r.id} cuts through ${p.id}`
              );
            }
          }
          // Return rails are routed here, not by ELK: each keeps its own
          // lane and verticals.
          for (const q of d.rails) {
            if (q.id <= r.id || !backs.has(r.id) || !backs.has(q.id)) continue;
            // Rails meeting at one port share its stub (a fork or a join).
            const key = (e: { part: string; port: string }) =>
              `${e.part}.${e.port}`;
            const mine = new Set([key(r.from), key(r.to)]);
            if (mine.has(key(q.from)) || mine.has(key(q.to))) continue;
            check(
              !sharesStretch(r.points, q.points),
              `${where}: rails ${r.id} and ${q.id} run along each other`
            );
          }
          if (backs.has(r.id)) {
            const lowest = Math.max(...r.points.map(([, y]) => y));
            for (const p of d.parts)
              check(
                lowest > partExtent(p).y1,
                `${where}: return rail ${r.id} does not pass below ${p.id}`
              );
          }
        }

        for (const g of d.regions) {
          const box = regionBox(g);
          for (const p of d.parts) {
            const e = partExtent(p);
            if (g.parts.includes(p.id))
              check(inside(e, box), `${where}: ${p.id} escapes region ${g.id}`);
            else
              check(!overlaps(e, box), `${where}: ${p.id} intrudes on ${g.id}`);
          }
        }
      }
    }, SETTINGS),
  TIMEOUT
);

test(
  "Before and After share every position, rail and region",
  () =>
    hegel.testAsync(async (tc) => {
      const { spec } = tc.draw(flowSpec(true));
      const [first, ...rest] = (await laidOut(spec)).arrangements;
      for (const d of rest) {
        expect(d.parts.map((p) => [p.id, p.position])).toEqual(
          first.parts.map((p) => [p.id, p.position])
        );
        expect(d.rails.map((r) => [r.id, r.points, r.labelAt])).toEqual(
          first.rails.map((r) => [r.id, r.points, r.labelAt])
        );
        expect(d.regions).toEqual(first.regions);
        expect([d.width, d.height]).toEqual([first.width, first.height]);
      }
    }, SETTINGS),
  TIMEOUT
);

test(
  "hand-given positions win and only the rest is laid out",
  () =>
    hegel.testAsync(async (tc) => {
      const { spec, placed } = tc.draw(flowSpec(true));
      const flow = await laidOut(spec);
      for (const d of flow.arrangements)
        for (const p of d.parts) {
          const given = spec.parts.find((s) => s.id === p.id)!.position;
          if (placed.has(p.id)) {
            expect(p.positioned).toBe("given");
            expect(p.position).toEqual(given);
          } else expect(p.positioned).toBe("layout");
        }
      if (placed.size === spec.parts.length)
        expect(flow).toEqual(compileFlowOrThrow(spec, { registry }));
    }, SETTINGS),
  TIMEOUT
);

test(
  "the same spec always lays out the same way",
  () =>
    hegel.testAsync(
      async (tc) => {
        const { spec } = tc.draw(flowSpec(true));
        expect(await laidOut(spec)).toEqual(await laidOut(spec));
      },
      { testCases: 30 }
    ),
  TIMEOUT
);

test(
  "each drill-down level is laid out on its own",
  () =>
    hegel.testAsync(
      async (tc) => {
        const outer = tc.draw(flowSpec(false)).spec;
        const inner = tc.draw(flowSpec(false)).spec;
        const [host, ...others] = outer.parts;
        const spec: FlowSpec = {
          ...outer,
          parts: [{ ...host, drill: { spec: inner } }, ...others],
        };
        tc.assume(compileFlow(spec, { registry }).ok);
        const flow = await laidOut(spec);
        const alone = (await laidOut(inner)).arrangements;
        for (const d of flow.arrangements) {
          const drill = d.parts.find((p) => p.id === host.id)!.drill;
          check(
            drill?.kind === "inline",
            "the drill-down did not compile inline"
          );
          if (drill?.kind !== "inline") return;
          drill.flow.arrangements.forEach((level, i) => {
            const hit = labelCollisions(level);
            check(
              hit.length === 0,
              `drill ${level.arrangement}: ${hit.join("; ")}`
            );
            expect(level.parts.map((p) => [p.id, p.position])).toEqual(
              alone[i].parts.map((p) => [p.id, p.position])
            );
          });
        }
      },
      { testCases: 50 }
    ),
  TIMEOUT
);
