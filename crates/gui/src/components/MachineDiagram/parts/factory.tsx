/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism components */
/**
 * factory · a whole factory as one station (catalogue v2.2 "factory"): the
 * workflow station one level up. One workflow mark per workflow in factory
 * order (a mini workflow station: box, rail stubs, one dot per step up to
 * five), state on the mark's outline, TaskRuns at the station as chips, in
 * ports per inbound factory and out ports per outbound factory (at most four
 * a side, bundled past that). Endings happen at the marks: a finished task
 * sinks into its mark, a failed one stops at it; only a cross-factory
 * hand-off leaves. Prop-driven: each scenario names its workflows and
 * routes, and its frame, gates and status anchor come from `factoryLayout`.
 * Ported from the gallery (fPorts, fLay, fMark, build/draw) line for line;
 * chips, port labels, bundling and lamp-state lookup are the workflow
 * station's.
 *
 * Keys on TaskRun state and workflow structure (order, step counts) only,
 * never on factory or workflow names.
 */
import { Burst, PartBox } from "../fixtures";
import { pop, windowed } from "../motion";
import { roleColor, type CardRole, type StateRole } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { card, note, seal, story, type LegInput } from "../timeline";
import {
  IN_LABEL_X,
  MARK_DOTS,
  factoryGates,
  factoryLayout,
  factoryOutIndex,
  inIndex,
  litInLabel,
  litOutLabel,
  type FactoryLayout,
} from "./factorySpec";
import type { MachinePartDef, PartScenario } from "./types";
import {
  StationChips,
  StationPortLabel,
  lampStateAt,
  type LampState,
  type WorkflowChip,
  type WorkflowLampStep,
  type WorkflowPortLight,
} from "./workflow";
import { EDGE_IN, EDGE_OUT, LABEL_X } from "./workflowSpec";

/** A workflow mark's state over time: the workflow station's lamp states. */
export type MarkState = LampState;
export type FactoryMarkStep = WorkflowLampStep;

export interface FactoryExtra {
  readonly workflows: readonly number[];
  readonly inbound: readonly string[];
  readonly outbound: readonly string[];
  readonly layout: FactoryLayout;
  /** One outline timeline per workflow mark. */
  readonly marks: readonly (readonly FactoryMarkStep[])[];
  readonly chips: readonly WorkflowChip[];
  /** Lit windows per in port; `to` names the factory the work came from. */
  readonly ins: readonly (readonly WorkflowPortLight[])[];
  /** Lit windows per out port; `to` names the factory it left for. */
  readonly outs: readonly (readonly WorkflowPortLight[])[];
  /** Bursts on a mark: `[mark index, at, role]` (red on failure, green on finish). */
  readonly bursts: readonly (readonly [number, number, StateRole])[];
}

/* ---------- fixtures ---------- */

const OUTLINE: Record<MarkState, CardRole> = {
  off: "edge",
  run: "ink",
  park: "amber",
  ok: "green",
  fail: "red",
};

/** Dot colours of a mark at `t`: amber in order while working, green done, the last red on failure. */
export function markDots(
  steps: number,
  state: MarkState,
  since: number,
  t: number
): CardRole[] {
  const d = Math.min(Math.max(1, steps), MARK_DOTS);
  const lit = Math.floor((t - since) * 5) % d;
  return Array.from({ length: d }, (_, i) =>
    state === "run" && lit === i
      ? "amber"
      : state === "ok"
        ? "green"
        : state === "fail" && i === d - 1
          ? "red"
          : "edge"
  );
}

/**
 * A workflow mark: a 32×22 mini station with rail stubs and one dot per
 * step (up to five). Pending: edge outline. Working: ink outline (pops on
 * change), the dots light amber in order. Parked: amber outline and a still
 * amber ring. Completed: green. Failed: red (the burst is the station's).
 */
export function WorkflowMark({
  x,
  y,
  steps,
  list,
  t,
}: {
  x: number;
  y: number;
  steps: number;
  list: readonly FactoryMarkStep[];
  t: number;
}) {
  const { fade } = usePart();
  const { state, from } = lampStateAt(list, t);
  const off = state === "off";
  const k = off ? 1 : Math.min(1.08, 0.9 + 0.1 * pop(t - from));
  const dots = markDots(steps, state, from, t);
  const sx = x - (dots.length - 1) * 2.75;
  return (
    <g
      className="md-workflow-mark"
      data-state={state}
      data-steps={steps}
      data-outline={OUTLINE[state]}
    >
      <path
        d={`M${x - 24} ${y}H${x - 17}M${x + 17} ${y}H${x + 24}`}
        stroke={roleColor("rail")}
        strokeWidth={2}
        fill="none"
      />
      <rect
        className="md-mark-box"
        transform={`translate(${x} ${y}) scale(${k})`}
        x={-16}
        y={-11}
        width={32}
        height={22}
        rx={6}
        fill={roleColor("fill")}
        stroke={roleColor(OUTLINE[state])}
        strokeWidth={off ? 1.5 : state === "ok" ? 2 : 2.5}
        strokeOpacity={off ? 1 : fade}
      />
      {dots.map((role, i) => (
        <circle
          key={i}
          className="md-mark-dot"
          data-role={role}
          cx={sx + i * 5.5}
          cy={y}
          r={2}
          fill={roleColor(role)}
          opacity={fade}
        />
      ))}
      {state === "park" && (
        <circle
          className="md-mark-ring"
          cx={x}
          cy={y}
          r={8}
          fill="none"
          stroke={roleColor("amber")}
          strokeWidth={2.5}
          opacity={fade}
        />
      )}
    </g>
  );
}

const OFF: readonly FactoryMarkStep[] = [[0, "off"]];

/** The whole station at `t`: rails, port labels, frame, tracks, marks, bursts, chips. */
export function FactoryStation({ t, x }: { t: number; x: FactoryExtra }) {
  const L = x.layout;
  const { x0, x1, y0, w, h } = L;
  const [d0x, d0y] = L.marks[0].dock;
  const lastX = L.marks[L.marks.length - 1].x;
  const litOf = (list: readonly WorkflowPortLight[] | undefined) =>
    (list ?? []).find((p) => windowed(t, ...p.w) > 0.3);
  return (
    <>
      {L.ins.map((o, j) => {
        const lit = o.label ? litOf(x.ins[j]) : undefined;
        return (
          <g
            key={o.port}
            data-port={o.port}
            data-lit={lit ? "true" : undefined}
          >
            <Rail
              points={[
                [EDGE_IN, o.y],
                [x0, o.y],
              ]}
            />
            {o.label && (
              <StationPortLabel
                x={IN_LABEL_X}
                y={o.y}
                text={lit && o.bundle ? litInLabel(L, lit.to) : o.label}
                lit={!!lit}
                align="left"
              />
            )}
          </g>
        );
      })}
      {L.outs.map((o, j) => {
        const lit = litOf(x.outs[j]);
        return (
          <g
            key={o.port}
            data-port={o.port}
            data-lit={lit ? "true" : undefined}
          >
            <Rail
              points={[
                [x1, o.y],
                [EDGE_OUT, o.y],
              ]}
            />
            <StationPortLabel
              x={LABEL_X}
              y={o.y}
              text={lit && o.bundle ? litOutLabel(L, lit.to) : o.label}
              lit={!!lit}
              align="right"
            />
          </g>
        );
      })}
      <PartBox x={x0} y={y0} w={w} h={h} />
      {L.ins.map((o) => (
        <Rail
          key={o.port}
          points={
            o.y === d0y
              ? [
                  [x0, o.y],
                  [d0x, d0y],
                ]
              : [
                  [x0, o.y],
                  [L.inTurn, o.y],
                  [L.inTurn, d0y],
                  [d0x, d0y],
                ]
          }
        />
      ))}
      {L.tracks.map(([a, b, y]) => (
        <Rail
          key={y}
          points={[
            [a, y],
            [b, y],
          ]}
        />
      ))}
      {L.outs.map((o) => (
        <Rail
          key={o.port}
          points={[
            [lastX, L.ty],
            [L.turn, L.ty],
            [L.turn, o.y],
            [x1, o.y],
          ]}
        />
      ))}
      {L.marks.map((m, i) => (
        <WorkflowMark
          key={i}
          x={m.x}
          y={m.y}
          steps={m.steps}
          list={x.marks[i] ?? OFF}
          t={t}
        />
      ))}
      {x.bursts.map(([i, at, role], k) => {
        const m = L.marks[i];
        return m ? (
          <Burst
            key={k}
            x={m.x}
            y={m.y}
            t={t}
            at={at}
            role={role}
            r0={12}
            r1={46}
          />
        ) : null;
      })}
      <StationChips chips={x.chips} t={t} x={L.chips.x} y={L.chips.y} />
    </>
  );
}

/* ---------- scenarios ---------- */

type ScenarioName =
  | "enters and finishes"
  | "fails into needs attention"
  | "a workflow parks at a gate"
  | "hands off to another factory";

const W13 = [4, 6, 3, 9, 5, 2, 7, 4, 3, 6, 5, 8, 3] as const;

/** Each scenario names its own props (catalogue "Scenarios"): workflows, inbound, outbound. */
export const FACTORY_SCENARIO_PROPS: Readonly<
  Record<
    ScenarioName,
    readonly [readonly number[], readonly string[], readonly string[]]
  >
> = {
  "enters and finishes": [[3, 5], [], []],
  "fails into needs attention": [[4, 6], [], ["Release"]],
  "a workflow parks at a gate": [W13, ["Intake", "Bugs"], ["Release"]],
  "hands off to another factory": [
    W13,
    ["Intake"],
    ["Release", "Review", "Docs", "Deploy", "Triage", "Archive"],
  ],
};

const STILL: Record<ScenarioName, number> = {
  "enters and finishes": 2.8,
  "fails into needs attention": 3.0,
  "a workflow parks at a gate": 4.3,
  "hands off to another factory": 3.85,
};

function factoryStory(name: ScenarioName): PartScenario<FactoryExtra> {
  const [workflows, inbound, outbound] = FACTORY_SCENARIO_PROPS[name];
  const L = factoryLayout(workflows, inbound, outbound);
  const s = story(5.0);
  const D = (i: number) => L.marks[i].dock;
  const marks: FactoryMarkStep[][] = workflows.map(() => [[0, "off"]]);
  const chips: WorkflowChip[] = [];
  const ins: WorkflowPortLight[][] = L.ins.map(() => []);
  const outs: WorkflowPortLight[][] = L.outs.map(() => []);
  const bursts: [number, number, StateRole][] = [];
  const legs: LegInput[] = [];
  const enter = (from: string | null, t0: number) => {
    const j = from ? inIndex(L, from) : 0;
    const o = L.ins[j];
    if (from) ins[j].push({ w: [t0, t0 + 0.7], to: from });
    const [dx, dy] = D(0);
    legs.push([
      [
        [EDGE_IN, o.y],
        [L.inTurn, o.y],
        [L.inTurn, dy],
        [dx, dy],
      ],
      t0,
      0.7,
    ]);
  };
  const hop = (i: number, t0: number) =>
    legs.push([[D(i - 1), D(i)], t0, 0.35]);
  const run = (i: number, a: number, b: number, end: MarkState = "ok") =>
    marks[i].push([a, "run"], [b, end]);
  const handoff = (i: number, to: string, t0: number) => {
    const j = factoryOutIndex(L, to);
    const o = L.outs[j];
    const [dx, dy] = D(i);
    outs[j].push({ w: [t0, t0 + 0.8], to });
    legs.push([
      [
        [dx, dy],
        [L.turn, dy],
        [L.turn, o.y],
        [L.x1, o.y],
        [EDGE_OUT, o.y],
      ],
      t0,
      0.75,
    ]);
  };

  if (name === "enters and finishes") {
    enter(null, 0.5);
    chips.push({ born: 0.6, gone: 3.4, col: [[-1e9, "ink"]] });
    run(0, 1.2, 2.0);
    hop(1, 2.0);
    run(1, 2.35, 3.1);
    bursts.push([1, 3.1, "green"]);
    note(s, 0.5, "task enters", "ink");
    note(s, 1.2, "workflow 1/2", "ink");
    note(s, 2.35, "workflow 2/2", "ink");
    note(s, 3.1, "finish · task done", "green");
    s.cards.push(
      card(28, "ink", legs, 0.5, 3.2, {
        col: [[3.0, "green"]],
        tags: [["task", 0.55, 0.95]],
      })
    );
  } else if (name === "fails into needs attention") {
    enter(null, 0.5);
    chips.push({
      born: 0.6,
      col: [
        [-1e9, "ink"],
        [2.7, "red"],
      ],
    });
    run(0, 1.2, 2.0);
    hop(1, 2.0);
    run(1, 2.35, 2.7, "fail");
    bursts.push([1, 2.7, "red"]);
    note(s, 0.5, "task enters", "ink");
    note(s, 1.2, "workflow 1/2", "ink");
    note(s, 2.35, "workflow 2/2", "ink");
    note(s, 2.7, "failed in workflow 2/2 · needs attention", "red");
    s.cards.push(
      card(28, "ink", legs, 0.5, 4.6, {
        col: [[2.7, "red"]],
        tags: [
          ["task", 0.55, 0.95],
          ["step failed", 2.75, 3.7, 28],
        ],
      })
    );
  } else if (name === "a workflow parks at a gate") {
    s.period = 7.0;
    enter("Bugs", 0.5);
    chips.push(
      { born: -1, col: [[-1e9, "amber"]] },
      { born: -1, col: [[-1e9, "amber"]] },
      {
        born: 0.7,
        gone: 6.3,
        col: [
          [-1e9, "ink"],
          [3.3, "amber"],
          [5.0, "ink"],
        ],
      }
    );
    for (let i = 0; i < 5; i++) {
      const a = 1.25 + 0.4 * i;
      run(i, a, a + 0.25);
      hop(i + 1, a + 0.25);
    }
    marks[5].push([3.3, "park"], [5.0, "run"], [5.5, "ok"]);
    hop(6, 5.5);
    run(6, 5.85, 6.3);
    note(s, 0.5, "task enters from Bugs", "ink");
    note(s, 1.25, "workflows 1–5", "ink");
    note(s, 3.3, "workflow 6/13 waiting · gate · 3 parked", "amber");
    note(s, 5.0, "answered · workflow 6/13", "ink");
    note(s, 5.85, "workflow 7/13", "ink");
    s.cards.push(
      card(28, "ink", legs, 0.5, 6.6, { tags: [["task", 0.55, 0.95]] })
    );
  } else {
    s.period = 5.4;
    enter("Intake", 0.5);
    chips.push(
      { born: -1, col: [[-1e9, "ink"]] },
      { born: 0.7, gone: 4.3, col: [[-1e9, "ink"]] }
    );
    for (let i = 0; i < 7; i++) {
      const a = 1.25 + 0.3 * i;
      run(i, a, a + 0.2);
      hop(i + 1, a + 0.2);
    }
    run(7, 3.35, 3.65);
    handoff(7, "Deploy", 3.65);
    note(s, 0.5, "task enters from Intake", "ink");
    note(s, 1.25, "workflows 1–7", "ink");
    note(s, 3.35, "workflow 8/13", "ink");
    note(s, 3.65, "handed off → Deploy", "green");
    s.cards.push(
      card(28, "ink", legs, 0.5, 4.45, { tags: [["task", 0.55, 0.95]] })
    );
  }
  s.gates.push(...factoryGates(L, ins, outs));
  return {
    name,
    still: STILL[name],
    timeline: seal(s),
    bb: L.bb,
    status: L.status,
    extra: {
      workflows,
      inbound,
      outbound,
      layout: L,
      marks,
      chips,
      ins,
      outs,
      bursts,
    },
  };
}

const SCENARIOS = [
  factoryStory("enters and finishes"),
  factoryStory("fails into needs attention"),
  factoryStory("a workflow parks at a gate"),
  factoryStory("hands off to another factory"),
] as const;

export const factoryMachine: MachinePartDef<FactoryExtra> = {
  part: {
    name: "factory",
    job: "a whole factory as one station",
    aka: "factory · between-factories view",
  },
  family: "vertebrae workflows",
  footprint: "M",
  // Scenario 0's two-workflow frame; each scenario carries its own (S.bb).
  bb: SCENARIOS[0].bb!,
  status: SCENARIOS[0].status!,
  scenarios: SCENARIOS,
  draw: (t, extra) => <FactoryStation t={t} x={extra} />,
};
