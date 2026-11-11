/**
 * pool · a fixed number of seats (catalogue "pool"): seat rings, one per
 * occupancy slot. Frame 340×160, footprint L; in W (upper), out E (lower).
 * A card that finds every seat taken waits outside the pool for one.
 * Durations from the gallery "seat freed" story: a job seats in 0.7 s and
 * leaves in 0.7 s.
 */
import { card as makeCard, stay } from "../../timeline";
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { leg, sideGates } from "./common";

const SEATS = [230, 320, 410] as const;
const SEAT_Y = 190;
const enter = (x: number) =>
  [
    [150, 140],
    [x - 30, 140],
    [x, SEAT_Y],
  ] as const;
const leave = (x: number) =>
  [
    [x, SEAT_Y],
    [x, 245],
    [490, 245],
  ] as const;

const ports = {
  in: {
    side: "W",
    x: 150,
    y: 140,
    direction: "in",
    tokens: ["request", "data", "payload"],
  },
  out: {
    side: "E",
    x: 490,
    y: 245,
    direction: "out",
    tokens: ["result", "request"],
  },
} as const satisfies PartKindDef["ports"];

interface PoolProps {
  /** Seats drawn and used (1..3). */
  seats: number;
}

interface PoolState {
  /** Card id per seat, null when free. */
  seats: (string | null)[];
  waiting: string[];
}

type Ctx = VerbContext<PoolProps, PoolState>;

const busy = (s: PoolState) => s.seats.filter(Boolean).length;

function occupancy(ctx: Ctx, t: number) {
  const n = busy(ctx.state);
  const all = ctx.state.seats.length;
  ctx.out.note(
    t,
    `${n} of ${all} busy`,
    n === all ? "amber" : n ? "ink" : "dim"
  );
}

export const poolPart: PartKindDef<PoolProps, PoolState> = {
  kind: "pool",
  job: "a fixed number of seats",
  family: "compute",
  footprint: "L",
  bb: [150, 112, 340, 160],
  status: { x: 320, y: 304 },
  props: { seats: { type: "integer", min: 1, max: 3, default: 3 } },
  ports,
  gates: () => sideGates(ports),
  init: (p) => ({
    seats: Array.from({ length: p.seats }, () => null),
    waiting: [],
  }),
  verbs: {
    spawn: {
      duration: 0.7,
      card: "required",
      description: "a job takes a free seat, or waits outside for one",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const i = state.seats.indexOf(null);
        if (i < 0) {
          out.carry(
            [
              leg(
                [
                  [150, 140],
                  [118, 140],
                ],
                t,
                0.35
              ),
              stay(118, 140, t + 0.4),
            ],
            t,
            HELD,
            { role: "amber" }
          );
          state.waiting.push(card!.id);
          out.note(
            t + 0.35,
            `queue · ${state.waiting.length} waiting`,
            "amber"
          );
          return {};
        }
        out.carry([leg(enter(SEATS[i]), t, 0.7)], t, HELD, {
          role: card!.role,
        });
        state.seats[i] = card!.id;
        occupancy(ctx, t);
        return {};
      },
    },
    wait: {
      duration: 1,
      card: "none",
      args: { seconds: { type: "number", min: 0, default: 1 } },
      compile({ t, out, state, args }) {
        out.note(
          t,
          state.waiting.length
            ? `queue · ${state.waiting.length} waiting`
            : `${busy(state)} of ${state.seats.length} busy`,
          "amber"
        );
        return { duration: Number(args.seconds) };
      },
    },
    release: {
      duration: 0.8,
      card: "required",
      description:
        "a seated job leaves as its result; the first waiter takes the seat",
      args: {
        outcome: { type: "string", enum: ["ok", "error"], default: "ok" },
      },
      compile(ctx) {
        const { t, card, out, state, args } = ctx;
        const ok = args.outcome !== "error";
        const i = state.seats.indexOf(card!.id);
        if (i < 0) {
          out.note(t, `${card!.label} has no seat`, "dim");
          return { duration: 0.4 };
        }
        out.end(card!.id, t);
        out.carry([leg(leave(SEATS[i]), t, 0.7)], t, t + 0.75, {
          role: ok ? "green" : "red",
          lean: [t],
          tags: [],
        });
        state.seats[i] = null;
        out.note(
          t,
          ok ? "seat freed" : `${card!.label} failed`,
          ok ? "ink" : "red"
        );
        const next = state.waiting.shift();
        if (next) {
          // The first waiter moves from the queue spot into the freed seat, keeping its id.
          out.end(next, t + 0.1);
          out.card(
            makeCard(
              28,
              "ink",
              [leg([[118, 140], ...enter(SEATS[i])], t + 0.1, 0.7)],
              t + 0.1,
              HELD,
              {
                id: next,
              }
            )
          );
          state.seats[i] = next;
          out.note(
            t + 0.8,
            `${busy(state)} of ${state.seats.length} busy`,
            "ink"
          );
        }
        return {
          exit: "out",
          role: ok ? ("green" as const) : ("red" as const),
          token: "result" as const,
        };
      },
    },
    drain: {
      duration: 0.6,
      card: "none",
      description: "stop taking jobs; report occupancy",
      compile(ctx) {
        occupancy(ctx, ctx.t);
      },
    },
    close: {
      duration: 0.8,
      card: "none",
      description: "the pool closes: waiters give up",
      compile(ctx) {
        const { t, out, state } = ctx;
        for (const id of state.waiting) out.end(id, t + 0.3);
        out.note(
          t,
          state.waiting.length ? "waiter gave up" : "closed",
          state.waiting.length ? "red" : "dim"
        );
        state.waiting = [];
      },
    },
  },
};
