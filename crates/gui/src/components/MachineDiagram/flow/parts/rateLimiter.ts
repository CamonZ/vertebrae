/**
 * rate limiter · spends tokens to pass (catalogue "rate limiter"): a token
 * bucket; a card passes by spending a token. Frame 220×170, footprint M;
 * in W, out E. Durations from the gallery "waits for a token" story: a card
 * crosses in 1.1 s, a waiting card holds at the gate until a refill.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: { side: "W", x: 210, y: Y, direction: "in", tokens: ["request"] },
  out: {
    side: "E",
    x: 430,
    y: Y,
    direction: "out",
    tokens: ["request"],
    description: "request (token spent)",
  },
} as const satisfies PartKindDef["ports"];

interface LimiterProps {
  /** Tokens in a full bucket (1..4). */
  tokens: number;
}

interface LimiterState {
  tokens: number;
  /** Slot spend and refill times for the drawing: slot i is spent at `spent[i]`. */
  spent: (number | null)[];
  refilled: (number | null)[];
}

const count = (s: LimiterState) => s.tokens;

export const rateLimiterPart: PartKindDef<LimiterProps, LimiterState> = {
  kind: "rate limiter",
  job: "spends tokens to pass",
  family: "messaging and flow control",
  footprint: "M",
  bb: [210, 115, 220, 170],
  status: { x: 320, y: 316 },
  props: { tokens: { type: "integer", min: 1, max: 4, default: 4 } },
  ports,
  gates: () => sideGates(ports),
  init: (p) => ({
    tokens: p.tokens,
    spent: [null, null, null, null],
    refilled: [null, null, null, null],
  }),
  verbs: {
    send: {
      duration: 1.1,
      card: "required",
      tokens: ["request"],
      description:
        "a card passes by spending a token; none left means it waits",
      compile({ t, card, out, state, part }) {
        if (count(state) <= 0) {
          out.carry(
            [
              leg(
                [
                  [210, Y],
                  [184, Y],
                ],
                t,
                0.5
              ),
            ],
            t,
            t + 0.55,
            { role: "amber", tags: [["waiting for a token", t + 0.1, t + 0.5]] }
          );
          out.note(t, "empty", "amber");
          return { consumed: true };
        }
        const slot = part.props.tokens - state.tokens;
        state.spent[slot] = t + 0.45;
        state.tokens--;
        out.carry(
          [
            leg(
              [
                [210, Y],
                [430, Y],
              ],
              t,
              0.8
            ),
          ],
          t,
          t + 0.85,
          { role: card!.role }
        );
        out.note(
          t + 0.45,
          state.tokens ? `${state.tokens} tokens` : "empty",
          state.tokens ? "ink" : "amber"
        );
        return { exit: "out", duration: 1.0 };
      },
    },
    wait: {
      duration: 1,
      card: "none",
      args: { seconds: { type: "number", min: 0, default: 1 } },
      compile({ t, out }) {
        out.note(t, "empty", "amber");
      },
    },
    refill: {
      duration: 0.6,
      card: "none",
      description: "the bucket gains a token",
      compile({ t, out, state, part }) {
        if (state.tokens < part.props.tokens) {
          const slot = part.props.tokens - state.tokens - 1;
          state.refilled[slot] = t;
          state.tokens++;
        }
        out.note(t, `refilled · ${state.tokens}`, "ink");
      },
    },
    fail: {
      duration: 0.8,
      card: "required",
      tokens: ["request"],
      description: "no token and no waiting: the card is rejected with a 429",
      compile({ t, card, out }) {
        out.carry(
          [
            leg(
              [
                [210, Y],
                [184, Y],
              ],
              t,
              0.5
            ),
            leg(
              [
                [184, Y],
                [24, Y],
              ],
              t + 0.6,
              0.6
            ),
          ],
          t,
          t + 1.25,
          {
            role: card!.role,
            col: [[t + 0.48, "red"]],
            lean: [t + 0.6],
            tags: [["429", t + 0.7, t + 1.2]],
          }
        );
        out.note(t + 0.6, "rejected · 429", "red");
        return { consumed: true, role: "red" as const };
      },
    },
  },
};
