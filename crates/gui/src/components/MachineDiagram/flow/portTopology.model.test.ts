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
