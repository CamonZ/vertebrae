/**
 * state machine · one state at a time (catalogue "state machine"): state
 * nodes with a cursor that moves along legal edges. Frame 420×190,
 * footprint L; an event enters W. Legal edges: queued → running, running →
 * done, running → failed. An event with no edge from the current state is
 * rejected at the frame and the cursor stays. Durations from the gallery
 * "done" story: the event seats in 0.4 s and the cursor moves 0.4 s later.
 */
import { card as makeCard, stay } from "../../timeline";
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 110,
    y: 150,
    direction: "in",
    tokens: ["control", "request", "event"],
    description: "an event (start, finish, error, cancel)",
  },
} as const satisfies PartKindDef["ports"];

type StateName = "queued" | "running" | "done" | "failed";
const NODE = {
  queued: [190, 150],
  running: [330, 150],
  done: [470, 150],
  failed: [330, 240],
} as const satisfies Record<StateName, readonly [number, number]>;
const EDGES: Readonly<Record<StateName, readonly StateName[]>> = {
  queued: ["running"],
  running: ["done", "failed"],
  done: [],
  failed: [],
};
const ROLE = {
  queued: "dim",
  running: "amber",
  done: "green",
  failed: "red",
} as const;

interface MachineState {
  at: StateName;
  /** The cursor card exists once the first event has been handled. */
  started: boolean;
}

type Ctx = VerbContext<Record<string, unknown>, MachineState>;

const cursorId = (ctx: Ctx) => `${ctx.part.id}.cursor`;

function showCursor(ctx: Ctx, at: number, from: StateName, to: StateName) {
  const { out, state } = ctx;
  const id = cursorId(ctx);
  const [fx, fy] = NODE[from];
  if (state.started) out.end(id, at);
  state.started = true;
  out.card(
    makeCard(
      18,
      ROLE[from],
      [
        stay(fx, fy, at),
        ...(from === to ? [] : [leg([NODE[from], NODE[to]], at + 0.4, 0.4)]),
      ],
      at,
      HELD,
      {
        id,
        dot: true,
        col: from === to ? [] : [[at + 0.4, ROLE[to]]],
      }
    )
  );
}

/** Take the edge to `to` when it is legal; otherwise reject the event at the frame. */
function step(
  ctx: Ctx,
  event: string,
  to: StateName,
  failed = false
): { duration: number } {
  const { t, card, out, state } = ctx;
  const from = state.at;
  const legal = EDGES[from].includes(to);
  if (!state.started) showCursor(ctx, t - 0.1, from, from);
  const role = card?.role ?? "ink";
  if (card)
    out.carry(
      [
        leg(
          [
            [110, 150],
            [150, 150],
          ],
          t,
          0.4
        ),
        ...(legal
          ? []
          : [
              leg(
                [
                  [150, 150],
                  [110, 150],
                ],
                t + 0.55,
                0.5
              ),
            ]),
      ],
      t,
      legal ? t + 0.45 : t + 1.15,
      {
        role,
        col: legal ? [] : [[t + 0.43, "red"]],
        lean: legal ? [] : [t + 0.55],
        tags: [
          [event, t + 0.05, t + 0.35],
          ...(legal ? [] : [["invalid", t + 0.6, t + 1.1, 32] as const]),
        ],
      }
    );
  if (!legal) {
    out.note(t + 0.5, `${from} → ${to} · rejected`, "red");
    return { duration: 1.2 };
  }
  showCursor(ctx, t + 0.4 - 0.05, from, to);
  state.at = to;
  out.note(t + 0.45, to, failed ? "red" : ROLE[to]);
  return { duration: 0.9 };
}

export const stateMachinePart: PartKindDef<
  Record<string, unknown>,
  MachineState
> = {
  kind: "state machine",
  job: "one state at a time",
  family: "data and state",
  footprint: "L",
  bb: [110, 100, 420, 190],
  status: { x: 320, y: 322 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ at: "queued", started: false }),
  verbs: {
    stage: {
      duration: 0.9,
      card: "optional",
      description: "the start event: queued → running",
      compile(ctx) {
        return step(ctx, "start", "running");
      },
    },
    decide: {
      duration: 0.9,
      card: "optional",
      description:
        "an event picks one of the legal edges out of the current state",
      args: {
        to: {
          type: "string",
          enum: ["running", "done", "failed"],
          default: "done",
        },
      },
      compile(ctx) {
        const to = ctx.args.to as StateName;
        return step(ctx, "decide", to, to === "failed");
      },
    },
    finish: {
      duration: 0.9,
      card: "optional",
      description: "the finish event: running → done",
      compile(ctx) {
        return step(ctx, "finish", "done");
      },
    },
    fail: {
      duration: 0.9,
      card: "optional",
      description: "the error event: running → failed",
      compile(ctx) {
        return step(ctx, "error", "failed", true);
      },
    },
    cancel: {
      duration: 0.9,
      card: "optional",
      tokens: ["control", "request", "event"],
      description:
        "the cancel event: a running machine ends as failed; a finished one rejects it",
      compile(ctx) {
        return step(ctx, "cancel", "failed", true);
      },
    },
  },
};
