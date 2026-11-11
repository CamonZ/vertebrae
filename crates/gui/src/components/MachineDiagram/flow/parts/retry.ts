/**
 * retry · tries again, then gives up (catalogue "retry"): a caller box and a
 * service box with an attempt counter between. Frame 170×140, footprint S;
 * out E (upper) carries attempt n, in E (lower) the result. Durations from
 * the gallery "ok on 2nd" story: an attempt leaves in 0.6 s and the failure
 * shows 1.6 s later, then a back-off of 0.8 s per attempt.
 */
import type { PartKindDef } from "../registry";
import { leg } from "./common";
import { gateV } from "../../timeline";

const ports = {
  out: {
    side: "E",
    x: 320,
    y: 170,
    direction: "out",
    tokens: ["request"],
    description: "request (attempt n)",
  },
  in: { side: "E", x: 320, y: 235, direction: "in", tokens: ["result"] },
} as const satisfies PartKindDef["ports"];

interface RetryProps {
  /** Attempts before giving up (1..3). */
  attempts: number;
}

interface RetryState {
  attempt: number;
  /** Back-off rings and lamps for the drawing: `[from, to]`, `[t, role]`. */
  rings: [number, number][];
  lamps: [number, "red" | "green"][];
}

export const retryPart: PartKindDef<RetryProps, RetryState> = {
  kind: "retry",
  job: "tries again, then gives up",
  family: "messaging and flow control",
  footprint: "S",
  bb: [150, 130, 170, 140],
  status: { x: 235, y: 300 },
  props: { attempts: { type: "integer", min: 1, max: 3, default: 3 } },
  ports,
  gates: () => [gateV(320, 170), gateV(320, 235)],
  init: () => ({ attempt: 0, rings: [], lamps: [] }),
  verbs: {
    send: {
      duration: 0.6,
      card: "required",
      tokens: ["request"],
      description: "the next attempt leaves for the service",
      args: {
        outcome: {
          type: "string",
          enum: ["ok", "error"],
          description: "`ok`: the service answers and the lamp turns green",
        },
      },
      compile({ t, card, out, state, args }) {
        state.attempt++;
        out.carry(
          [
            leg(
              [
                [280, 170],
                [320, 170],
              ],
              t,
              0.5
            ),
          ],
          t,
          t + 0.55,
          {
            role: card!.role,
            tags: [[`try ${state.attempt}`, t + 0.1, t + 0.5]],
          }
        );
        out.note(t, `attempt ${state.attempt}`, "ink");
        if (args.outcome === "ok") {
          state.lamps.push([t + 1.6, "green"]);
          out.note(t + 1.6, `ok on attempt ${state.attempt}`, "green");
          return { exit: "out", duration: 1.9 };
        }
        return { exit: "out" };
      },
    },
    wait: {
      duration: 0.8,
      card: "none",
      description: "the attempt failed; back off before the next one",
      args: { seconds: { type: "number", min: 0, default: 0.8 } },
      compile({ t, out, state, args }) {
        const d = Number(args.seconds ?? 0.8) * Math.max(1, state.attempt);
        state.lamps.push([t, "red"]);
        state.rings.push([t + 0.1, t + 0.1 + d]);
        out.note(t, "failed · backing off", "amber");
        return { duration: d + 0.1 };
      },
    },
    retry: {
      duration: 0.8,
      card: "required",
      tokens: ["request"],
      description: "back off, then send the same request again",
      args: {
        seconds: { type: "number", min: 0, default: 0.8 },
        outcome: { type: "string", enum: ["ok", "error"] },
      },
      compile({ t, card, out, state, args }) {
        const d = Number(args.seconds ?? 0.8) * Math.max(1, state.attempt);
        state.lamps.push([t, "red"]);
        state.rings.push([t + 0.1, t + 0.1 + d]);
        out.note(t, "failed · backing off", "amber");
        state.attempt++;
        const at = t + d + 0.1;
        out.carry(
          [
            leg(
              [
                [280, 170],
                [320, 170],
              ],
              at,
              0.5
            ),
          ],
          at,
          at + 0.55,
          {
            role: card!.role,
            tags: [[`try ${state.attempt}`, at + 0.1, at + 0.5]],
          }
        );
        out.note(at, `attempt ${state.attempt}`, "ink");
        if (args.outcome === "ok") {
          state.lamps.push([at + 1.6, "green"]);
          out.note(at + 1.6, `ok on attempt ${state.attempt}`, "green");
          return { exit: "out", duration: d + 2.0 };
        }
        return { exit: "out", duration: d + 0.7 };
      },
    },
    fail: {
      duration: 0.8,
      card: "none",
      args: {
        reason: {
          type: "string",
          description: "defaults to `gave up after <attempts>`",
        },
      },
      compile({ t, out, state, args }) {
        state.lamps.push([t, "red"]);
        out.note(
          t,
          args.reason !== undefined
            ? String(args.reason)
            : `gave up after ${state.attempt}`,
          "red"
        );
      },
    },
  },
};
