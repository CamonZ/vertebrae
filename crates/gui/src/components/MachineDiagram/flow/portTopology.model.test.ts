import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { compileFlowOrThrow } from "./compile";
import { clockwisePorts, portEmbedding, portPlanarity } from "./portTopology";
import { fixedPortPlanarity } from "./layoutPlanarityOracle";
import { ROUTING_EXAMPLES } from "./routingExamples";

test(
  "production topology agrees with an independent exhaustive rotation oracle",
  () =>
    hegel.test(
      (tc) => {
        const n = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
        const count = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
        const part = () =>
          `p${tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }))}`;
        const rails = Array.from({ length: count }, (_, i) => ({
          id: `r${i}`,
          from: `${part()}.${tc.draw(gs.sampledFrom(["r1", "r2", "r3"]))}`,
          to: `${part()}.${tc.draw(gs.sampledFrom(["in", "r1", "r2", "r3"]))}`,
        }));
        const d = compileFlowOrThrow({
          version: 1,
          parts: Array.from({ length: n }, (_, i) => ({
            id: `p${i}`,
            kind: "quorum",
          })),
          rails,
        }).arrangements[0];
        expect(portPlanarity(d)).toBe(fixedPortPlanarity(d));
      },
      { testCases: 500 }
    ),
  120_000
);

test("Euler proofs and exhausted rotation searches have distinct outcomes", () => {
  const d = compileFlowOrThrow(
    ROUTING_EXAMPLES.find((e) => e.name === "Fixed-port K3,3")!.spec
  ).arrangements[0];
  expect(portPlanarity(d)).toBe("non-planar");
  expect(portPlanarity(d, 0)).toBe("non-planar"); // Analytic Euler proof needs no rotation trials.
  const fixed = compileFlowOrThrow({
    version: 1,
    parts: [{ id: "q", kind: "quorum" }],
    rails: [
      { id: "a", from: "q.r1", to: "q.r3" },
      { id: "b", from: "q.r2", to: "q.in" },
    ],
  }).arrangements[0];
  expect(portPlanarity(fixed)).toBe("non-planar");
  expect(portPlanarity(fixed, 0)).toBe("unknown");
});

test(
  "an embedding is found exactly for planar port orders, and is one",
  () =>
    hegel.test(
      (tc) => {
        const n = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
        const count = tc.draw(gs.integers({ minValue: 0, maxValue: 7 }));
        const part = () =>
          `p${tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }))}`;
        const rails = Array.from({ length: count }, (_, i) => ({
          id: `r${i}`,
          from: `${part()}.${tc.draw(gs.sampledFrom(["r1", "r2", "r3"]))}`,
          to: `${part()}.${tc.draw(gs.sampledFrom(["in", "r1", "r2", "r3"]))}`,
        }));
        const d = compileFlowOrThrow({
          version: 1,
          parts: Array.from({ length: n }, (_, i) => ({
            id: `p${i}`,
            kind: "quorum",
          })),
          rails,
        }).arrangements[0];
        const oracle = fixedPortPlanarity(d);
        tc.assume(oracle !== "unknown");
        const embedding = portEmbedding(d);
        expect(embedding !== undefined).toBe(oracle === "planar");
        if (!embedding) return;
        // Each used port lists exactly its rail ends.
        d.parts.forEach((p) =>
          Object.keys(p.ports).forEach((port) => {
            const ends = d.rails.flatMap((r, i) => [
              ...(r.from.part === p.id && r.from.port === port ? [2 * i] : []),
              ...(r.to.part === p.id && r.to.port === port ? [2 * i + 1] : []),
            ]);
            expect(
              [...(embedding.get(`${p.id}.${port}`) ?? [])].sort()
            ).toEqual(ends.sort());
          })
        );
        // Euler's formula holds in every connected component.
        const next = new Map<number, number>();
        for (const p of d.parts) {
          const around = clockwisePorts(p).flatMap(
            (port) => embedding.get(`${p.id}.${port}`) ?? []
          );
          around.forEach((dart, i) =>
            next.set(dart, around[(i + 1) % around.length])
          );
        }
        const partOf = (dart: number) => {
          const r = d.rails[dart >> 1];
          return dart % 2 ? r.to.part : r.from.part;
        };
        const parent = new Map(d.parts.map((p) => [p.id, p.id]));
        const root = (id: string): string =>
          parent.get(id) === id ? id : root(parent.get(id)!);
        for (const r of d.rails) parent.set(root(r.from.part), root(r.to.part));
        const faces = new Map<string, number>();
        const seen = new Set<number>();
        for (const start of next.keys())
          if (!seen.has(start)) {
            const c = root(partOf(start));
            faces.set(c, (faces.get(c) ?? 0) + 1);
            for (let dart = start; !seen.has(dart); dart = next.get(dart ^ 1)!)
              seen.add(dart);
          }
        for (const [c, f] of faces) {
          const v = d.parts.filter((p) => root(p.id) === c).length;
          const e = d.rails.filter((r) => root(r.from.part) === c).length;
          expect(v - e + f).toBe(2);
        }
      },
      { testCases: 300 }
    ),
  120_000
);

// The default embedding search used to exhaust 200,000 trials on this planar
// graph because it tried a different initial rotation from the planarity check.
const budgetRegression = [
  ["r1", "in"],
  ["r2", "in"],
  ["r2", "in"],
  ["r2", "in"],
  ["r1", "r2"],
  ["r2", "in"],
  ["r2", "in"],
];

test.each([
  { pairs: budgetRegression, budget: 200_000 },
  // Reindexing changes the enumeration order. The complete search space for
  // these seven loops is below two million rotations; no budget is increased
  // in production, and the original regression must use the default budget.
  { pairs: [...budgetRegression].reverse(), budget: 2_000_000 },
  {
    pairs: [...budgetRegression.slice(3), ...budgetRegression.slice(0, 3)],
    budget: 2_000_000,
  },
])(
  "parallel self-loop regression yields a certified embedding (%#)",
  ({ pairs, budget }) => {
    const d = compileFlowOrThrow({
      version: 1,
      parts: [{ id: "q", kind: "quorum" }],
      rails: pairs.map(([from, to], i) => ({
        id: `r${i}`,
        from: `q.${from}`,
        to: `q.${to}`,
      })),
    }).arrangements[0];
    expect(fixedPortPlanarity(d, budget)).toBe("planar");
    expect(portPlanarity(d, budget)).toBe("planar");
    const embedding =
      budget === 200_000
        ? portEmbedding(d)
        : portEmbedding(d, new Map(), new Map(), budget);
    expect(embedding).toBeDefined();
    // Certify the returned rotation, not merely its existence: a connected
    // one-vertex planar graph has E+1 face cycles in the dart permutation.
    const around = clockwisePorts(d.parts[0]).flatMap(
      (port) => embedding!.get(`q.${port}`) ?? []
    );
    expect([...around].sort((a, b) => a - b)).toEqual(
      Array.from({ length: d.rails.length * 2 }, (_, i) => i)
    );
    const next = new Map(
      around.map((dart, i) => [dart, around[(i + 1) % around.length]])
    );
    const seen = new Set<number>();
    let faces = 0;
    for (const start of around) {
      if (seen.has(start)) continue;
      faces++;
      for (let dart = start; !seen.has(dart); dart = next.get(dart ^ 1)!)
        seen.add(dart);
    }
    expect(faces).toBe(d.rails.length + 1);
  },
  120_000
);

test("bounded embedding search agrees with the independent rotation oracle", () =>
  hegel.test(
    (tc) => {
      const n = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 7 }));
      const endpoint = (source: boolean) =>
        `p${tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }))}.${tc.draw(gs.sampledFrom(source ? ["r1", "r2", "r3"] : ["in", "r1", "r2", "r3"]))}`;
      const d = compileFlowOrThrow({
        version: 1,
        parts: Array.from({ length: n }, (_, i) => ({
          id: `p${i}`,
          kind: "quorum",
        })),
        rails: Array.from({ length: count }, (_, i) => ({
          id: `r${i}`,
          from: endpoint(true),
          to: endpoint(false),
        })),
      }).arrangements[0];
      const budget = tc.draw(gs.sampledFrom([1, 2, 10, 100, 1000]));
      const oracle = fixedPortPlanarity(d, budget);
      const embedding = portEmbedding(d, new Map(), new Map(), budget);
      expect(embedding !== undefined).toBe(oracle === "planar");
    },
    { testCases: 500 }
  ));

test("preferred and fixed port orders remain authoritative", () => {
  const d = compileFlowOrThrow({
    version: 1,
    parts: ["a", "b", "c", "d"].map((id) => ({ id, kind: "quorum" })),
    rails: ["b", "c", "d"].map((id, i) => ({
      id: `r${i}`,
      from: "a.r1",
      to: `${id}.in`,
    })),
  }).arrangements[0];
  const preferred = new Map([["a.r1", [2, 0, 4]]]);
  expect(portEmbedding(d, new Map(), preferred, 1)?.get("a.r1")).toEqual([
    2, 0, 4,
  ]);
  const constrained = portEmbedding(d, new Map([["a.r1", [4, 0]]]), preferred);
  expect(constrained?.get("a.r1")?.filter((dart) => dart !== 2)).toEqual([
    4, 0,
  ]);
  expect(portEmbedding(d, new Map(), preferred, 0)).toBeUndefined();
});
