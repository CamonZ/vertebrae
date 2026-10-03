import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepNodeGeo } from "./StepNodeGeo";
import type { Kind, PlacedStep } from "./layout/types";

const KINDS: readonly Kind[] = [
  "llm",
  "structured",
  "execute",
  "route",
  "wait",
  "human",
  "stop",
  "finish",
];

function makeStep(kind: Kind, overrides: Partial<PlacedStep> = {}): PlacedStep {
  return {
    id: "workflow.step",
    stepId: "step",
    workflowId: "workflow",
    name: `${kind} step`,
    kind,
    role: "process",
    idx: 1,
    x: 10,
    y: 20,
    w: 224,
    h: 96,
    ...overrides,
  };
}

describe("StepNodeGeo", () => {
  it("renders a distinct role form for each workflow step kind", () => {
    for (const kind of KINDS) {
      const { container, unmount } = render(
        <StepNodeGeo step={makeStep(kind)} />
      );
      expect(container.querySelector(`.ag-step--${kind}`)).toBeInTheDocument();
      expect(screen.getByTestId(`step-node-${kind} step`)).toHaveAttribute(
        "data-kind",
        kind
      );
      unmount();
    }
  });

  it("shows structured primitive shapes without fabricating per-question counts", () => {
    render(<StepNodeGeo step={makeStep("structured")} />);

    expect(screen.getByLabelText("Structured output types")).toHaveTextContent(
      "ChoiceScoreNoul"
    );
    expect(document.querySelectorAll(".ag-primitive-icon")).toHaveLength(3);
    expect(screen.getByText("Typed questions")).toBeInTheDocument();
  });

  it("marks live LLM work and waiting human input from active-run counts", () => {
    const { rerender } = render(
      <StepNodeGeo step={makeStep("llm")} running={1} total={2} />
    );
    expect(screen.getByTestId("step-node-llm step")).toHaveClass("is-running");
    expect(screen.getByText("1 active run")).toBeInTheDocument();

    rerender(<StepNodeGeo step={makeStep("human")} running={1} total={1} />);
    expect(screen.getByTestId("step-node-human step")).toHaveClass(
      "is-awaiting-input"
    );
    expect(screen.getByText("Waiting for input")).toBeInTheDocument();
  });

  it("dims steps beyond a run-boundary seam", () => {
    render(<StepNodeGeo step={makeStep("execute", { futureRun: true })} />);

    expect(screen.getByTestId("step-node-execute step")).toHaveClass(
      "is-future-run"
    );
  });

  it("carries the lane-aligned seam geometry onto the stop node", () => {
    render(
      <StepNodeGeo
        step={makeStep("stop", { seamOffset: 18, seamExtent: 142 })}
      />
    );

    const node = screen.getByTestId("step-node-stop step");
    expect(node.style.getPropertyValue("--seam-offset")).toBe("18px");
    expect(node.style.getPropertyValue("--seam-extent")).toBe("142px");
  });
});
