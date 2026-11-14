import { expect, test } from "vitest";
import cases from "./__fixtures__/planarRouting.json";
import { compileFlowLaidOut } from "./layout";
import { labelCollisions } from "./extent";
import { fixedPortPlanarity } from "./layoutPlanarityOracle";
import { railCrossings } from "./crossings";

/** Planar port orders the router once drew with crossings (or, on the way
 * to crossing-free routes, with a colliding label). */
for (const { name, spec } of cases)
  test(`planar port-order regression ${name}`, async () => {
    const result = await compileFlowLaidOut(spec);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const d = result.flow.arrangements[0];
    expect(fixedPortPlanarity(d)).toBe("planar");
    const hits = d.rails.flatMap((a, i) =>
      d.rails.slice(i + 1).flatMap((b) =>
        railCrossings(a.points, b.points).map((c) => ({
          fromRail: a.id,
          toRail: b.id,
          ...c,
        }))
      )
    );
    expect(hits).toEqual([]);
    for (const arrangement of result.flow.arrangements)
      expect(labelCollisions(arrangement)).toEqual([]);
  }, 30_000);
