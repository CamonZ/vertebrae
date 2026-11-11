import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import { FlowDiagram } from "./FlowDiagram";
import { arrangement, compileFlowOrThrow, parseFlowSpec } from "./index";

describe("rendering a compiled flow with the motion core", () => {
  const parsed = parseFlowSpec(inlineDiscussions);
  if (!parsed.ok) throw new Error("fixture does not parse");
  const after = arrangement(compileFlowOrThrow(parsed.value), "after")!;

  it("draws each part with its spec id and a card on a rail with its card id", () => {
    const q1 = after.travel.cards.find((c) => c.id === "q1")!;
    const mid = (q1.born + q1.dies) / 2;
    const { container } = render(
      <FlowDiagram diagram={after} t={mid} reducedMotion={false} />
    );
    const ids = [...container.querySelectorAll("[data-part-id]")].map((e) =>
      e.getAttribute("data-part-id")
    );
    expect(ids).toEqual(["you", "process", "tools", "events"]);
    const rail = container.querySelector(".md-rail-cards [data-card-id='q1']");
    expect(rail).not.toBeNull();
  });

  it("the card is inside the next part after the hand-off", () => {
    const arrival = after.markers.find(
      (m) => m.kind === "arrival" && m.card === "q1"
    )!;
    const { container } = render(
      <FlowDiagram diagram={after} t={arrival.t + 0.3} reducedMotion={false} />
    );
    expect(
      container.querySelector(".md-rail-cards [data-card-id='q1']")
    ).toBeNull();
    expect(
      container.querySelector("[data-part-id='process'] [data-card-id='q1']")
    ).not.toBeNull();
  });
});
