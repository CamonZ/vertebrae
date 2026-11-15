import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { pointAt, route, routePath } from "../route";
import { stateAt } from "../timeline";
import { FlowDiagram, FlowScene } from "./FlowDiagram";
import { compileFlowLaidOut } from "./layout";
import { ROUTING_EXAMPLES } from "./routingExamples";
import { arrangement, compileFlowOrThrow, parseFlowSpec } from "./index";
import inline from "./__fixtures__/inlineDiscussions.flow.yaml?raw";

afterEach(cleanup);

for (const name of ["Parallel bus tracks", "Fixed-port K3,3"]) {
  test(`${name}: shared scene and both hosts keep complete paths and card geometry`, async () => {
    const spec = ROUTING_EXAMPLES.find((e) => e.name === name)!.spec;
    const crossing = name === "Fixed-port K3,3";
    const result = await compileFlowLaidOut({
      ...spec,
      ...(crossing
        ? {
            cards: spec.rails!.map((r) => ({
              id: `card-${r.id}`,
              token: "data",
              origin: r.from.split(".")[0],
            })),
            story: spec.rails!.map((r) => ({
              steps: [
                {
                  part: r.to.split(".")[0],
                  verb: "record",
                  card: `card-${r.id}`,
                  via: r.id,
                },
              ],
            })),
          }
        : {}),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const diagram = result.flow.arrangements[0];
    expect(
      diagram.rails.some((r) => (crossing ? r.jumps?.length : r.cornerRadii))
    ).toBeTruthy();
    const paths = diagram.rails.map((r) =>
      routePath(route(r.points, undefined, r))
    );
    const times = crossing
      ? diagram.travel.cards.flatMap((c) =>
          c.legs
            .slice(0, 1)
            .flatMap((l) => [0.2, 0.5, 0.8].map((f) => l.t + l.d * f))
        )
      : [0];
    for (const t of times) {
      for (const host of ["scene", "embedded", "full-page"] as const) {
        const view = render(
          host === "scene" ? (
            <FlowScene diagram={diagram} t={t} reducedMotion={false} />
          ) : (
            <FlowDiagram
              diagram={diagram}
              mode={host}
              t={t}
              reducedMotion={false}
            />
          )
        );
        expect(
          [...view.container.querySelectorAll(".md-wire path.gedge")].map((p) =>
            p.getAttribute("d")
          )
        ).toEqual(paths);
        expect(view.container.querySelectorAll(".md-rail")).toHaveLength(0);
        const frames = stateAt(diagram.travel, t, {
          reducedMotion: false,
          smear: true,
        }).cards;
        if (crossing) expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) {
          const body = view.container.querySelector(
            `.md-rail-cards [data-card-id='${frame.id}'] > g[transform]`
          );
          expect(body?.getAttribute("transform")).toBe(
            `translate(${frame.x} ${frame.y}) rotate(${frame.angle})`
          );
        }
        view.unmount();
      }
    }
    for (const card of diagram.travel.cards) {
      for (const leg of card.legs) {
        const rail = diagram.rails.find(
          (r) => r.id === card.id!.replace("card-", "")
        )!;
        expect(leg.route).toEqual(route(rail.points, undefined, rail));
        expect(pointAt(leg.route, 0)).toEqual(rail.points[0]);
        expect(pointAt(leg.route, 1)).toEqual(rail.points.at(-1));
      }
    }
  });
}

test("both hosts retain Before/After layers, band, labels, evidence and keyboard activation", () => {
  const parsed = parseFlowSpec(inline);
  if (!parsed.ok) throw new Error("fixture");
  const flow = compileFlowOrThrow(parsed.value);
  const before = arrangement(flow, "before")!;
  const after = arrangement(flow, "after")!;
  for (const mode of ["embedded", "full-page"] as const) {
    const activate = vi.fn();
    const follow = vi.fn();
    const view = render(
      <FlowDiagram
        diagram={after}
        mode={mode}
        t={1}
        morph={{ from: before, t: 1, progress: 0.5 }}
        interaction={{ onActivatePart: activate, onActivateCard: follow }}
      />
    );
    expect(
      view.container.querySelector("[data-morph-from][aria-hidden]")
    ).not.toBeNull();
    expect(view.container.querySelector(".md-band")).not.toBeNull();
    expect(view.container.textContent).toContain("deliverLocalChatTurn");
    const part = view.container.querySelector("[data-part-id='process']")!;
    fireEvent.keyDown(part, { key: "Enter" });
    fireEvent.keyDown(part, { key: " " });
    expect(activate.mock.calls).toEqual([["process"], ["process"]]);
    const card = view.container.querySelector("[data-card-id][role='button']")!;
    expect(card).not.toBeNull();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(follow).toHaveBeenCalled();
    view.rerender(
      <FlowDiagram diagram={before} mode={mode} t={0} reducedMotion />
    );
    expect(view.container.querySelector("[data-morph-from]")).toBeNull();
    view.unmount();
  }
});

test("drill hint and activation survive both hosting modes", () => {
  const diagram = compileFlowOrThrow({
    version: 1,
    parts: [
      {
        id: "nested",
        kind: "worker",
        drill: {
          spec: { version: 1, parts: [{ id: "inner", kind: "worker" }] },
        },
      },
    ],
  }).arrangements[0];
  for (const mode of ["embedded", "full-page"] as const) {
    const activate = vi.fn();
    const view = render(
      <FlowDiagram
        diagram={diagram}
        mode={mode}
        t={0}
        reducedMotion
        interaction={{ onActivatePart: activate }}
      />
    );
    const part = view.container.querySelector("[data-part-id='nested']")!;
    expect(part.getAttribute("aria-label")).toContain(
      "Opens a deeper diagram."
    );
    fireEvent.keyDown(part, { key: "Enter" });
    fireEvent.click(part);
    expect(activate.mock.calls).toEqual([["nested"], ["nested"]]);
    view.unmount();
  }
});
