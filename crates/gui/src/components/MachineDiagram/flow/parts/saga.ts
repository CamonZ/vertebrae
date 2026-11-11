/**
 * saga · steps forward, undoes backward (catalogue "saga"): three step
 * stations with lamps and a dashed undo lane. Frame 500×200, footprint L; the
 * start event enters W, the result leaves E, and a compensating card leaves
 * along the undo lane. Durations from the gallery "completes" story: a card
 * crosses to a station in 0.45–0.5 s and each step runs 0.45 s; the undo lane
 * is crossed in 0.4–0.7 s.
 */
import { card as makeCard } from "../../timeline";
import { HELD, type PartKindDef } from "../registry";
import { leg, sideGates } from "./common";

const Y = 165;
const UNDO = 255;
const XS = [170, 320, 470] as const;
const STEPS = ["reserve stock", "charge card", "ship"] as const;
const UNDOS = ["released · order cancelled", "refunded"] as const;

const ports = {
  in: {
    side: "W",
    x: 70,
    y: Y,
    direction: "in",
    tokens: ["event", "request"],
    description: "event (start)",
  },
  out: {
    side: "E",
    x: 570,
    y: Y,
    direction: "out",
    tokens: ["result"],
    description: "result",
  },
  undo: {
    side: "W",
    x: 70,
    y: UNDO,
    direction: "out",
    tokens: ["result", "control"],
    dashed: true,
    description: "undo lane",
  },
} as const satisfies PartKindDef["ports"];

interface SagaState {
  /** Steps completed. */
  at: number;
  /** The card running through the saga. */
  id: string | null;
  /** When a wait for the next step's reply began. */
  waitFrom: number | null;
}

const pos = (i: number) => (i < 0 ? 70 : XS[i]);

export const sagaPart: PartKindDef<Record<string, unknown>, SagaState> = {
  kind: "saga",
  job: "steps forward, undoes backward",
  family: "event sourcing",
  footprint: "L",
  bb: [70, 100, 500, 200],
  status: { x: 320, y: 332 },
  ports,
  gates: () => sideGates({ in: ports.in, out: ports.out }),
  init: () => ({ at: 0, id: null, waitFrom: null }),
  verbs: {
    stage: {
      duration: 1.2,
      card: "required",
      tokens: ["event", "request"],
      description:
        "run the next step: the card crosses to its station and the step succeeds; after the last step the result leaves",
      compile({ t, card, out, state }) {
        const i = state.at;
        if (i >= XS.length) {
          out.note(t, "saga complete", "green");
          return { duration: 0.4 };
        }
        if (state.id) out.end(state.id, t);
        state.id = card!.id;
        const ring = state.waitFrom ?? t + 0.55;
        state.waitFrom = null;
        const last = i === XS.length - 1;
        if (i === 0) out.note(t, "OrderPlaced", "ink");
        out.note(t + 0.55, STEPS[i], "dim");
        const legs = [
          leg(
            [
              [pos(i - 1), Y],
              [XS[i], Y],
            ],
            t,
            i === 0 ? 0.5 : 0.45
          ),
        ];
        if (last)
          legs.push(
            leg(
              [
                [XS[i], Y],
                [570, Y],
              ],
              Math.max(t + 1.1, ring + 0.55),
              0.5
            )
          );
        out.carry(legs, t, last ? Math.max(t + 1.1, ring + 0.55) + 0.7 : HELD, {
          role: card!.role,
          lean: legs.slice(1).map((l) => l[1]),
          tags: [[card!.label, t + 0.05, t + 0.4]],
        });
        state.at++;
        if (last) {
          out.note(Math.max(t + 1.1, ring + 0.55), "saga complete", "green");
          return { exit: "out", token: "result", role: "green", duration: 1.8 };
        }
        return { duration: 1.1 };
      },
    },
    wait: {
      duration: 1.6,
      card: "none",
      description: "a step has been asked and no reply has come yet",
      compile({ t, out, state }) {
        const i = Math.min(state.at, XS.length - 1);
        state.waitFrom = t;
        out.note(t, `${STEPS[i].split(" ")[0]} · waiting for reply`, "amber");
        return { duration: 1.6 };
      },
    },
    fail: {
      duration: 1.4,
      card: "none",
      description:
        "the step does not succeed (an error, or the deadline passes with no reply); the card stops at its station",
      compile({ t, out, state }) {
        const i = Math.min(state.at, XS.length - 1);
        const id = state.id;
        if (id) {
          out.end(id, t);
          out.card(
            makeCard(
              28,
              "red",
              [
                leg(
                  [
                    [pos(i - 1), Y],
                    [XS[i], Y],
                  ],
                  t,
                  0.45
                ),
              ],
              t,
              HELD,
              { id, col: [[t + 0.5, "red"]], lean: [t] }
            )
          );
        }
        out.note(
          t + 0.5,
          state.waitFrom !== null
            ? "no reply · deadline"
            : `${STEPS[i]} failed · undoing`,
          "red"
        );
        state.waitFrom = null;
        return { role: "red", duration: 1.2 };
      },
    },
    compensate: {
      duration: 3.2,
      card: "none",
      description:
        "undo the completed steps backward along the undo lane, releasing each lamp",
      compile({ t, out, state }) {
        const id = state.id;
        const done = state.at;
        if (!id || done === 0) {
          out.note(t, "nothing to undo", "dim");
          if (id) out.end(id, t);
          return { duration: 0.6 };
        }
        out.end(id, t);
        const legs = [
          leg(
            [
              [XS[done], Y],
              [XS[done], UNDO],
              [XS[done - 1], UNDO],
            ],
            t,
            0.7
          ),
        ];
        const tags: [string, number, number][] = [];
        let at = t + 0.75;
        for (let k = done - 1; k >= 0; k--) {
          out.note(at, UNDOS[Math.min(k, 1)], k === 0 ? "red" : "amber");
          tags.push([k === 0 ? "release" : "refund", at - 0.5, at - 0.1]);
          if (k > 0) {
            legs.push(
              leg(
                [
                  [XS[k], UNDO],
                  [XS[k - 1], UNDO],
                ],
                at + 0.35,
                0.45
              )
            );
            at += 0.95;
          }
        }
        legs.push(
          leg(
            [
              [XS[0], UNDO],
              [110, UNDO],
            ],
            at + 0.45,
            0.4
          )
        );
        out.card(
          makeCard(28, "ink", legs, t, at + 0.95, {
            id,
            col: [[t, "red"]],
            lean: legs.map((l) => l[1]),
            tags,
          })
        );
        state.at = 0;
        state.id = null;
        return { role: "red", duration: at + 1.0 - t };
      },
    },
  },
};
