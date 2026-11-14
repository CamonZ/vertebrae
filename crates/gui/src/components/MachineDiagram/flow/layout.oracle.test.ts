import { elk } from "../../../hooks/useElkLayout";
import { compileFlowOrThrow } from "./compile";
import { layoutFlow } from "./layout";
/** Independent MODEL_ORDER classification and acyclicity oracle. */
import { expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { returnRails } from "./index";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

interface Rail {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

const graph = gs.composite((tc) => {
  const n = tc.draw(gs.integers({ minValue: 1, maxValue: 9 }));
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const end = gs.sampledFrom(ids);
  const rails: Rail[] = tc
    .draw(gs.arrays(gs.tuples(end, end), { maxSize: 16 }))
    .map(([from, to], i) => ({ id: `r${i}`, from, to }));
  return { parts: ids.map((id) => ({ id })), rails };
});

/** Kahn's algorithm: true when the rails admit a topological order. */
function acyclic(parts: readonly { id: string }[], rails: readonly Rail[]) {
  const indegree = new Map(parts.map((p) => [p.id, 0]));
  for (const r of rails) indegree.set(r.to, indegree.get(r.to)! + 1);
  const ready = parts.filter((p) => indegree.get(p.id) === 0).map((p) => p.id);
  let ordered = 0;
  while (ready.length > 0) {
    const at = ready.pop()!;
    ordered++;
    for (const r of rails)
      if (r.from === at) {
        const left = indegree.get(r.to)! - 1;
        indegree.set(r.to, left);
        if (left === 0) ready.push(r.to);
      }
  }
  return ordered === parts.length;
}

test("return rails equal MODEL_ORDER reversals and leave an acyclic graph", () =>
  hegel.test(
    (tc) => {
      const { parts, rails } = tc.draw(graph);
      const back = returnRails(parts, rails);
      const expected = rails.filter(
        (r) =>
          parts.findIndex((p) => p.id === r.to) <=
          parts.findIndex((p) => p.id === r.from)
      );
      check(
        back.size === expected.length && expected.every((r) => back.has(r.id)),
        "classification disagrees with MODEL_ORDER"
      );
      check(
        acyclic(
          parts,
          rails.filter((r) => !back.has(r.id))
        ),
        "a cycle survives without the return rails"
      );
    },
    { testCases: 500 }
  ));

test("a flow whose rails follow spec order has no return rails", () =>
  hegel.test(
    (tc) => {
      const { parts, rails } = tc.draw(graph);
      const order = new Map(parts.map((p, i) => [p.id, i]));
      const onward = rails.filter((r) => order.get(r.from)! < order.get(r.to)!);
      check(
        returnRails(parts, onward).size === 0,
        "an acyclic flow in spec order was given return rails"
      );
    },
    { testCases: 500 }
  ));

test("ELK receives only forward rails and our router owns every return", async () => {
  const observed = vi.spyOn(elk, "layout");
  try {
    await hegel.testAsync(
      async (tc) => {
        const { parts, rails } = tc.draw(graph);
        tc.assume(parts.length <= 6 && rails.length <= 8);
        const compiled = compileFlowOrThrow({
          version: 1,
          parts: parts.map((p) => ({ ...p, kind: "aggregator" })),
          rails: rails.map((r) => ({
            id: r.id,
            from: `${r.from}.out`,
            to: `${r.to}.in`,
          })),
        });
        observed.mockClear();
        const layout = await layoutFlow(compiled, { cache: false });
        const back = returnRails(parts, rails);
        const input = observed.mock.calls[0][0];
        expect(input.edges?.map((e) => e.id)).toEqual(
          rails.filter((r) => !back.has(r.id)).map((r) => r.id)
        );
        const output: import("elkjs/lib/elk.bundled.js").ElkNode =
          await observed.mock.results[0].value;
        const x = new Map(output.children!.map((n) => [n.id, n.x!]));
        for (const r of rails) {
          if (!back.has(r.id))
            expect(x.get(r.to)!).toBeGreaterThan(x.get(r.from)!);
          else {
            expect(input.edges?.some((e) => e.id === r.id)).toBe(false);
            // Our router draws it (straight, when its ports face each other).
            expect(layout.routes?.[r.id].points.length).toBeGreaterThanOrEqual(
              2
            );
          }
        }
      },
      { testCases: 500 }
    );
  } finally {
    observed.mockRestore();
  }
}, 120_000);
