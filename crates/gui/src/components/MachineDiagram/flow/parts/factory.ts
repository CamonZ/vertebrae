/**
 * factory · a whole factory as one station (catalogue v2.2 "factory"), the
 * workflow station one level up. Prop-driven: `workflows` (each workflow's
 * step count, in factory order, 1–20), `inbound` and `outbound` (the Atlas
 * factory routes) resolve the frame, the status anchor, the ports (W: one
 * per inbound factory `in1`…`in4`, or a single unlabelled `in`; E: one per
 * outbound factory `out1`…`out4`; port 4 bundles the rest past four) and one
 * stage per workflow mark. There are no finished or needs-attention exits:
 * finish and failure end at their workflow mark; only `hand off` leaves.
 *
 * Verbs follow the gallery timings: the task enters in 0.7 s and its first
 * workflow works, a step hops dock to dock on the thrown spring in 0.35 s, a
 * hand-off leaves in 0.75 s with its port lit for 0.8 s. The run's card,
 * chip and port helpers are the workflow station's. Everything keys on
 * positions and step counts, never on factory or workflow names.
 */
import type { StateRole } from "../../palette";
import type { FactoryExtra, FactoryMarkStep } from "../../parts/factory";
import {
  FACTORY_MAX_STEPS,
  FACTORY_MAX_WORKFLOWS,
  FACTORY_MIN_WORKFLOWS,
  factoryGates,
  factoryLayout,
  factoryOutIndex,
  inIndex,
  workflowWords,
  type FactoryLayout,
} from "../../parts/factorySpec";
import type { WorkflowPortLight } from "../../parts/workflow";
import type { WorkflowOut } from "../../parts/workflowSpec";
import {
  HELD,
  type PartKindDef,
  type PortDef,
  type VerbContext,
} from "../registry";
import { leg } from "./common";
import {
  TRANSITION_TOKENS,
  chipGone,
  chipTo,
  move,
  parkedCount,
  seedChips,
  type MutableChip,
  type StationRun,
} from "./workflow";

export interface FactoryProps {
  workflows: readonly number[];
  inbound: readonly string[];
  outbound: readonly string[];
  /** Other TaskRuns already parked at the station (amber chips). */
  parked: number;
  /** Other TaskRuns already active at the station (ink chips). */
  active: number;
}

interface Mutable {
  workflows: readonly number[];
  inbound: readonly string[];
  outbound: readonly string[];
  layout: FactoryLayout;
  marks: FactoryMarkStep[][];
  chips: MutableChip[];
  ins: WorkflowPortLight[][];
  outs: WorkflowPortLight[][];
  bursts: [number, number, StateRole][];
}

export interface FactoryState extends StationRun {
  /** Mechanism timelines the drawing reads (FactoryExtra). */
  extra: Mutable;
}

const strings = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
const propsOf = (props: Partial<FactoryProps>) => ({
  workflows: Array.isArray(props.workflows) ? props.workflows : [],
  inbound: strings(props.inbound),
  outbound: strings(props.outbound),
});
const layoutOf = (props: Partial<FactoryProps>) => {
  const p = propsOf(props);
  return factoryLayout(p.workflows, p.inbound, p.outbound);
};

const describePort = (o: WorkflowOut, dir: "from" | "to") =>
  o.bundle
    ? `tasks ${dir} ${o.targets.join(", ")}`
    : `tasks ${dir} ${o.targets[0]}`;

/** W: one in per inbound factory (or a lone entry); E: one out per outbound factory. */
export function factoryPorts(L: FactoryLayout): Record<string, PortDef> {
  return {
    ...Object.fromEntries(
      L.ins.map((o) => [
        o.port,
        {
          side: "W",
          x: L.x0,
          y: o.y,
          direction: "in",
          tokens: TRANSITION_TOKENS,
          description: o.targets.length
            ? describePort(o, "from")
            : "the task (factory entry)",
        } satisfies PortDef,
      ])
    ),
    ...Object.fromEntries(
      L.outs.map((o) => [
        o.port,
        {
          side: "E",
          x: L.x1,
          y: o.y,
          direction: "out",
          tokens: TRANSITION_TOKENS,
          description: describePort(o, "to"),
        } satisfies PortDef,
      ])
    ),
  };
}

/** The port a factory route uses: `in` for an inbound factory, `out` for an outbound one (bundle past the cap). */
export function factoryPortFor(
  props: Pick<FactoryProps, "workflows" | "inbound" | "outbound">,
  factory: string,
  side: "in" | "out" = "out"
): string | null {
  const L = factoryLayout(props.workflows, props.inbound, props.outbound);
  if (side === "out") {
    const j = factoryOutIndex(L, factory);
    return j < 0 ? null : L.outs[j].port;
  }
  return props.inbound.includes(factory)
    ? L.ins[inIndex(L, factory)].port
    : null;
}

const DEFAULT_WORKFLOWS = [3, 5];
const DEFAULT_LAYOUT = factoryLayout(DEFAULT_WORKFLOWS, [], []);

type Ctx = VerbContext<FactoryProps, FactoryState>;

const L_ = (ctx: Ctx) => ctx.state.extra.layout;
const dock = (ctx: Ctx, i: number) =>
  L_(ctx).marks[Math.max(0, Math.min(i, L_(ctx).marks.length - 1))].dock;
const count = (ctx: Ctx) => ctx.state.extra.workflows.length;
const words = (ctx: Ctx, i: number) => workflowWords(count(ctx), i);

export const factoryPart: PartKindDef<FactoryProps, FactoryState> = {
  kind: "factory",
  job: "a whole factory as one station",
  family: "vertebrae workflows",
  footprint: "M",
  bb: DEFAULT_LAYOUT.bb,
  status: DEFAULT_LAYOUT.status,
  props: {
    workflows: {
      type: "integer[]",
      min: 1,
      max: FACTORY_MAX_STEPS,
      default: DEFAULT_WORKFLOWS,
      description:
        "the step count of each workflow, in factory order, 1–20 workflows; one mark per workflow (one dot per step, up to 5); never workflow names",
    },
    inbound: {
      type: "string[]",
      default: [],
      description:
        "factories that hand work to this one (Atlas factory routes, labelled by factory); ports in1…in4, the fourth bundling the rest past four; none: one unlabelled `in`",
    },
    outbound: {
      type: "string[]",
      default: [],
      description:
        "factories this one hands work to (Atlas factory routes, labelled by factory); ports out1…out4, the fourth bundling the rest past four (factoryPortFor)",
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
  ports: factoryPorts(DEFAULT_LAYOUT),
  resolve: (props) => {
    const L = layoutOf(props);
    return {
      bb: L.bb,
      status: L.status,
      ports: factoryPorts(L),
      gates: () => factoryGates(L),
    };
  },
  checkProps: (props) => {
    const errors: { path: string; message: string }[] = [];
    const { workflows, inbound, outbound } = propsOf(props);
    if (
      workflows.length < FACTORY_MIN_WORKFLOWS ||
      workflows.length > FACTORY_MAX_WORKFLOWS
    )
      errors.push({
        path: "workflows",
        message: `a factory station draws ${FACTORY_MIN_WORKFLOWS}–${FACTORY_MAX_WORKFLOWS} workflows (got ${workflows.length})`,
      });
    for (const [path, list] of [
      ["inbound", inbound],
      ["outbound", outbound],
    ] as const)
      if (new Set(list).size !== list.length)
        errors.push({ path, message: "factory names must be unique" });
    if ((props.parked ?? 0) + (props.active ?? 0) > 8)
      errors.push({
        path: "parked",
        message: "at most 8 other TaskRuns fit the chip tray",
      });
    return errors;
  },
  gates: () => factoryGates(DEFAULT_LAYOUT),
  stages: (props) => layoutOf(props).stages,
  init: (props) => {
    const { workflows, inbound, outbound } = propsOf(props);
    const layout = factoryLayout(workflows, inbound, outbound);
    return {
      extra: {
        workflows,
        inbound,
        outbound,
        layout,
        marks: layout.marks.map((): FactoryMarkStep[] => [[0, "off"]]),
        chips: seedChips(Number(props.parked ?? 0), Number(props.active ?? 0)),
        ins: layout.ins.map(() => []),
        outs: layout.outs.map(() => []),
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
        "a task enters from an inbound factory (its port lights) or by the lone entry, and the first workflow works",
      args: {
        from: {
          type: "string",
          description:
            "the inbound factory it comes from; defaults to the port it arrived on, else the first",
        },
      },
      compile(ctx) {
        const { t, card, out, state, args, entry } = ctx;
        const L = state.extra.layout;
        const from = args.from !== undefined ? String(args.from) : null;
        const byEntry = L.ins.findIndex((o) => o.port === entry);
        const j = from ? inIndex(L, from) : Math.max(0, byEntry);
        const o = L.ins[j];
        const name = from ?? o.targets[0] ?? null;
        if (name && o.label)
          state.extra.ins[j].push({ w: [t, t + 0.7], to: name });
        const [dx, dy] = dock(ctx, 0);
        out.carry(
          [
            leg(
              [
                [L.x0, o.y],
                [L.inTurn, o.y],
                [L.inTurn, dy],
                [dx, dy],
              ],
              t,
              0.7
            ),
          ],
          t,
          HELD,
          { role: "ink", tags: [["task", t + 0.05, t + 0.45]] }
        );
        state.card = card!;
        state.id = card!.id;
        state.role = "ink";
        state.cur = 0;
        state.waiting = false;
        state.chip = state.extra.chips.length;
        state.extra.chips.push({ born: t + 0.1, col: [[-1e9, "ink"]] });
        state.extra.marks[0]?.push([t + 0.7, "run"]);
        out.note(
          t,
          name && o.label ? `task enters from ${name}` : "task enters",
          "ink"
        );
        out.note(t + 0.7, words(ctx, 0), "ink");
      },
    },
    step: {
      duration: 0.6,
      card: "none",
      description:
        "the working workflow completes and the task hops to the next workflow mark (or to workflow `to`); after a wait it resumes first",
      args: {
        to: {
          type: "integer",
          min: 1,
          max: FACTORY_MAX_WORKFLOWS,
          description: "1-based workflow the task moves to (default: the next)",
        },
      },
      compile(ctx) {
        const { out, state, args } = ctx;
        const n = count(ctx);
        const from = state.cur;
        const to = Math.min(
          n - 1,
          args.to !== undefined ? Number(args.to) - 1 : from + 1
        );
        let t = ctx.t;
        const resumed = state.waiting;
        state.waiting = false;
        if (resumed) {
          // The answer arrives: the parked workflow works again, then completes.
          state.extra.marks[from]?.push([t, "run"]);
          chipTo(ctx, t, "ink");
          out.note(t, `answered · ${words(ctx, from)}`, "ink");
          t += 0.5;
        }
        state.extra.marks[from]?.push([t, "ok"]);
        if (to !== from) {
          move(ctx, [dock(ctx, from), dock(ctx, to)], t, 0.35, HELD);
          state.extra.marks[to]?.push([t + 0.35, "run"]);
          out.note(t + 0.35, words(ctx, to), "ink");
        }
        state.cur = to;
        return resumed ? { duration: 1.1 } : {};
      },
    },
    wait: {
      duration: 0.8,
      card: "none",
      description:
        "the working workflow parks (a gate or child tasks inside it): amber outline and ring, amber chip, until a step answers it",
      compile(ctx) {
        const { t, out, state } = ctx;
        state.waiting = true;
        state.extra.marks[state.cur]?.push([t, "park"]);
        chipTo(ctx, t, "amber");
        out.note(
          t,
          `${words(ctx, state.cur)} waiting · gate · ${parkedCount(ctx, t)} parked`,
          "amber"
        );
      },
    },
    "hand off": {
      duration: 1.0,
      card: "required",
      tokens: TRANSITION_TOKENS,
      description:
        "the task leaves for another factory by that factory's out port (bundled factories by the bundle port)",
      args: {
        to: {
          type: "string",
          description: "the outbound factory; defaults to the first",
        },
      },
      compile(ctx) {
        const { t, out, state, args } = ctx;
        const L = state.extra.layout;
        const target = String(args.to ?? state.extra.outbound[0] ?? "");
        const j = factoryOutIndex(L, target);
        if (j < 0) {
          out.note(t, `no route to ${target || "another factory"}`, "red");
          return {};
        }
        const o = L.outs[j];
        const [dx, dy] = dock(ctx, state.cur);
        state.extra.marks[state.cur]?.push([t, "ok"]);
        state.extra.outs[j].push({ w: [t, t + 0.8], to: target });
        move(
          ctx,
          [
            [dx, dy],
            [L.turn, dy],
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
        "the working workflow completes the task: it turns green and sinks into the mark (task done)",
      compile(ctx) {
        const { t, out, state } = ctx;
        state.extra.marks[state.cur]?.push([t, "ok"]);
        state.extra.bursts.push([state.cur, t, "green"]);
        const d = dock(ctx, state.cur);
        move(ctx, [d, d], t, 0.05, t + 0.2, "green");
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
        "the working workflow fails: red mark and burst, the card stays red at its mark, its chip stays red, and the task needs attention",
      args: {
        reason: {
          type: "string",
          description: "short reason tagged under the card (e.g. step failed)",
        },
      },
      compile(ctx) {
        const { t, out, state, args } = ctx;
        const i = state.cur;
        state.extra.marks[i]?.push([t, "fail"]);
        state.extra.bursts.push([i, t, "red"]);
        chipTo(ctx, t, "red");
        const d = dock(ctx, i);
        move(
          ctx,
          [d, d],
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
                    dy: 28,
                  },
                ],
              }
            : {}
        );
        out.note(t, `failed in ${words(ctx, i)} · needs attention`, "red");
        state.waiting = false;
      },
    },
  },
};

/** The drawing's view of a compiled factory station. */
export const factoryExtra = (state: FactoryState): FactoryExtra => state.extra;
