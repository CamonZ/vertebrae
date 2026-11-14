import { sharesBadStretch } from "./layoutTestHelpers";
import { fixedPortPlanarity } from "./layoutPlanarityOracle";
import { writeFileSync } from "node:fs";
import { beforeEach, expect, test } from "vitest";
import { railCrossings } from "./crossings";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import mechanisms from "./__fixtures__/mechanisms.flow.yaml?raw";
import {
  compileFlow,
  compileFlowLaidOut,
  createFlowRegistry,
  parseFlowSpec,
  type FlowSpec,
  type PartSpec,
  type RailSpec,
  resetLayoutCache,
} from "./index";

// The level cache is module-wide; keep every case's layout independent.
beforeEach(resetLayoutCache);

const registry = createFlowRegistry();
const KINDS = registry.parts
  .kinds()
  .map((kind) => {
    const ports = Object.entries(registry.parts.get(kind)!.ports);
    const of = (dir: "in" | "out") =>
      ports
        .filter(([, d]) => d.direction === dir || d.direction === "both")
        .map(([name, d]) => ({ name, tokens: d.tokens as readonly string[] }));
    return { kind, outs: of("out"), ins: of("in") };
  })
  .filter((k) => k.outs.length + k.ins.length > 0);

let seed = 12345;
const rnd = () =>
  (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];

function gen(): FlowSpec | undefined {
  const n = int(2, 6);
  const kinds = Array.from({ length: n }, () => pick(KINDS));
  const parts: PartSpec[] = kinds.map((k, i) => ({
    id: `p${i}`,
    kind: k.kind,
  }));
  const cand: [string, string][] = [];
  kinds.forEach((a, i) =>
    kinds.forEach((b, j) => {
      for (const o of a.outs)
        for (const p of b.ins)
          if (o.tokens.some((t) => p.tokens.includes(t)))
            cand.push([`p${i}.${o.name}`, `p${j}.${p.name}`]);
    })
  );
  if (!cand.length) return;
  const rails: RailSpec[] = [];
  const used = new Set<string>();
  const m = int(1, 8);
  for (let r = 0; r < m; r++) {
    const [from, to] = pick(cand);
    if (used.has(from + to)) continue;
    used.add(from + to);
    const label = pick(["", "", "ok", "retry later"]);
    rails.push({ id: `r${r}`, from, to, ...(label ? { label } : {}) });
  }
  const spec: FlowSpec = { version: 1, parts, rails };
  return compileFlow(spec, { registry }).ok ? spec : undefined;
}

/** A forest admits an embedding for any fixed cyclic port order. Union/find is
 * independent of the router and never inspects its drawing. */
function forest(spec: FlowSpec): boolean {
  const components = spec.parts.map((p) => new Set([p.id]));
  for (const rail of spec.rails ?? []) {
    const a = components.find((c) => c.has(rail.from.split(".")[0]))!;
    const b = components.find((c) => c.has(rail.to.split(".")[0]))!;
    if (a === b) return false;
    for (const id of b) a.add(id);
    components.splice(components.indexOf(b), 1);
  }
  return true;
}

test("seeded 404-flow crossing census, with an independent forest oracle", async () => {
  const specs: [string, FlowSpec][] = [];
  for (const [name, src] of [
    ["inlineDiscussions", inlineDiscussions],
    ["mechanisms", mechanisms],
  ] as const) {
    const p = parseFlowSpec(src);
    if (!p.ok) continue;
    const s = p.value as FlowSpec;
    specs.push([name + ":placed", s]);
    specs.push([
      name + ":auto",
      {
        ...s,
        parts: s.parts.map((x) => {
          const q = { ...x };
          delete (q as { position?: unknown }).position;
          return q;
        }),
      },
    ]);
  }
  for (let i = 0; specs.length < 404 && i < 4000; i++) {
    const g = gen();
    if (g) specs.push([`gen${i}`, g]);
  }
  const crossed: {
    name: string;
    spec: FlowSpec;
    rails: readonly import("./compile").DiagramRail[];
  }[] = [];
  let crossingFlows = 0;
  let crossings = 0;
  let forests = 0;
  const times: [string, number][] = [];
  let planar = 0;
  let nonPlanar = 0;
  let unknown = 0;
  const missed: string[] = [];
  for (const [name, spec] of specs) {
    const started = performance.now();
    const result = await compileFlowLaidOut(spec, { registry });
    times.push([name, performance.now() - started]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const d = result.flow.arrangements[0];
    let count = 0;
    for (const [i, a] of d.rails.entries())
      for (const b of d.rails.slice(i + 1)) {
        // Hand-positioned endpoints deliberately retain compiler railBetween
        // geometry, including its existing joins. The bus invariant applies
        // to pairs of automatic routes, not that explicitly excluded surface.
        const automatic = (rail: typeof a) =>
          [rail.from, rail.to].every(
            (end) =>
              d.parts.find((p) => p.id === end.part)!.positioned === "layout"
          );
        if (automatic(a) && automatic(b))
          expect(
            sharesBadStretch(a, b),
            `${name}: ${a.id}/${b.id} share a trunk`
          ).toBe(false);
        const hits = railCrossings(a.points, b.points);
        count += hits.length;
        for (const hit of hits) {
          const on = (
            j: { segment: number; at: readonly [number, number] },
            segment: number
          ) =>
            j.segment === segment &&
            Math.hypot(j.at[0] - hit.at[0], j.at[1] - hit.at[1]) < 0.01;
          const jumps = [
            ...(a.jumps ?? []).filter((j) => on(j, hit.a)),
            ...(b.jumps ?? []).filter((j) => on(j, hit.b)),
          ];
          expect(
            jumps,
            `${name}: silent/double crossing ${a.id}/${b.id}`
          ).toHaveLength(1);
        }
      }
    const classification = fixedPortPlanarity(d);
    if (classification === "planar") {
      planar++;
      if (count) missed.push(name);
    } else if (classification === "non-planar") nonPlanar++;
    else unknown++;
    if (forest(spec)) {
      forests++;
      expect(count, `${name}: independently planar forest`).toBe(0);
    }
    if (!name.startsWith("gen")) expect(count, name).toBe(0);
    if (count) {
      crossingFlows++;
      crossed.push({ name, spec, rails: [...d.rails] });
    }
    crossings += count;
  }
  expect(specs).toHaveLength(404);
  if (process.env.BUS_CENSUS_REPORT)
    writeFileSync(
      process.env.BUS_CENSUS_REPORT,
      JSON.stringify(
        {
          crossingFlows,
          crossings,
          forests,
          planar,
          nonPlanar,
          unknown,
          missed,
          crossed,
        },
        null,
        2
      )
    );
  console.info(
    JSON.stringify({
      flows: specs.length,
      crossingFlows,
      crossings,
      forests,
      planar,
      nonPlanar,
      unknown,
      missed,
      slowestMs: Math.round(Math.max(...times.map(([, ms]) => ms))),
      baseline: { crossingFlows: 238, crossings: 751 },
    })
  );
  expect(
    missed,
    "planar rotation systems whose crossings still need rerouting"
  ).toEqual([]);
  // A generous ceiling (typical flows take a few ms, the slowest ~200 ms):
  // it catches searches that blow up, not small machine differences.
  const slow = times.filter(([, ms]) => ms > 2_000).map(([name]) => name);
  expect(slow, "flows slower than 2 s to lay out").toEqual([]);
}, 120_000);
