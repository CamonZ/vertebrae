/**
 * event rail · ordered facts (catalogue "event rail"): a long rail of event
 * dots with a reader cursor. Frame 570×60, footprint L; along W → E.
 * Durations from the gallery "turn complete" story: a fact crosses in
 * 0.6 s and the status swaps as it lands.
 */
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { Y, sideGates } from "./common";

const tokens = ["event", "result", "request", "signal"] as const;
const ports = {
  in: { side: "W", x: 35, y: Y, direction: "in", tokens },
  out: { side: "E", x: 605, y: Y, direction: "out", tokens },
} as const satisfies PartKindDef["ports"];

export const eventRailPart: PartKindDef<
  Record<string, unknown>,
  { events: number }
> = {
  kind: "event rail",
  job: "ordered facts",
  family: "messaging and flow control",
  footprint: "L",
  bb: [35, 170, 570, 60],
  status: { x: 320, y: 268 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ events: 0 }),
  verbs: {
    send: {
      duration: 0.7,
      card: "optional",
      args: {
        event: {
          type: "string",
          description: "event name for the status line",
        },
        role: {
          type: "string",
          enum: ["dim", "ink", "amber", "green", "red"],
          default: "ink",
        },
      },
      compile({ t, card, out, state, args }) {
        state.events++;
        const role = args.role as "dim" | "ink" | "amber" | "green" | "red";
        if (card) {
          out.carry(
            [
              [
                [
                  [35, Y],
                  [605, Y],
                ],
                t,
                0.6,
              ],
            ],
            t,
            t + 0.65,
            {
              role: card.role,
            }
          );
        } else {
          out.card(
            dot(
              [
                [35, Y],
                [320, Y],
              ],
              t,
              0.5,
              role
            )
          );
        }
        out.note(t + 0.3, String(args.event ?? card?.label ?? "event"), role);
        return { exit: "out" };
      },
    },
    observe: {
      duration: 0.5,
      card: "none",
      compile({ t, out }) {
        out.note(t, "live", "dim");
      },
    },
    wait: {
      duration: 1,
      card: "none",
      compile({ t, out }) {
        out.note(t, "disconnected", "amber");
      },
    },
    resume: {
      duration: 0.8,
      card: "none",
      args: { from: { type: "integer", min: 0 } },
      compile({ t, out, args, state }) {
        out.note(
          t,
          `reconnect · from #${String(args.from ?? state.events)}`,
          "amber"
        );
        out.note(t + 0.5, "caught up", "green");
      },
    },
  },
};
