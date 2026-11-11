/**
 * source · emits work (catalogue "source"). Frame 80×64, footprint S; out E.
 * Durations from the gallery "sends" story: the card leaves the caret at
 * 0.6 s and crosses the out port 0.25 s later.
 */
import type { PartKindDef } from "../registry";
import { Y, sideGates } from "./common";

const ports = {
  out: {
    side: "E",
    x: 190,
    y: Y,
    direction: "out",
    tokens: ["request", "event", "data", "payload"],
  },
} as const satisfies PartKindDef["ports"];

export const sourcePart: PartKindDef = {
  kind: "source",
  job: "emits work",
  family: "actors",
  footprint: "S",
  bb: [110, 168, 80, 64],
  status: { x: 150, y: 262 },
  ports,
  gates: () => sideGates(ports),
  verbs: {
    send: {
      duration: 0.3,
      card: "required",
      description: "eject a card onto the out rail",
      compile({ t, card, out }) {
        out.carry(
          [
            [
              [
                [150, Y],
                [190, Y],
              ],
              t,
              0.25,
            ],
          ],
          t,
          t + 0.3,
          {
            role: card!.role,
          }
        );
        out.note(t, "send", "ink");
        return { exit: "out" };
      },
    },
    spawn: {
      duration: 0.4,
      card: "none",
      compile({ t, out }) {
        out.note(t, "spawn", "ink");
      },
    },
    tick: {
      duration: 0.4,
      card: "none",
      compile({ t, out }) {
        out.note(t, "tick", "dim");
      },
    },
    observe: {
      duration: 0.4,
      card: "none",
      args: { text: { type: "string", default: "ready" } },
      compile({ t, out, args }) {
        out.note(t, String(args.text ?? "ready"), "dim");
      },
    },
  },
};
