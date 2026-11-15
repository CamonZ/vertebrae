/**
 * workflow · a whole workflow as one station (catalogue v2.2 "workflow").
 * Prop-driven: `steps` (step types in order, 1–20) and `transitions` (the
 * workflow's outgoing workflow transitions, by target) resolve the frame,
 * the status anchor, the ports (in W; out1…out4 E, the fourth bundling every
 * transition past three when there are more than four) and one stage per
 * lamp. There are no finished or needs-attention exits: finish, failure and
 * stop end at their lamps; only `hand off` leaves, by its transition's port.
 *
 * Verbs follow the gallery timings: the run enters in 0.5 s and seats at the
 * first lamp, a step hops on the thrown spring in 0.3 s, a handoff leaves in
 * 0.75 s with its port lit for 0.8 s. Everything keys on step types and
 * positions, never on step names.
 */
import { gateV, type CardSpec } from "../../timeline";
import type { CardRole, StateRole } from "../../palette";
import type {
  WorkflowChip,
  WorkflowExtra,
  WorkflowLampStep,
  WorkflowPortLight,
} from "../../parts/workflow";
import {
  PARKING_STEP_TYPES,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MIN_STEPS,
  isWorkflowStepType,
  outIndex,
  stepWords,
  workflowLayout,
  type WorkflowLayout,
  type WorkflowStepType,
} from "../../parts/workflowSpec";
import {
  HELD,
  tokenCard,
  type PartKindDef,
  type PartWriter,
  type PortDef,
  type StepCard,
  type VerbContext,
} from "../registry";
import { leg } from "./common";

export interface WorkflowProps {
  steps: readonly string[];
  transitions: readonly string[];
  /** Other TaskRuns already parked at the station (amber chips). */
  parked: number;
  /** Other TaskRuns already active at the station (ink chips). */
  active: number;
}

/** A chip the verbs recolour and retire as they compile. */
export type MutableChip = WorkflowChip & {
  col: [number, CardRole][];
  gone?: number;
};

interface Mutable {
  steps: readonly string[];
  transitions: readonly string[];
  layout: WorkflowLayout;
  lamps: WorkflowLampStep[][];
  chips: MutableChip[];
  ports: WorkflowPortLight[][];
  bursts: [number, number, StateRole][];
}

/**
 * The run at a station (workflow or factory): its card, colour, chip and
 * whether it is parked. Shared by both flow kinds' verbs.
 */
export interface StationRun {
  extra: { chips: MutableChip[] };
  card: StepCard | null;
  id: string | null;
  role: StateRole;
  cur: number;
  chip: number;
  waiting: boolean;
}

export interface WorkflowState extends StationRun {
  /** Mechanism timelines the drawing reads (WorkflowExtra). */
  extra: Mutable;
}

/** A verb context over any station run (the helpers below need only these). */
type RunCtx = { readonly out: PartWriter; readonly state: StationRun };

export const TRANSITION_TOKENS = [
  "payload",
  "request",
  "data",
  "result",
] as const;

/** Chips for the other TaskRuns already at the station: parked amber, then active ink. */
export const seedChips = (parked: number, active: number): MutableChip[] => [
  ...Array.from({ length: parked }, () => ({
    born: -1,
    col: [[-1e9, "amber"]] as [number, CardRole][],
  })),
  ...Array.from({ length: active }, () => ({
    born: -1,
    col: [[-1e9, "ink"]] as [number, CardRole][],
  })),
];

const propsOf = (props: Partial<WorkflowProps>) => ({
  steps: Array.isArray(props.steps) ? props.steps : [],
  transitions: Array.isArray(props.transitions) ? props.transitions : [],
});

/** In W on the track; one out per drawn transition port on the E edge. */
export function workflowPorts(L: WorkflowLayout): Record<string, PortDef> {
  return {
    in: {
      side: "W",
      x: L.x0,
      y: L.ty,
      direction: "in",
      tokens: TRANSITION_TOKENS,
      description: "the TaskRun (workflow transitions and task assignment)",
    },
    ...Object.fromEntries(
      L.outs.map((o) => [
        o.port,
        {
          side: "E",
          x: L.x1,
          y: o.y,
          direction: "out",
          tokens: TRANSITION_TOKENS,
          description: o.bundle
            ? `transitions to ${o.targets.join(", ")}`
            : `transition to ${o.targets[0]}`,
        } satisfies PortDef,
      ])
    ),
  };
}

const gatesOf = (L: WorkflowLayout) => [
  gateV(L.x0, L.ty),
  ...L.outs.map((o) => gateV(L.x1, o.y)),
];

/** The port a transition target leaves by (the bundle port past the cap). */
export function workflowPortFor(
  props: Pick<WorkflowProps, "steps" | "transitions">,
  target: string
): string | null {
  const L = workflowLayout(props.steps, props.transitions);
  const j = outIndex(L, target);
  return j < 0 ? null : L.outs[j].port;
}

const DEFAULT_PROPS = propsOf({
  steps: ["llm_inference", "execute", "finish"],
  transitions: [],
});
const DEFAULT_LAYOUT = workflowLayout(
  DEFAULT_PROPS.steps,
  DEFAULT_PROPS.transitions
);
const DEFAULT_PORTS = workflowPorts(DEFAULT_LAYOUT);

type Ctx = VerbContext<WorkflowProps, WorkflowState>;

const X = (ctx: Ctx, i: number) =>
  ctx.state.extra.layout.lamps[i]?.x ?? ctx.state.extra.layout.x0;
const last = (ctx: Ctx) => Math.max(0, ctx.state.extra.steps.length - 1);
const typeAt = (ctx: Ctx, i: number) => ctx.state.extra.steps[i] ?? "step";

/** Re-seat the run's card on new legs (it keeps its id across verbs). */
export function move(
  ctx: RunCtx,
  pts: readonly (readonly [number, number])[],
  t: number,
  d: number,
  dies: number,
  role: StateRole = ctx.state.role,
  extra: Partial<Pick<CardSpec, "tags">> = {}
) {
  const { out, state } = ctx;
  if (!state.id || !state.card) return;
  out.end(state.id, t);
  out.card(
    tokenCard(state.card, role, [leg(pts, t, d)], t, dies, {
      tags: (extra.tags ?? []).map(
        (x) => [x.text, x.from, x.to, x.dy] as const
      ),
    })
  );
  state.role = role;
}

/** The run's chip changes colour at `t`. */
export function chipTo(ctx: RunCtx, t: number, role: CardRole) {
  const chip = ctx.state.extra.chips[ctx.state.chip];
  if (chip) chip.col.push([t, role]);
}

/** The run's chip shrinks out at `t` (once). */
export function chipGone(ctx: RunCtx, t: number) {
  const chip = ctx.state.extra.chips[ctx.state.chip];
  if (chip && chip.gone === undefined) chip.gone = t;
}

/** TaskRuns parked (amber chips) at the station at `t`. */
export function parkedCount(ctx: RunCtx, t: number) {
  return ctx.state.extra.chips.filter(
    (c) =>
      (c.gone === undefined || c.gone > t) &&
      c.col.filter(([at]) => at <= t + 1e-9).at(-1)?.[1] === "amber"
  ).length;
}

export const workflowPart: PartKindDef<WorkflowProps, WorkflowState> = {
  kind: "workflow",
  job: "a whole workflow as one station",
  family: "vertebrae workflows",
  footprint: "M",
  bb: DEFAULT_LAYOUT.bb,
  status: DEFAULT_LAYOUT.status,
  props: {
    steps: {
      type: "string[]",
      default: DEFAULT_PROPS.steps,
      description:
        "step types in order, 1–20 (llm_inference, structured_inference, execute, route, wait_children, human_input, stop, finish); never step names",
    },
    transitions: {
      type: "string[]",
      default: [],
      description:
        "the workflow's outgoing workflow transitions, labelled by target; ports out1…out4, the fourth bundling the rest past four (workflowPortFor)",
    },
    parked: {
      type: "integer",
      min: 0,
      max: 8,
      default: 0,
      description: "other TaskRuns already parked at the station (amber chips)",
    },
    active: {
      type: "integer",
      min: 0,
      max: 8,
      default: 0,
      description: "other TaskRuns already active at the station (ink chips)",
    },
  },
  ports: DEFAULT_PORTS,
  resolve: (props) => {
    const { steps, transitions } = propsOf(props);
    const L = workflowLayout(steps, transitions);
    return {
      bb: L.bb,
      status: L.status,
      ports: workflowPorts(L),
      gates: () => gatesOf(L),
    };
  },
  checkProps: (props) => {
    const errors: { path: string; message: string }[] = [];
    const { steps, transitions } = propsOf(props);
    if (steps.length < WORKFLOW_MIN_STEPS || steps.length > WORKFLOW_MAX_STEPS)
      errors.push({
        path: "steps",
        message: `a workflow station draws ${WORKFLOW_MIN_STEPS}–${WORKFLOW_MAX_STEPS} steps (got ${steps.length})`,
      });
    steps.forEach((s, i) => {
      if (!isWorkflowStepType(s))
        errors.push({
          path: `steps[${i}]`,
          message: `"${s}" is not a step type`,
        });
    });
    if (new Set(transitions).size !== transitions.length)
      errors.push({
        path: "transitions",
        message: "transition targets must be unique",
      });
    if ((props.parked ?? 0) + (props.active ?? 0) > 8)
      errors.push({
        path: "parked",
        message: "at most 8 other TaskRuns fit the chip tray",
      });
    return errors;
  },
  gates: () => gatesOf(DEFAULT_LAYOUT),
  stages: (props) => {
    const { steps, transitions } = propsOf(props);
    return workflowLayout(steps, transitions).stages;
  },
  init: (props) => {
    const { steps, transitions } = propsOf(props);
    const layout = workflowLayout(steps, transitions);
    const chips = seedChips(
      Number(props.parked ?? 0),
      Number(props.active ?? 0)
    );
    return {
      extra: {
        steps,
        transitions,
        layout,
        lamps: steps.map((): WorkflowLampStep[] => [[0, "off"]]),
        chips,
        ports: layout.outs.map(() => []),
        bursts: [],
      },
      card: null,
      id: null,
      role: "ink",
      cur: 0,
      chip: -1,
      waiting: false,
    };
  },
  verbs: {
    enter: {
      duration: 1.0,
      card: "required",
      tokens: TRANSITION_TOKENS,
      description:
        "a TaskRun enters by its workflow transition and starts the first step",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const L = state.extra.layout;
        out.carry(
          [
            leg(
              [
                [L.x0, L.ty],
                [X(ctx, 0), L.ty],
              ],
              t,
              0.5
            ),
          ],
          t,
          HELD,
          { role: "ink", tags: [["run", t + 0.05, t + 0.45]] }
        );
        state.card = card!;
        state.id = card!.id;
        state.role = "ink";
        state.cur = 0;
        state.waiting = false;
        state.chip = state.extra.chips.length;
        state.extra.chips.push({ born: t + 0.1, col: [[-1e9, "ink"]] });
        state.extra.lamps[0]?.push([t + 0.5, "run"]);
        out.note(t, "run enters", "ink");
        out.note(t + 0.5, stepWords(state.extra.steps, 0), "ink");
      },
    },
    step: {
      duration: 0.6,
      card: "none",
      description:
        "the working step completes and the run hops to the next one (or to step `to`, as a route picks)",
      args: {
        to: {
          type: "integer",
          min: 1,
          max: WORKFLOW_MAX_STEPS,
          description: "1-based step the run moves to (default: the next)",
        },
      },
      compile(ctx) {
        const { t, out, state, args } = ctx;
        const L = state.extra.layout;
        const from = state.cur;
        const to = Math.min(
          last(ctx),
          args.to !== undefined ? Number(args.to) - 1 : from + 1
        );
        const resumed = state.waiting;
        state.waiting = false;
        state.extra.lamps[from]?.push([t, "ok"]);
        if (resumed) chipTo(ctx, t, "ink");
        if (to !== from)
          move(
            ctx,
            [
              [X(ctx, from), L.ty],
              [X(ctx, to), L.ty],
            ],
            t,
            0.3,
            HELD
          );
        state.cur = to;
        state.extra.lamps[to]?.push([t + 0.2, "run"]);
        out.note(
          t + (resumed ? 0 : 0.2),
          resumed
            ? `answered · step ${to + 1}/${state.extra.steps.length}`
            : stepWords(state.extra.steps, to),
          "ink"
        );
      },
    },
    wait: {
      duration: 0.8,
      card: "none",
      description:
        "a human_input or wait_children step parks the run (still amber rim, amber chip) until it is answered",
      compile(ctx) {
        const { t, out, state } = ctx;
        const type = typeAt(ctx, state.cur);
        const parks = PARKING_STEP_TYPES.includes(type as WorkflowStepType);
        if (!parks) {
          // Only parking step types take the waiting rim; others keep executing.
          out.note(
            t,
            `${stepWords(state.extra.steps, state.cur)} · not a gate`,
            "ink"
          );
          return;
        }
        state.waiting = true;
        state.extra.lamps[state.cur]?.push([t, "park"]);
        chipTo(ctx, t, "amber");
        out.note(
          t,
          `waiting · ${type} · ${parkedCount(ctx, t)} parked`,
          "amber"
        );
      },
    },
    "hand off": {
      duration: 1.0,
      card: "required",
      tokens: TRANSITION_TOKENS,
      description:
        "the run leaves by an outgoing workflow transition's port (bundled transitions by the bundle port)",
      args: {
        to: {
          type: "string",
          description:
            "the transition's target; defaults to the first transition",
        },
      },
      compile(ctx) {
        const { t, out, state, args } = ctx;
        const L = state.extra.layout;
        const target = String(args.to ?? state.extra.transitions[0] ?? "");
        const j = outIndex(L, target);
        if (j < 0) {
          out.note(t, `no transition to ${target || "anywhere"}`, "red");
          return {};
        }
        const o = L.outs[j];
        state.extra.lamps[state.cur]?.push([t, "ok"]);
        state.extra.ports[j].push({ w: [t, t + 0.8], to: target });
        move(
          ctx,
          [
            [X(ctx, state.cur), L.ty],
            [L.turn, L.ty],
            [L.turn, o.y],
            [L.x1, o.y],
          ],
          t,
          0.75,
          t + 0.8
        );
        chipGone(ctx, t + 0.75);
        out.note(t, `handed off → ${target}`, "green");
        state.id = null;
        state.waiting = false;
        return { exit: o.port };
      },
    },
    finish: {
      duration: 0.8,
      card: "none",
      description:
        "the finish step completes: the run turns green and sinks into its lamp (task done)",
      compile(ctx) {
        const { t, out, state } = ctx;
        const L = state.extra.layout;
        state.extra.lamps[state.cur]?.push([t, "ok"]);
        state.extra.bursts.push([state.cur, t, "green"]);
        const x = X(ctx, state.cur);
        move(
          ctx,
          [
            [x, L.ty],
            [x, L.ty],
          ],
          t,
          0.05,
          t + 0.2,
          "green"
        );
        chipGone(ctx, t + 0.3);
        out.note(t, "finish · task done", "green");
        state.id = null;
        state.waiting = false;
      },
    },
    fail: {
      duration: 1.0,
      card: "none",
      description:
        "the working step fails: red rim and burst on its lamp, the card stays red under it and its chip stays red",
      args: {
        reason: {
          type: "string",
          description: "short reason tagged on the card (e.g. script error)",
        },
      },
      compile(ctx) {
        const { t, out, state, args } = ctx;
        const L = state.extra.layout;
        const i = state.cur;
        state.extra.lamps[i]?.push([t, "fail"]);
        state.extra.bursts.push([i, t, "red"]);
        chipTo(ctx, t, "red");
        const x = X(ctx, i);
        move(
          ctx,
          [
            [x, L.ty],
            [x, L.ty],
          ],
          t,
          0.05,
          HELD,
          "red",
          args.reason
            ? {
                tags: [
                  {
                    text: String(args.reason),
                    from: t + 0.05,
                    to: t + 1.0,
                    dy: -22,
                  },
                ],
              }
            : {}
        );
        out.note(
          t,
          `failed at step ${i + 1} · ${typeAt(ctx, i)} · reason saved`,
          "red"
        );
        state.waiting = false;
      },
    },
  },
};

/** The drawing's view of a compiled workflow station. */
export const workflowExtra = (state: WorkflowState): WorkflowExtra =>
  state.extra;
