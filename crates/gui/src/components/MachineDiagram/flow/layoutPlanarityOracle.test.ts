import { expect, test } from "vitest";
import { compileFlowOrThrow } from "./compile";
import { fixedPortPlanarity } from "./layoutPlanarityOracle";
import { ROUTING_EXAMPLES } from "./routingExamples";

test("rotation-system oracle recognizes the planar repros and K3,3", () => {
  for (const { name, spec } of ROUTING_EXAMPLES)
    expect(
      fixedPortPlanarity(compileFlowOrThrow(spec).arrangements[0]),
      name
    ).toBe(name === "Fixed-port K3,3" ? "non-planar" : "planar");
});

test("fixed alternating port pairs are non-planar even on one part", () => {
  const d = compileFlowOrThrow({
    version: 1,
    parts: [{ id: "q", kind: "quorum" }],
    rails: [
      { id: "a", from: "q.r1", to: "q.r3" },
      { id: "b", from: "q.r2", to: "q.in" },
    ],
  }).arrangements[0];
  expect(fixedPortPlanarity(d)).toBe("non-planar");
  expect(fixedPortPlanarity(d, 0)).toBe("unknown");
});
