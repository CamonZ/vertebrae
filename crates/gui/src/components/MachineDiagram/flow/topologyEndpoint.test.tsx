import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { compileFlowOrThrow } from "./compile";
import { FLOW_DRAWINGS, type Drawing } from "./drawings";
import { FlowDiagram } from "./FlowDiagram";
import { transitionTokens } from "./parts/topology";

it("renders the shared endpoint as a neutral connector, independent of time", () => {
  const diagram = compileFlowOrThrow({
    version: 1,
    parts: [
      { id: "endpoint", kind: "topology endpoint", label: "Workflow endpoint" },
    ],
  }).arrangements[0];
  const part = diagram.parts[0];
  expect(part.neutral).toBe(true);
  expect(Object.keys(part.ports)).toEqual(["in", "out"]);
  const endpointDrawing: Drawing = FLOW_DRAWINGS["topology endpoint"];
  const drawing = (t: number) =>
    renderToStaticMarkup(<svg>{endpointDrawing(t, part)}</svg>);
  const markup = drawing(0);
  expect(drawing(100)).toBe(markup);
  const host = document.createElement("div");
  host.innerHTML = markup;
  expect(host.querySelectorAll("[data-topology-endpoint] circle")).toHaveLength(
    1
  );
  expect(host.querySelectorAll("[data-topology-endpoint] line")).toHaveLength(
    2
  );
  expect(host.querySelectorAll("rect, text, [stroke-dasharray]")).toHaveLength(
    0
  );
  expect(markup).toContain('cx="320" cy="200" r="20"');
  expect(part.bb).toEqual([280, 180, 80, 40]);
  expect(
    renderToStaticMarkup(<FlowDiagram diagram={diagram} t={0} reducedMotion />)
  ).not.toMatch(/\bidle\b|crossing costs a hop|serialize|partition/);
});

it.each(transitionTokens)(
  "transfers %s cards through its real ports without conversion",
  (token) => {
    const flow = compileFlowOrThrow({
      version: 1,
      parts: [
        { id: "a", kind: "topology endpoint" },
        { id: "b", kind: "topology endpoint" },
      ],
      rails: [{ id: "handoff", from: "a.out", to: "b.in" }],
      cards: [{ id: "work", token, origin: "a" }],
      story: [
        {
          steps: [
            { part: "a", verb: "transfer", card: "work" },
            { part: "b", verb: "transfer", card: "work", via: "handoff" },
          ],
        },
      ],
    });
    expect(flow.cards.work.token).toBe(token);
    const diagram = flow.arrangements[0];
    expect(diagram.parts.map((part) => part.steps[0].outcome)).toEqual([
      { exit: "out" },
      { exit: "out" },
    ]);
    expect(
      diagram.parts.every(
        (part) => part.neutral && part.timeline.cards.length > 0
      )
    ).toBe(true);
    expect(diagram.rails[0].from).toEqual({ part: "a", port: "out" });
    expect(diagram.rails[0].to).toEqual({ part: "b", port: "in" });
  }
);
