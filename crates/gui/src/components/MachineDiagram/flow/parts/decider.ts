/**
 * decider · command + state → events (catalogue "decider"): the press with a
 * state line above the box. Frame 220×190, footprint M; commands enter W,
 * events leave E. Durations from the gallery "decides" story: the command
 * seats in 0.6 s, the press clamps 0.65 s later for 1.35 s, the events leave
 * in 0.6 s; a rejection bounces back in 0.75 s.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 210,
    y: Y,
    direction: "in",
    tokens: ["request", "control", "data"],
    description: "command",
  },
  out: {
    side: "E",
    x: 430,
    y: Y,
    direction: "out",
    tokens: ["event", "result"],
    description: "event(s)",
  },
} as const satisfies PartKindDef["ports"];

interface DeciderProps {
  /** The state line shown above the box. */
  state: string;
}

const tokens = ["request", "control", "data"] as const;

export const deciderPart: PartKindDef<DeciderProps, { decisions: number }> = {
  kind: "decider",
  job: "command + state → events",
  family: "event sourcing",
  footprint: "M",
  bb: [210, 105, 220, 190],
  status: { x: 320, y: 328 },
  props: { state: { type: "string", default: "balance 50" } },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ decisions: 0 }),
  verbs: {
    decide: {
      duration: 2.7,
      card: "required",
      tokens,
      description:
        "the command meets the state and produces events, or none when nothing changes",
      args: {
        events: { type: "integer", min: 0, default: 1 },
        state: {
          type: "string",
          description: "the state line after the decision",
        },
      },
      compile({ t, card, out, state, args }) {
        state.decisions++;
        const events = Number(args.events);
        out.note(t, `command · ${card!.label}`, "ink");
        out.note(t + 0.75, "deciding · · ·", "dim");
        if (events === 0) {
          out.carry(
            [
              leg(
                [
                  [210, Y],
                  [320, Y],
                ],
                t,
                0.45
              ),
            ],
            t,
            t + 2.05,
            { role: card!.role, col: [[t + 1.95, "green"]] }
          );
          out.note(t + 2.0, "0 events · already closed", "green");
          return { consumed: true, role: "green" };
        }
        out.carry(
          [
            leg(
              [
                [210, Y],
                [320, Y],
              ],
              t,
              0.45
            ),
            leg(
              [
                [320, Y],
                [430, Y],
              ],
              t + 2.05,
              0.5
            ),
          ],
          t,
          t + 2.6,
          {
            role: card!.role,
            lean: [t + 2.05],
            tags: [
              [`${events} event${events === 1 ? "" : "s"}`, t + 2.15, t + 2.55],
            ],
          }
        );
        out.note(t + 2.0, `${events} event${events === 1 ? "" : "s"}`, "green");
        return { exit: "out", token: "event", role: "green" };
      },
    },
    fail: {
      duration: 2.9,
      card: "required",
      tokens,
      description:
        "the command breaks an invariant: it bounces back and no events are produced",
      args: {
        reason: { type: "string", default: "invariant broken" },
      },
      compile({ t, card, out, args }) {
        out.note(t, `command · ${card!.label}`, "ink");
        out.note(t + 0.75, "deciding · · ·", "dim");
        out.carry(
          [
            leg(
              [
                [210, Y],
                [320, Y],
              ],
              t,
              0.45
            ),
            leg(
              [
                [320, Y],
                [210, Y],
              ],
              t + 2.05,
              0.75
            ),
          ],
          t,
          t + 2.9,
          {
            role: card!.role,
            col: [[t + 1.95, "red"]],
            lean: [t + 2.05],
            tags: [["rejected", t + 2.2, t + 2.75]],
          }
        );
        out.note(
          t + 2.0,
          `rejected · ${String(args.reason)} · no events`,
          "red"
        );
        return { role: "red", consumed: true };
      },
    },
  },
};
