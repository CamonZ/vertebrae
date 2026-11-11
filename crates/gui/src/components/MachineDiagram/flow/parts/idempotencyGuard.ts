/**
 * idempotency guard · applies each key once (catalogue "idempotency guard"): a
 * check hole, a row of seen keys and the effect. Frame 240×160, footprint M;
 * requests enter W, a request with a new key leaves E to the effect. Durations
 * from the gallery "first then duplicate" story: the request reaches the check
 * in 0.55 s and the check takes 0.3 s; a duplicate returns the stored result
 * in 0.65 s.
 */
import { card as makeCard, type LegInput } from "../../timeline";
import { HELD, type PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const HO = [270, Y] as const;

const ports = {
  in: {
    side: "W",
    x: 200,
    y: Y,
    direction: "in",
    tokens: ["request"],
    description: "request (key)",
  },
  out: {
    side: "E",
    x: 440,
    y: Y,
    direction: "out",
    tokens: ["request"],
    description: "request (to the effect)",
  },
} as const satisfies PartKindDef["ports"];

interface IdempotencyProps {
  /** Keys already seen. */
  seen: readonly string[];
}

interface IdempotencyState {
  seen: string[];
  inflight: string[];
  /** Requests waiting for an in-flight key: card id and key. */
  waiting: { id: string; key: string }[];
}

/** A returning result card for a request that waited (same id as the request). */
function card(l: LegInput, id: string, at: number) {
  return makeCard(28, "green", [l], at, at + 0.7, {
    id,
    lean: [at],
    tags: [["result", at + 0.1, at + 0.6]],
  });
}

const keyOf = (args: Readonly<Record<string, unknown>>, label: string) =>
  String(args.key ?? label);

export const idempotencyGuardPart: PartKindDef<
  IdempotencyProps,
  IdempotencyState
> = {
  kind: "idempotency guard",
  job: "applies each key once",
  family: "event sourcing",
  footprint: "M",
  bb: [200, 120, 240, 160],
  status: { x: 320, y: 320 },
  props: { seen: { type: "string[]", default: ["k3", "k5"] } },
  ports,
  gates: () => sideGates(ports),
  init: (p) => ({ seen: [...p.seen], inflight: [], waiting: [] }),
  verbs: {
    dedupe: {
      duration: 1.8,
      card: "required",
      tokens: ["request"],
      description:
        "check the key: a new one goes on to the effect, one already seen gets the stored result back",
      args: { key: { type: "string", description: "default: the card label" } },
      compile({ t, card, out, state, args }) {
        const key = keyOf(args, card!.label);
        const to = [
          leg(
            [
              [200, Y],
              [HO[0], HO[1]],
            ],
            t,
            0.55
          ),
        ];
        if (state.seen.includes(key)) {
          out.note(t, `${key} again`, "ink");
          out.carry(
            [
              ...to,
              leg(
                [
                  [HO[0], HO[1]],
                  [200, Y],
                ],
                t + 0.9,
                0.65
              ),
            ],
            t,
            t + 1.7,
            {
              role: card!.role,
              col: [[t + 0.8, "green"]],
              lean: [t + 0.9],
              tags: [
                [key, t + 0.05, t + 0.4],
                ["stored result", t + 1.0, t + 1.6],
              ],
            }
          );
          out.note(t + 0.8, "duplicate · no second effect", "green");
          return { consumed: true, role: "green" };
        }
        state.inflight.push(key);
        out.note(t, `${key} · first`, "ink");
        out.note(t + 0.6, "new key · applying", "amber");
        out.carry(
          [
            ...to,
            leg(
              [
                [HO[0], HO[1]],
                [440, Y],
              ],
              t + 0.85,
              0.55
            ),
          ],
          t,
          t + 1.5,
          {
            role: card!.role,
            lean: [t + 0.85],
            tags: [[key, t + 0.05, t + 0.4]],
          }
        );
        return { exit: "out", role: "ink" };
      },
    },
    wait: {
      duration: 1.2,
      card: "required",
      tokens: ["request"],
      description:
        "the same key arrives while the first request is still being applied: it waits at the check",
      args: { key: { type: "string", description: "default: the card label" } },
      compile({ t, card, out, state, args }) {
        const key = keyOf(args, card!.label);
        state.waiting.push({ id: card!.id, key });
        out.carry(
          [
            leg(
              [
                [200, Y],
                [HO[0], HO[1]],
              ],
              t,
              0.55
            ),
          ],
          t,
          HELD,
          {
            role: "amber",
            tags: [
              [key, t + 0.05, t + 0.4],
              ["waiting", t + 0.6, t + 1.6],
            ],
          }
        );
        out.note(t + 0.5, `${key} again · waits`, "amber");
        return { consumed: true };
      },
    },
    record: {
      duration: 1.2,
      card: "none",
      description:
        "the effect finished: the key is stored as seen with its result, and any waiting request gets that result",
      args: {
        key: { type: "string", description: "default: the key in flight" },
      },
      compile({ t, out, state, args }) {
        const key = String(args.key ?? state.inflight[0] ?? "");
        if (!key) {
          out.note(t, "nothing in flight", "dim");
          return { duration: 0.4 };
        }
        state.inflight = state.inflight.filter((k) => k !== key);
        state.seen.push(key);
        const waiting = state.waiting.filter((w) => w.key === key);
        state.waiting = state.waiting.filter((w) => w.key !== key);
        if (waiting.length === 0) {
          out.note(t, "applied · result stored", "green");
          return;
        }
        out.note(t, "applied once", "green");
        waiting.forEach((w, i) => {
          out.end(w.id, t + 0.1);
          out.card(
            card(
              leg(
                [
                  [HO[0], HO[1]],
                  [200, Y],
                ],
                t + 0.1 + 0.1 * i,
                0.65
              ),
              w.id,
              t + 0.1 + 0.1 * i
            )
          );
        });
        out.note(t + 0.2, "second gets the result", "green");
        return { duration: 1.4 };
      },
    },
    expire: {
      duration: 0.9,
      card: "none",
      description:
        "a seen key ages out: the same key looks new the next time it arrives",
      args: {
        key: { type: "string", description: "default: the first seen key" },
      },
      compile({ t, out, state, args }) {
        const key = String(args.key ?? state.seen.at(-1) ?? "");
        if (!state.seen.includes(key)) {
          out.note(t, "nothing to expire", "dim");
          return { duration: 0.4 };
        }
        state.seen = state.seen.filter((k) => k !== key);
        out.note(t, `${key} key expired`, "dim");
      },
    },
  },
};
