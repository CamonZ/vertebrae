import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WfBox } from "./WfBox";
import type { AtlasWorkflow, Kind, Rect } from "./layout/types";

const RECT: Rect = { x: 0, y: 0, w: 264, h: 140 };
const SHAPE: Kind[] = ["execute", "eval"];

function makeWorkflow(overrides: Partial<AtlasWorkflow> = {}): AtlasWorkflow {
  return {
    id: "wf",
    name: "Backlog",
    description: null,
    initialStepId: "s1",
    phase: "Build",
    displayOrder: 0,
    isDefault: false,
    isFinal: false,
    stepIds: ["s1", "s2"],
    total: 0,
    running: 0,
    ...overrides,
  };
}

describe("WfBox default badge", () => {
  // Both faces (graph + map) are always mounted — the inactive one is only
  // opacity-hidden — so a default workflow renders the badge once per face.
  it("shows the default badge on both faces for a default workflow", () => {
    const { getAllByText } = render(
      <WfBox
        workflow={makeWorkflow({ isDefault: true })}
        rect={RECT}
        shape={SHAPE}
        stepCount={2}
      />
    );
    expect(getAllByText("default")).toHaveLength(2);
  });

  it("omits the default badge for a non-default workflow", () => {
    const { queryByText } = render(
      <WfBox
        workflow={makeWorkflow({ isDefault: false })}
        rect={RECT}
        shape={SHAPE}
        stepCount={2}
      />
    );
    expect(queryByText("default")).not.toBeInTheDocument();
  });
});

describe("WfBox final badge", () => {
  it("shows the Final badge next to workflow-name buttons on both faces", () => {
    const { getAllByRole, getAllByText } = render(
      <WfBox
        workflow={makeWorkflow({ isFinal: true })}
        rect={RECT}
        shape={SHAPE}
        stepCount={2}
      />
    );

    expect(getAllByRole("button", { name: "Backlog" })).toHaveLength(2);
    expect(getAllByText("Final")).toHaveLength(2);
  });
});

describe("WfBox task counts", () => {
  it("shows the total badge and a running pill on both faces when work is parked", () => {
    const { getAllByText, getAllByTitle } = render(
      <WfBox
        workflow={makeWorkflow({ total: 12, running: 3 })}
        rect={RECT}
        shape={SHAPE}
        stepCount={2}
      />
    );
    // once per face (graph + map)
    expect(getAllByText("12")).toHaveLength(2);
    expect(getAllByText("3")).toHaveLength(2);
    expect(getAllByTitle("12 task(s)")).toHaveLength(2);
    expect(getAllByTitle("3 active")).toHaveLength(2);
  });

  it("omits the running pill when nothing is running but keeps the total", () => {
    const { getAllByText, queryByText } = render(
      <WfBox
        workflow={makeWorkflow({ total: 5, running: 0 })}
        rect={RECT}
        shape={SHAPE}
        stepCount={2}
      />
    );
    expect(getAllByText("5")).toHaveLength(2);
    // "0" running pill is never rendered
    expect(queryByText("0")).not.toBeInTheDocument();
  });

  it("renders no count chips when the workflow is empty", () => {
    const { container } = render(
      <WfBox
        workflow={makeWorkflow({ total: 0, running: 0 })}
        rect={RECT}
        shape={SHAPE}
        stepCount={2}
      />
    );
    expect(container.querySelector(".uv-tc")).toBeNull();
  });
});
