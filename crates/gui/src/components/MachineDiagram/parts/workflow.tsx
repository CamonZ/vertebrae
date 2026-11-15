/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism components */
/**
 * workflow · a whole workflow as one station (catalogue v2.2 "workflow"):
 * one lamp per step in order, its core in the step type's hue and its rim
 * carrying the step execution's state, a type mark under each lamp, TaskRuns
 * at the station as chips, in W and one out port per outgoing workflow
 * transition (at most four, bundled past that). Endings happen at the lamps:
 * finish sinks the run into the finish lamp, a failure stops it at its lamp.
 * Prop-driven: each scenario names its steps and transitions, and its frame,
 * gates and status anchor come from `workflowLayout`. Ported from the gallery
 * (wfLay, wfLamp, wfMark, wfChips, build/draw) line for line.
 *
 * Keys on `step_type` and TaskRun state only, never on step names.
 */
import { Burst, PartBox, Spinner } from "../fixtures";
import { pop, smoothstep, valueAt, windowed } from "../motion";
import { roleColor, type CardRole, type StateRole } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import {
  card,
  gateV,
  note,
  seal,
  story,
  type LegInput,
  type StoryDraft,
} from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";
import {
  EDGE_IN,
  EDGE_OUT,
  LABEL_X,
  fitLabel,
  labelRoom,
  outIndex,
  stepHue,
  workflowLayout,
  type WorkflowLayout,
} from "./workflowSpec";

/** Step-execution state on a lamp's rim. */
export type LampState = "off" | "run" | "park" | "ok" | "fail";
export type WorkflowLampStep = readonly [t: number, state: LampState];

/** A TaskRun at the station: pops in at `born`, shrinks out at `gone`. */
export interface WorkflowChip {
  readonly born: number;
  readonly gone?: number;
  /** Colour over time, first entry at -∞: ink active, amber parked, red failed. */
  readonly col: readonly (readonly [number, CardRole])[];
}

/** A lit out port: amber gate and ink label over `w`, naming the target it left for. */
export interface WorkflowPortLight {
  readonly w: readonly [number, number];
  readonly to: string;
}

export interface WorkflowExtra {
  readonly steps: readonly string[];
  readonly transitions: readonly string[];
  readonly layout: WorkflowLayout;
  /** One rim timeline per lamp. */
  readonly lamps: readonly (readonly WorkflowLampStep[])[];
  readonly chips: readonly WorkflowChip[];
  /** Lit windows per out port (several when a flow hands off more than once). */
  readonly ports: readonly (readonly WorkflowPortLight[])[];
  /** Bursts on a lamp: `[lamp index, at, role]` (red on failure, green on finish). */
  readonly bursts: readonly (readonly [number, number, StateRole])[];
}

/* ---------- fixtures ---------- */

const RIM: Record<Exclude<LampState, "off" | "run">, StateRole> = {
  park: "amber",
  ok: "green",
  fail: "red",
};

/** The rim state at `t` and the window it holds for. */
export function lampStateAt(
  list: readonly WorkflowLampStep[],
  t: number
): { state: LampState; from: number; to: number; reached: number | null } {
  let state: LampState = "off";
  let from = 0;
  let to = 1e9;
  for (let i = 0; i < list.length; i++)
    if (t >= list[i][0]) {
      state = list[i][1];
      from = list[i][0];
      to = list[i + 1] ? list[i + 1][0] : 1e9;
    }
  const first = list.find((q) => q[1] !== "off");
  return { state, from, to, reached: first ? first[0] : null };
}

/**
 * A step lamp: the core in the step type's hue (40% until reached, then it
 * pops to full), state on the rim: executing an amber spinner, waiting a
 * still amber ring, completed green, failed red.
 */
export function WorkflowLamp({
  x,
  y,
  type,
  list,
  t,
}: {
  x: number;
  y: number;
  type: string;
  list: readonly WorkflowLampStep[];
  t: number;
}) {
  const { fade } = usePart();
  const { state, from, to, reached } = lampStateAt(list, t);
  const on = state !== "off" && reached !== null;
  const k = on ? Math.min(1.1, 0.75 + 0.25 * pop(t - reached)) : 1;
  const hue = stepHue(type);
  const ringK = Math.max(0, Math.min(1.1, pop(t - from)));
  return (
    <g
      className="md-lamp md-step-lamp"
      data-step-type={type}
      data-hue={hue}
      data-rim={state}
    >
      <circle
        cx={x}
        cy={y}
        r={9}
        fill={roleColor("hole")}
        stroke={roleColor("edge")}
        strokeWidth={1.5}
      />
      <circle
        className="md-step-core"
        cx={x}
        cy={y}
        r={Math.max(0, 6.5 * Math.min(k, 1.1))}
        fill={roleColor(hue)}
        opacity={fade * (on ? 1 : 0.4)}
      />
      {state === "run" && (
        <Spinner x={x} y={y} t={t} from={from} to={to} r={14} />
      )}
      {(state === "park" || state === "ok" || state === "fail") && (
        <circle
          className="md-step-rim"
          cx={x}
          cy={y}
          r={13 * ringK}
          fill="none"
          stroke={roleColor(RIM[state])}
          strokeWidth={state === "ok" ? 2 : 3}
          opacity={fade}
        />
      )}
    </g>
  );
}

/** The type mark under a lamp: the step type in shape, plate grey, 18 px wide. */
export function TypeMark({
  x,
  y,
  type,
}: {
  x: number;
  y: number;
  type: string;
}) {
  const plate = roleColor("plate");
  const line = {
    fill: "none",
    stroke: plate,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  let body;
  switch (type) {
    case "llm_inference":
      body = (
        <path
          d={`M${x - 9} ${y - 5}h18v3h-18z M${x - 9} ${y + 2}h18v3h-18z`}
          fill={plate}
        />
      );
      break;
    case "structured_inference":
      body = [-7, 0, 7].map((d) => (
        <circle key={d} cx={x + d} cy={y} r={2} fill={plate} />
      ));
      break;
    case "execute":
      body = <rect x={x - 5} y={y - 5} width={10} height={10} fill={plate} />;
      break;
    case "route":
      body = (
        <path
          d={`M${x} ${y + 6}L${x} ${y}L${x - 7} ${y - 6}M${x} ${y}L${x + 7} ${y - 6}`}
          {...line}
        />
      );
      break;
    case "wait_children":
      body = (
        <path
          d={`M${x} ${y - 6}L${x - 7} ${y + 6}M${x} ${y - 6}L${x} ${y + 6}M${x} ${y - 6}L${x + 7} ${y + 6}`}
          {...line}
        />
      );
      break;
    case "human_input":
      body = <circle cx={x} cy={y} r={5} {...line} />;
      break;
    case "stop":
      body = (
        <>
          <path d={`M${x} ${y - 6}L${x} ${y + 1}`} {...line} />
          <rect x={x - 8} y={y + 1} width={16} height={4} fill={plate} />
        </>
      );
      break;
    case "finish":
      body = (
        <>
          <circle cx={x} cy={y} r={6} {...line} />
          <circle cx={x} cy={y} r={2.5} fill={plate} />
        </>
      );
      break;
    default:
      return null;
  }
  return (
    <g className="md-type-mark" data-step-type={type}>
      {body}
    </g>
  );
}

/**
 * TaskRuns at a station (workflow or factory): one chip per run,
 * right-aligned, 20 px apart.
 */
export function StationChips({
  chips,
  t,
  x,
  y,
}: {
  chips: readonly WorkflowChip[];
  t: number;
  x: number;
  y: number;
}) {
  const { fade } = usePart();
  return (
    <>
      {chips.map((q, i) => {
        const gone = q.gone ?? 1e9;
        const k =
          (t < q.born ? 0 : Math.min(pop(t - q.born), 1.15)) *
          (1 - smoothstep(gone, gone + 0.2, t));
        if (k <= 0.01) return null;
        const cx = x - i * 20;
        const role = valueAt(q.col, t);
        return (
          <rect
            key={i}
            className="md-chip"
            data-role={role}
            x={cx - 7 * k}
            y={y - 7 * k}
            width={14 * k}
            height={14 * k}
            rx={4 * k}
            fill={roleColor(role)}
            opacity={fade}
          />
        );
      })}
    </>
  );
}

/** A port label 18 px above its rail: dim at rest, ink 600 while its port is lit. */
export function StationPortLabel({
  x,
  y,
  text,
  lit,
  align,
}: {
  x: number;
  y: number;
  text: string;
  lit: boolean;
  align: "left" | "right";
}) {
  return (
    <SvgText
      x={x}
      y={y - 18}
      runs={[[text, lit ? 600 : 400, lit ? "ink" : "dim"]]}
      size={18}
      align={align}
    />
  );
}

/** The whole station at `t`: rails, port labels, frame, track, lamps, marks, bursts, chips. */
export function WorkflowStation({ t, x }: { t: number; x: WorkflowExtra }) {
  const L = x.layout;
  const { ty, x0, x1, y0, w, h, turn } = L;
  return (
    <>
      <Rail
        points={[
          [EDGE_IN, ty],
          [x0, ty],
        ]}
      />
      {L.outs.map((o, j) => {
        const lit = (x.ports[j] ?? []).find((p) => windowed(t, ...p.w) > 0.3);
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
              text={
                lit && o.bundle
                  ? fitLabel(`→ ${lit.to}`, labelRoom(x1))
                  : o.label
              }
              lit={!!lit}
              align="right"
            />
          </g>
        );
      })}
      <PartBox x={x0} y={y0} w={w} h={h} />
      <Rail
        points={[
          [x0, ty],
          [L.outs.length ? turn : (L.lamps.at(-1)?.x ?? x0), ty],
        ]}
      />
      {L.outs.map((o) => (
        <Rail
          key={o.port}
          points={
            o.y === ty
              ? [
                  [turn, ty],
                  [x1, ty],
                ]
              : [
                  [turn, ty],
                  [turn, o.y],
                  [x1, o.y],
                ]
          }
        />
      ))}
      {L.lamps.map((l, i) => (
        <g key={i}>
          <WorkflowLamp
            x={l.x}
            y={l.y}
            type={l.type}
            list={x.lamps[i] ?? OFF}
            t={t}
          />
          <TypeMark x={l.x} y={l.y + 26} type={l.type} />
        </g>
      ))}
      {x.bursts.map(([i, at, role], k) => {
        const l = L.lamps[i];
        return l ? (
          <Burst
            key={k}
            x={l.x}
            y={l.y}
            t={t}
            at={at}
            role={role}
            r0={10}
            r1={44}
          />
        ) : null;
      })}
      <StationChips chips={x.chips} t={t} x={L.chips.x} y={L.chips.y} />
    </>
  );
}

const OFF: readonly WorkflowLampStep[] = [[0, "off"]];

/* ---------- scenarios ---------- */

type ScenarioName =
  | "completes"
  | "fails at a step"
  | "parks at a gate"
  | "hands off"
  | "hands off · bundled";

/** Each scenario names its own props (catalogue "Scenarios"). */
export const WORKFLOW_SCENARIO_PROPS: Readonly<
  Record<ScenarioName, readonly [readonly string[], readonly string[]]>
> = {
  completes: [["llm_inference", "execute", "finish"], []],
  "fails at a step": [
    ["structured_inference", "execute", "finish"],
    ["deploy"],
  ],
  "parks at a gate": [
    [
      "llm_inference",
      "structured_inference",
      "execute",
      "route",
      "wait_children",
      "llm_inference",
      "human_input",
      "execute",
      "finish",
    ],
    ["release"],
  ],
  "hands off": [
    [
      "llm_inference",
      "structured_inference",
      "execute",
      "llm_inference",
      "execute",
      "structured_inference",
      "llm_inference",
      "execute",
      "route",
    ],
    ["review", "docs", "release"],
  ],
  "hands off · bundled": [
    ["llm_inference", "execute", "structured_inference", "execute", "route"],
    ["review", "docs", "release", "rework", "triage", "archive"],
  ],
};

const STILL: Record<ScenarioName, number> = {
  completes: 2.3,
  "fails at a step": 2.9,
  "parks at a gate": 4.3,
  "hands off": 4.0,
  "hands off · bundled": 3.45,
};

function workflowStory(name: ScenarioName): PartScenario<WorkflowExtra> {
  const [steps, transitions] = WORKFLOW_SCENARIO_PROPS[name];
  const L = workflowLayout(steps, transitions);
  const s: StoryDraft = story(5.0);
  const ty = L.ty;
  const X = (i: number) => L.lamps[i].x;
  const n = steps.length;
  const lamps: WorkflowLampStep[][] = steps.map(() => [[0, "off"]]);
  const chips: WorkflowChip[] = [];
  const ports: WorkflowPortLight[][] = L.outs.map(() => []);
  const bursts: [number, number, StateRole][] = [];
  const legs: LegInput[] = [
    [
      [
        [EDGE_IN, ty],
        [X(0), ty],
      ],
      0.5,
      0.6,
    ],
  ];
  const hop = (i: number, t0: number) =>
    legs.push([
      [
        [X(i - 1), ty],
        [X(i), ty],
      ],
      t0,
      0.3,
    ]);
  const run = (i: number, a: number, b: number, end: LampState = "ok") =>
    lamps[i].push([a, "run"], [b, end]);
  const handoff = (to: string, t0: number) => {
    const j = outIndex(L, to);
    const o = L.outs[j];
    ports[j].push({ w: [t0, t0 + 0.8], to });
    legs.push([
      [
        [X(n - 1), ty],
        [L.turn, ty],
        [L.turn, o.y],
        [L.x1, o.y],
        [EDGE_OUT, o.y],
      ],
      t0,
      0.75,
    ]);
  };
  const ty_ = (i: number) => steps[i];
  note(s, 0.5, "run enters", "ink");

  if (name === "completes") {
    chips.push({ born: 0.6, gone: 3.4, col: [[-1e9, "ink"]] });
    run(0, 1.0, 1.8);
    hop(1, 1.8);
    run(1, 2.0, 2.7);
    hop(2, 2.7);
    run(2, 2.95, 3.1);
    bursts.push([2, 3.1, "green"]);
    note(s, 1.0, `step 1/3 · ${ty_(0)}`, "ink");
    note(s, 2.0, `step 2/3 · ${ty_(1)}`, "ink");
    note(s, 3.1, "finish · task done", "green");
    s.cards.push(
      card(28, "ink", legs, 0.5, 3.2, {
        col: [[3.0, "green"]],
        tags: [["run", 0.55, 0.95]],
      })
    );
  } else if (name === "fails at a step") {
    chips.push({
      born: 0.6,
      col: [
        [-1e9, "ink"],
        [2.6, "red"],
      ],
    });
    run(0, 1.0, 1.7);
    hop(1, 1.7);
    run(1, 1.9, 2.6, "fail");
    bursts.push([1, 2.6, "red"]);
    note(s, 1.0, `step 1/3 · ${ty_(0)}`, "ink");
    note(s, 1.9, `step 2/3 · ${ty_(1)}`, "ink");
    note(s, 2.6, `failed at step 2 · ${ty_(1)} · reason saved`, "red");
    s.cards.push(
      card(28, "ink", legs, 0.5, 4.6, {
        col: [[2.6, "red"]],
        tags: [
          ["run", 0.55, 0.95],
          ["script error", 2.65, 3.6],
        ],
      })
    );
  } else if (name === "parks at a gate") {
    s.period = 7.0;
    chips.push(
      { born: -1, col: [[-1e9, "amber"]] },
      { born: -1, col: [[-1e9, "amber"]] },
      {
        born: 0.6,
        gone: 6.1,
        col: [
          [-1e9, "ink"],
          [3.5, "amber"],
          [5.2, "ink"],
        ],
      }
    );
    for (let i = 0; i < 6; i++) {
      const a = 1.0 + 0.4 * i;
      run(i, a, a + 0.25);
      hop(i + 1, a + 0.25);
    }
    lamps[6].push([3.5, "park"], [5.2, "ok"]);
    hop(7, 5.2);
    run(7, 5.4, 5.75);
    hop(8, 5.75);
    run(8, 5.95, 6.05);
    bursts.push([8, 6.05, "green"]);
    note(s, 1.0, "steps 1–6 · executing", "ink");
    note(s, 3.5, `waiting · ${ty_(6)} · 3 parked`, "amber");
    note(s, 5.2, "answered · step 8/9", "ink");
    note(s, 6.05, "finish · task done", "green");
    s.cards.push(
      card(28, "ink", legs, 0.5, 6.25, {
        col: [[5.95, "green"]],
        tags: [
          ["run", 0.55, 0.95],
          ["answer", 5.2, 5.7],
        ],
      })
    );
  } else if (name === "hands off") {
    s.period = 5.6;
    chips.push(
      { born: -1, col: [[-1e9, "ink"]] },
      { born: 0.6, gone: 4.5, col: [[-1e9, "ink"]] }
    );
    for (let i = 0; i < 8; i++) {
      const a = 1.0 + 0.3 * i;
      run(i, a, a + 0.2);
      hop(i + 1, a + 0.2);
    }
    run(8, 3.4, 3.75);
    handoff("docs", 3.75);
    note(s, 1.0, "steps 1–8 · executing", "ink");
    note(s, 3.4, `step 9/9 · ${ty_(8)}`, "ink");
    note(s, 3.75, "handed off → docs", "green");
    s.cards.push(
      card(28, "ink", legs, 0.5, 4.6, { tags: [["run", 0.55, 0.95]] })
    );
  } else {
    s.period = 5.0;
    chips.push({ born: 0.6, gone: 3.9, col: [[-1e9, "ink"]] });
    for (let i = 0; i < 4; i++) {
      const a = 1.0 + 0.4 * i;
      run(i, a, a + 0.25);
      hop(i + 1, a + 0.25);
    }
    run(4, 2.75, 3.15);
    handoff("triage", 3.15);
    note(s, 1.0, "steps 1–4 · executing", "ink");
    note(s, 2.75, `step 5/5 · ${ty_(4)}`, "ink");
    note(s, 3.15, "handed off → triage", "green");
    s.cards.push(
      card(28, "ink", legs, 0.5, 4.0, { tags: [["run", 0.55, 0.95]] })
    );
  }
  // In W, then one gate per out port that lights amber while a run leaves by it.
  s.gates.push(
    gateV(L.x0, ty),
    ...L.outs.map((o, j) =>
      gateV(L.x1, o.y, (t) =>
        Math.max(0, ...ports[j].map((p) => windowed(t, ...p.w)))
      )
    )
  );
  return {
    name,
    still: STILL[name],
    timeline: seal(s),
    bb: L.bb,
    status: L.status,
    extra: {
      steps,
      transitions,
      layout: L,
      lamps,
      chips,
      ports,
      bursts,
    },
  };
}

const SCENARIOS = [
  workflowStory("completes"),
  workflowStory("fails at a step"),
  workflowStory("parks at a gate"),
  workflowStory("hands off"),
  workflowStory("hands off · bundled"),
] as const;

export const workflowMachine: MachinePartDef<WorkflowExtra> = {
  part: {
    name: "workflow",
    job: "a whole workflow as one station",
    aka: "Workflow · factory station · steps by step_type",
  },
  family: "vertebrae workflows",
  footprint: "M",
  // Scenario 0's three-step frame; each scenario carries its own (S.bb).
  bb: SCENARIOS[0].bb!,
  status: SCENARIOS[0].status!,
  scenarios: SCENARIOS,
  draw: (t, extra) => <WorkflowStation t={t} x={extra} />,
};
