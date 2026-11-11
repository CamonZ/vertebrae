/**
 * lock · one holder at a time (catalogue "lock"): a latch that drops for one
 * holder. Frame 160×140, footprint S; acquire requests in W, the holder
 * leaves E. A second requester waits outside the frame. Durations from the
 * gallery "handoff" story: the holder seats in 0.6 s and leaves 0.6 s after
 * release; a waiter takes over 0.5 s after the latch lifts.
 */
import { card as makeCard, stay } from "../../timeline";
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { leg, sideGates, Y } from "./common";

const ports = {
  in: {
    side: "W",
    x: 240,
    y: Y,
    direction: "in",
    tokens: ["request"],
    description: "acquire",
  },
  out: {
    side: "E",
    x: 400,
    y: Y,
    direction: "out",
    tokens: ["request", "result"],
    description: "the holder, once it releases",
  },
} as const satisfies PartKindDef["ports"];

const SLOT = [320, Y] as const;
const WAIT = [170, Y] as const;

interface LockState {
  holder: string | null;
  waiting: string[];
}

type Ctx = VerbContext<Record<string, unknown>, LockState>;

const free = (ctx: Ctx, t: number) => ctx.out.note(t, "free", "dim");

/** The first waiter walks in from outside the frame and takes the latch. */
function handOver(ctx: Ctx, t: number) {
  const { out, state } = ctx;
  const next = state.waiting.shift();
  state.holder = next ?? null;
  if (!next) return free(ctx, t + 0.4);
  out.end(next, t);
  out.card(
    makeCard(28, "ink", [leg([WAIT, SLOT], t, 0.5)], t, HELD, { id: next })
  );
  out.note(t + 0.5, `held by ${next}`, "amber");
}

export const lockPart: PartKindDef<Record<string, unknown>, LockState> = {
  kind: "lock",
  job: "one holder at a time",
  family: "data and state",
  footprint: "S",
  bb: [240, 130, 160, 140],
  status: { x: 320, y: 304 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ holder: null, waiting: [] }),
  verbs: {
    acquire: {
      duration: 0.7,
      card: "required",
      tokens: ["request"],
      description: "take the lock, or wait outside for the holder to let go",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const id = card!.id;
        if (state.holder === null) {
          state.holder = id;
          out.carry([leg([[240, Y], SLOT], t, 0.6)], t, HELD, {
            role: card!.role,
            tags: [[card!.label, t + 0.05, t + 0.45]],
          });
          out.note(t + 0.6, `held by ${card!.label}`, "amber");
          return;
        }
        out.carry(
          [leg([[240, Y], WAIT], t, 0.35), stay(WAIT[0], WAIT[1], t + 0.4)],
          t,
          HELD,
          {
            role: "amber",
            tags: [[`${card!.label} · waiting for lock`, t + 0.4, t + 1.4]],
          }
        );
        state.waiting.push(id);
        out.note(t + 0.4, `${card!.label} waiting`, "amber");
      },
    },
    wait: {
      duration: 1,
      card: "none",
      args: { seconds: { type: "number", min: 0, default: 1 } },
      description: "time passes with the lock held",
      compile({ t, out, state, args }) {
        out.note(
          t,
          state.holder === null
            ? "free"
            : state.waiting.length
              ? `${state.waiting.length} waiting`
              : "held",
          state.holder === null ? "dim" : "amber"
        );
        return { duration: Number(args.seconds) };
      },
    },
    release: {
      duration: 0.8,
      card: "required",
      description:
        "the holder lets go and leaves; the first waiter takes the latch",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        if (state.holder !== card!.id) {
          out.note(t, `${card!.label} does not hold the lock`, "dim");
          return { duration: 0.4 };
        }
        out.end(card!.id, t);
        out.carry([leg([SLOT, [400, Y]], t + 0.1, 0.6)], t, t + 0.8, {
          role: "green",
          lean: [t + 0.1],
          tags: [],
        });
        out.note(t, "released", "green");
        handOver(ctx, t + 0.5);
        return { exit: "out", role: "green" as const };
      },
    },
    expire: {
      duration: 1.2,
      card: "none",
      description:
        "the holder crashed and its lease runs out: the lock frees itself and the first waiter takes it",
      compile(ctx) {
        const { t, out, state } = ctx;
        if (state.holder === null) {
          out.note(t, "nothing to expire", "dim");
          return { duration: 0.4 };
        }
        out.end(state.holder, t + 0.1);
        out.note(t, "holder crashed · lease running", "red");
        out.note(t + 0.7, "lease expired · freed", "amber");
        handOver(ctx, t + 0.9);
        return { duration: 1.4 };
      },
    },
  },
};
