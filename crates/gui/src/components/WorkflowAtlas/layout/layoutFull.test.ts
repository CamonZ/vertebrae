import { describe, expect, it } from "vitest";
import type { AtlasModel, AtlasStep } from "./types";
import { layoutFull } from "./layoutFull";

function step(
  stepId: string,
  order: number,
  kind: AtlasStep["kind"]
): AtlasStep {
  return {
    id: `wf.${stepId}`,
    stepId,
    workflowId: "wf",
    name: stepId,
    stepType: null,
    kind,
    role: "process",
    order,
    transitionsTo: [],
    total: 0,
    running: 0,
  };
}

const MODEL: AtlasModel = {
  workflows: [
    {
      id: "wf",
      name: "wf",
      phase: "Unphased",
      factoryName: null,
      stepIds: ["work", "route", "review", "done"],
      total: 0,
      running: 0,
    } as AtlasModel["workflows"][number],
  ],
  steps: [
    step("work", 0, "llm"),
    step("route", 1, "route"),
    step("review", 2, "llm"),
    step("done", 3, "finish"),
  ],
  edges: [
    {
      id: "L",
      kind: "loop",
      from: "wf.route",
      to: "wf.work",
      fromWorkflow: "wf",
      toWorkflow: "wf",
      label: "again · resume",
    },
    {
      id: "B",
      kind: "branch",
      from: "wf.route",
      to: "wf.done",
      fromWorkflow: "wf",
      toWorkflow: "wf",
      label: "ship · fork",
    },
  ],
  phases: [{ index: 0, name: "Unphased", members: ["wf"] }],
  forwardLabels: { "wf.route->wf.review": "ok · new" },
};

describe("layoutFull route edges", () => {
  it("lays out route branches in the lane and places every decision label", async () => {
    const layout = await layoutFull(MODEL);
    const intra = layout.workflows[0].intra;
    const byPair = (from: string, to: string) =>
      intra.find((edge) => edge.from === from && edge.to === to);

    const branch = byPair("wf.route", "wf.done");
    expect(branch?.kind).toBe("branch");
    expect(branch?.points.length).toBeGreaterThan(1);
    expect(branch?.labelPos?.text).toBe("ship · fork");

    const forward = byPair("wf.route", "wf.review");
    expect(forward?.kind).toBe("forward");
    expect(forward?.label).toBe("ok · new");
    expect(forward?.labelPos?.text).toBe("ok · new");
    expect(byPair("wf.work", "wf.route")?.labelPos).toBeNull();

    // a loop's label sits on its gutter run, between source and target
    const loop = byPair("wf.route", "wf.work")!;
    const [, gutterTop, gutterBottom] = loop.points;
    expect(loop.labelPos).toEqual({
      text: "again · resume",
      x: gutterTop.x,
      y: (gutterTop.y + gutterBottom.y) / 2,
    });
    expect(layout.cross).toEqual([]);
  });
});
