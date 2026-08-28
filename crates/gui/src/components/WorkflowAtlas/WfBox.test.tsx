import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    stepIds: ["s1", "s2"],
    total: 0,
    running: 0,
    ...overrides,
    factoryName: overrides.factoryName ?? null,
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

describe("WfBox factory variant", () => {
  it("uses the workflow node shell while keeping factory contents opaque", () => {
    const onSelect = vi.fn();
    const { container, getByTestId } = render(
      <WfBox
        variant="factory"
        factory={{
          id: "Factory A",
          name: "Factory A",
          workflowCount: 2,
          workItemCount: 4,
          activeCount: 1,
        }}
        rect={RECT}
        onSelect={onSelect}
      />
    );

    expect(container.querySelector(".uv-wf.factory-node")).toBeInTheDocument();
    expect(container.querySelector(".uv-factory-face")).toBeInTheDocument();
    expect(container.querySelector(".uv-face-graph")).not.toBeInTheDocument();
    expect(container.querySelector(".uv-face-map")).not.toBeInTheDocument();
    expect(getByTestId("factory-node-Factory A")).toHaveTextContent(
      "2 workflows"
    );

    fireEvent.click(getByTestId("factory-node-Factory A"));
    expect(onSelect).toHaveBeenCalledWith("Factory A");
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
