/**
 * joiner · waits for all, then goes (catalogue "joiner"): one wait ring per
 * declared branch (a, b); releases one card when both have arrived. Frame
 * 220×190, footprint M; in W a (upper) and b (lower), out E. Durations from
 * the gallery "joined" story: a card seats in 0.6 s; the release slides
 * both to the merge point in 0.3 s and the joined card leaves.
 */
import type { PartKindDef, VerbContext } from "../registry";
import { HELD } from "../registry";
import { Y, leg, sideGates } from "./common";

const SLOT = { a: 150, b: 250 } as const;
type Branch = keyof typeof SLOT;

const ports = {
  a: {
    side: "W",
    x: 200,
    y: 150,
    direction: "in",
    tokens: ["result", "data", "copy"],
  },
  b: {
    side: "W",
    x: 200,
    y: 250,
    direction: "in",
    tokens: ["result", "data", "copy"],
  },
  out: {
    side: "E",
    x: 420,
    y: Y,
    direction: "out",
    tokens: ["result", "data"],
  },
} as const satisfies PartKindDef["ports"];

interface JoinerState {
  /** Card id seated in each branch slot. */
  seated: Partial<Record<Branch, string>>;
}

type Ctx = VerbContext<Record<string, unknown>, JoinerState>;

const count = (s: JoinerState) => Object.keys(s.seated).length;

function seat(ctx: Ctx) {
  const { t, card, out, state, entry, args } = ctx;
  const b = (entry ?? args.branch ?? "a") as Branch;
  out.carry(
    [
      leg(
        [
          [200, SLOT[b]],
          [260, SLOT[b]],
        ],
        t,
        0.4
      ),
    ],
    t,
    HELD,
    { role: card!.role }
  );
  state.seated[b] = card!.id;
  const n = count(state);
  out.note(
    t + 0.4,
    n >= 2 ? "2 of 2" : `${n} of 2 · waiting`,
    n >= 2 ? "ink" : "amber"
  );
  return { consumed: true };
}

function clear(ctx: Ctx, at: number) {
  for (const id of Object.values(ctx.state.seated)) if (id) ctx.out.end(id, at);
  ctx.state.seated = {};
}

const branchArg = {
  branch: {
    type: "string",
    enum: ["a", "b"],
    description: "slot when the card did not arrive on a rail",
  },
} as const;

export const joinerPart: PartKindDef<Record<string, unknown>, JoinerState> = {
  kind: "joiner",
  job: "waits for all, then goes",
  family: "compute",
  footprint: "M",
  bb: [200, 105, 220, 190],
  status: { x: 310, y: 328 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ seated: {} }),
  verbs: {
    wait: {
      duration: 0.6,
      card: "required",
      description: "a branch result seats in its ring",
      args: branchArg,
      compile: seat,
    },
    join: {
      duration: 0.6,
      card: "required",
      description: "same as wait; reads as the arrival that completes the join",
      args: branchArg,
      compile: seat,
    },
    release: {
      duration: 0.9,
      card: "optional",
      description: "all slots full: one joined card leaves",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        if (count(state) < 2) {
          out.note(t, `timed out · ${count(state)} of 2`, "red");
          clear(ctx, t + 0.3);
          return {};
        }
        clear(ctx, t + 0.3);
        if (card)
          out.carry(
            [
              leg(
                [
                  [330, Y],
                  [420, Y],
                ],
                t + 0.3,
                0.4
              ),
            ],
            t + 0.28,
            t + 0.8,
            { role: card.role }
          );
        out.note(t + 0.3, "joined", "green");
        return card ? { exit: "out" } : {};
      },
    },
    fail: {
      duration: 0.8,
      card: "none",
      args: {
        reason: { type: "string", description: "e.g. b failed → fail fast" },
      },
      compile(ctx) {
        const { t, out, state, args } = ctx;
        out.note(
          t,
          String(args.reason ?? `timed out · ${count(state)} of 2`),
          "red"
        );
        clear(ctx, t + 0.3);
      },
    },
    cancel: {
      duration: 0.6,
      card: "none",
      description: "discard the cards still waiting",
      compile(ctx) {
        const seated = Object.keys(ctx.state.seated);
        ctx.out.note(
          ctx.t,
          seated.length ? `${seated.join(" + ")} discarded` : "nothing waiting",
          "dim"
        );
        clear(ctx, ctx.t + 0.2);
      },
    },
  },
};
