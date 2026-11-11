/**
 * Oracle tests for `returnRails`, the cycle breaker that decides which rails
 * auto-layout routes back along the bottom. Hegel generates rail graphs
 * (self-loops, parallel rails and disconnected parts included); the oracle is
 * graph reachability, computed independently of the depth-first search:
 * removing the return rails must leave the flow acyclic, and every return
 * rail must close a cycle through the rails that stay.
 */
import { test } from "vitest";
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

/** Whether `to` can be reached from `from` along `rails` (zero steps counts). */
function reaches(rails: readonly Rail[], from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === to) return true;
    for (const r of rails)
      if (r.from === at && !seen.has(r.to)) {
        seen.add(r.to);
        queue.push(r.to);
      }
  }
  return false;
}

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

test("return rails break every cycle and each closes one", () =>
  hegel.test((tc) => {
    const { parts, rails } = tc.draw(graph);
    const back = returnRails(parts, rails);
    const kept = rails.filter((r) => !back.has(r.id));
    check(acyclic(parts, kept), "a cycle survives without the return rails");
    for (const r of rails)
      if (back.has(r.id))
        check(
          reaches(kept, r.to, r.from),
          `return rail ${r.id} (${r.from} → ${r.to}) closes no cycle`
        );
  }));

test("a flow whose rails follow spec order has no return rails", () =>
  hegel.test((tc) => {
    const { parts, rails } = tc.draw(graph);
    const order = new Map(parts.map((p, i) => [p.id, i]));
    const onward = rails.filter((r) => order.get(r.from)! < order.get(r.to)!);
    check(
      returnRails(parts, onward).size === 0,
      "an acyclic flow in spec order was given return rails"
    );
  }));
