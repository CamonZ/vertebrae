import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineSummary, PipelineWorkflow } from "../../../bindings";
import type { DiagramTimeline } from "../../MachineDiagram/flow/compile";
import { buildAtlasLevel, type AtlasGraphLevel } from "./atlasLevels";
import { machineId } from "./buildMachineFlow";
import { step, workflow } from "./machineFlow.fixture";
import { TaskRunMotion } from "./TaskRunMotion";
import {
  ARRIVE_MS,
  MAX_TRAVELLING,
  TRAVEL_MS,
  along,
  railForMove,
  type MoveSource,
} from "./taskRunMotionModel";

const wf = (
  id: string,
  factory: string,
  steps: string[],
  to: string[] = []
): PipelineWorkflow => ({
  ...workflow(
    id,
    steps.map((s, i) =>
      step(s, i === steps.length - 1 ? "finish" : "execute", i)
    )
  ),
  factory_name: factory,
  transitions: to.map((target) => ({
    id: `${id}->${target}`,
    from_workflow_id: id,
    to_workflow_id: target,
    target_step_id: null,
    label: "",
  })),
});

const PROJECT: PipelineSummary = {
  workflows: [
    wf("build", "Dev", ["plan", "code", "done"], ["review", "ship"]),
    wf("review", "Dev", ["look", "ok"]),
    wf("ship", "Ops", ["pack", "sent"]),
  ],
};

const LEVELS: Record<string, AtlasGraphLevel> = {
  factories: { kind: "factories" },
  workflows: { kind: "workflows", factory: "Dev" },
  steps: { kind: "steps", factory: "Dev", workflowId: "build" },
};
const model = (level: AtlasGraphLevel) =>
  buildAtlasLevel(PROJECT, new Map(), level);

describe("railForMove", () => {
  it("finds the rail a move travels at each level", () => {
    // Between factories: only a move across factories travels.
    expect(
      railForMove(
        PROJECT,
        LEVELS.factories,
        model(LEVELS.factories),
        "done",
        "pack"
      )
    ).toBe(machineId("factory-route", "Dev", "Ops"));
    expect(
      railForMove(
        PROJECT,
        LEVELS.factories,
        model(LEVELS.factories),
        "done",
        "look"
      )
    ).toBeNull();
    // Inside a factory: the handoff rail, or the stub naming another factory.
    const inFactory = model(LEVELS.workflows);
    const toReview = railForMove(
      PROJECT,
      LEVELS.workflows,
      inFactory,
      "done",
      "look"
    );
    expect(inFactory.transitions.get(toReview!)).toMatchObject({
      workflowId: "build",
      targetWorkflowId: "review",
    });
    const toShip = railForMove(
      PROJECT,
      LEVELS.workflows,
      inFactory,
      "done",
      "pack"
    );
    expect(inFactory.spec.rails?.find((r) => r.id === toShip)?.to).toBe(
      `${machineId("stub", "out", "build", "Ops")}.in`
    );
    // A step move inside a workflow stays inside its station.
    expect(
      railForMove(PROJECT, LEVELS.workflows, inFactory, "plan", "code")
    ).toBeNull();
    // Inside a workflow: the step transition, or the handoff to the stub.
    const steps = model(LEVELS.steps);
    expect(railForMove(PROJECT, LEVELS.steps, steps, "plan", "code")).toBe(
      machineId("transition", "build", "plan", "code")
    );
    expect(railForMove(PROJECT, LEVELS.steps, steps, "done", "pack")).toBe(
      machineId("handoff", "build->ship")
    );
    expect(railForMove(PROJECT, LEVELS.steps, steps, null, "code")).toBeNull();
  });

  it("walks a polyline by length", () => {
    const pts = [
      [0, 0],
      [10, 0],
      [10, 30],
    ] as const;
    expect(along(pts, 0)).toEqual([0, 0]);
    expect(along(pts, 0.25)).toEqual([10, 0]);
    expect(along(pts, 0.5)).toEqual([10, 10]);
    expect(along(pts, 1)).toEqual([10, 30]);
  });
});

describe("TaskRunMotion", () => {
  const level = LEVELS.steps;
  const m = model(level);
  const rail = machineId("transition", "build", "plan", "code");
  const diagram = {
    width: 400,
    height: 200,
    rails: [
      {
        id: rail,
        points: [
          [0, 50],
          [200, 50],
        ],
      },
    ],
  } as unknown as DiagramTimeline;
  let emit: Parameters<MoveSource>[0] = () => undefined;
  const source: MoveSource = (onMove) => {
    emit = onMove;
    return () => undefined;
  };
  const move = (from: string, to: string, run = "run") =>
    act(() => emit({ from_step_id: from, to_step_id: to, task_run_id: run }));
  // Scheduled animation frames by id; a cancelled frame never runs.
  let frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let now = 0;
  beforeEach(() => {
    frames = new Map();
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.set(++nextFrame, cb);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  const step = (t: number) => {
    now = t;
    const pending = [...frames.values()];
    frames = new Map();
    act(() => pending.forEach((cb) => cb(t)));
  };
  const cards = (c: HTMLElement) => [
    ...c.querySelectorAll<SVGRectElement>(".uv-taskrun-card"),
  ];

  it("runs no animation frames while nothing happens", () => {
    const v = render(
      <TaskRunMotion
        summary={PROJECT}
        level={level}
        model={m}
        diagram={diagram}
        source={source}
        reducedMotion={false}
      />
    );
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(v.container.querySelector("svg")).toBeNull();
    // A move the level does not draw starts nothing either.
    move("look", "ok");
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("moves one card along the matching rail and stops when it arrives", () => {
    const v = render(
      <TaskRunMotion
        summary={PROJECT}
        level={level}
        model={m}
        diagram={diagram}
        source={source}
        reducedMotion={false}
      />
    );
    move("plan", "code");
    expect(cards(v.container)).toHaveLength(1);
    expect(cards(v.container)[0].dataset.rail).toBe(rail);
    step(1000 + TRAVEL_MS / 2);
    // Halfway along the 200 px rail (the card is 26 px wide).
    expect(cards(v.container)[0].getAttribute("x")).toBe(String(100 - 13));
    step(1000 + TRAVEL_MS + 1);
    expect(cards(v.container)).toHaveLength(0);
    // The loop ends with the last card: no frame is left scheduled.
    expect(frames.size).toBe(0);
  });

  it("caps travelling cards", () => {
    const v = render(
      <TaskRunMotion
        summary={PROJECT}
        level={level}
        model={m}
        diagram={diagram}
        source={source}
        reducedMotion={false}
      />
    );
    for (let i = 0; i < MAX_TRAVELLING + 3; i++) move("plan", "code", `r${i}`);
    expect(cards(v.container)).toHaveLength(MAX_TRAVELLING);
  });

  it("jumps instead of travelling under reduced motion", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const v = render(
        <TaskRunMotion
          summary={PROJECT}
          level={level}
          model={m}
          diagram={diagram}
          source={source}
          reducedMotion
        />
      );
      move("plan", "code");
      const [card] = cards(v.container);
      expect(card.getAttribute("x")).toBe(String(200 - 13));
      expect(window.requestAnimationFrame).not.toHaveBeenCalled();
      now = 1000 + ARRIVE_MS;
      act(() => vi.advanceTimersByTime(ARRIVE_MS));
      expect(cards(v.container)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
