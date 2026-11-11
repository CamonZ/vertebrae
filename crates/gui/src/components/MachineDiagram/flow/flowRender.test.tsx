import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import { MachineDiagram } from "../MachineDiagram";
import { MachinePart } from "../MachinePart";
import { RailCards } from "../RailCards";
import { Wire } from "../Rail";
import {
  arrangement,
  compileFlowOrThrow,
  parseFlowSpec,
  type DiagramTimeline,
} from "./index";

function Diagram({ d, t }: { d: DiagramTimeline; t: number }) {
  return (
    <MachineDiagram label="flow" width={d.width} height={d.height}>
      {d.rails
        .filter((r) => r.presence !== "absent")
        .map((r) => (
          <Wire
            key={r.id}
            points={r.points}
            change={r.change === "unchanged" ? "" : r.change}
          />
        ))}
      {d.parts
        .filter((p) => p.presence !== "absent")
        .map((p) => (
          <MachinePart
            key={p.id}
            id={p.id}
            part={p.identity}
            bb={p.bb}
            timeline={p.timeline}
            t={t}
            view={{ kind: "scenario", name: d.arrangement }}
            change={p.change}
            changeNote={p.changeNote}
            status={p.status}
            x={p.position.x}
            y={p.position.y}
            scale={p.scale}
            reducedMotion={false}
          />
        ))}
      <RailCards timeline={d.travel} t={t} reducedMotion={false} />
    </MachineDiagram>
  );
}

describe("rendering a compiled flow with the motion core", () => {
  const parsed = parseFlowSpec(inlineDiscussions);
  if (!parsed.ok) throw new Error("fixture does not parse");
  const after = arrangement(compileFlowOrThrow(parsed.value), "after")!;

  it("draws each part with its spec id and a card on a rail with its card id", () => {
    const q1 = after.travel.cards.find((c) => c.id === "q1")!;
    const mid = (q1.born + q1.dies) / 2;
    const { container } = render(<Diagram d={after} t={mid} />);
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
    const { container } = render(<Diagram d={after} t={arrival.t + 0.3} />);
    expect(
      container.querySelector(".md-rail-cards [data-card-id='q1']")
    ).toBeNull();
    expect(
      container.querySelector("[data-part-id='process'] [data-card-id='q1']")
    ).not.toBeNull();
  });
});
