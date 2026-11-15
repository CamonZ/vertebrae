import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { route, routePath } from "../route";
import { compileFlowOrThrow } from "./compile";
import { compileFlowLaidOut } from "./layout";
import { FlowScene } from "./FlowDiagram";

afterEach(cleanup);

it("real nonplanar bus fixture retains jumps, corners, endpoints and separate tracks during presentation changes", async () => {
  // K3,3 requires a crossing; two extra parallel links retain separate rail IDs.
  const ids = ["a", "b", "c", "x", "y", "z"];
  const rails = ["a", "b", "c"].flatMap((from) =>
    ["x", "y", "z"].map((to) => ({
      id: `${from}_${to}`,
      from: `${from}.out`,
      to: `${to}.in`,
    }))
  );
  rails.push({ id: "parallel", from: "a.out", to: "x.in" });
  const spec = {
    version: 1,
    parts: ids.map((id) => ({ id, kind: "topology endpoint" })),
    rails,
  };
  const result = await compileFlowLaidOut(spec);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const laid = result.flow.arrangements[0];
  expect(laid.rails.some((r) => !!r.jumps?.length)).toBe(true);
  // Replay the shipped layout contract with explicit tight-corner metadata.
  // The nonplanar fixture generates jumps; its bus corners use default radii.
  const diagram = compileFlowOrThrow(spec, {
    layout: () => ({
      positions: Object.fromEntries(laid.parts.map((p) => [p.id, p.position])),
      routes: Object.fromEntries(
        laid.rails.map((r) => [
          r.id,
          { ...r, cornerRadii: r.points.map((_, i) => (i % 2 ? 6 : 12)) },
        ])
      ),
    }),
  }).arrangements[0];
  expect(diagram.rails.some((r) => !!r.jumps?.length)).toBe(true);
  expect(diagram.rails.some((r) => !!r.cornerRadii?.length)).toBe(true);
  const before = JSON.stringify(diagram);
  const expected = diagram.rails.map((r) =>
    routePath(route(r.points, undefined, r))
  );
  const view = render(<FlowScene diagram={diagram} t={0} reducedMotion />);
  for (const rail of diagram.rails) {
    view.rerender(
      <FlowScene
        diagram={diagram}
        t={0}
        reducedMotion
        presentation={{
          rails: new Set([rail.id]),
          selected: new Set([rail.from.part]),
          traced: new Set([rail.to.part]),
        }}
      />
    );
    expect(
      [...view.container.querySelectorAll(".md-wire path")].map((el) =>
        el.getAttribute("d")
      )
    ).toEqual(expected);
    expect(
      [...view.container.querySelectorAll("[data-emphasis]")].map((el) =>
        el.getAttribute("data-rail-id")
      )
    ).toEqual([rail.id]);
    expect(JSON.stringify(diagram)).toBe(before);
    expect(view.container.querySelectorAll(".md-rail")).toHaveLength(0);
  }
});
