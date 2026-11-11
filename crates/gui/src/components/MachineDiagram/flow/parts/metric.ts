/**
 * metric · a number against a limit (catalogue "metric"): a gauge with a
 * warn tick and a limit tick. Frame 340×120, footprint L; samples enter W.
 * Durations from the gallery "under limit" story: a sample crosses in 0.45 s
 * and the gauge springs 0.24 s apart.
 */
import type { StateRole } from "../../palette";
import type { PartKindDef } from "../registry";
import { Y, leg } from "./common";
import { gateV } from "../../timeline";

const WARN = 40;
const LIMIT = 50;

const ports = {
  in: {
    side: "W",
    x: 150,
    y: Y,
    direction: "in",
    tokens: ["data", "event", "signal"],
    description: "sample",
  },
} as const satisfies PartKindDef["ports"];

interface MetricState {
  /** Gauge value in samples per second. */
  total: number;
  /** When each sample lands. */
  ev: number[];
  /** Read-out entries: `[t, text, role]`. */
  val: [number, string, StateRole][];
}

const read = (total: number): StateRole =>
  total > LIMIT ? "red" : total >= WARN ? "amber" : "ink";

export const metricPart: PartKindDef<Record<string, unknown>, MetricState> = {
  kind: "metric",
  job: "a number against a limit",
  family: "observability",
  footprint: "L",
  bb: [150, 140, 340, 120],
  status: { x: 320, y: 290 },
  ports,
  gates: () => [gateV(150, Y)],
  init: () => ({ total: 0, ev: [], val: [[0, "0 / s", "dim"]] }),
  verbs: {
    measure: {
      duration: 0.5,
      card: "optional",
      tokens: ["data", "event", "signal"],
      args: {
        by: {
          type: "number",
          min: 0,
          default: 6,
          description: "samples per second this sample adds",
        },
      },
      compile({ t, card, out, state, args }) {
        state.total += Number(args.by ?? 6);
        state.ev.push(t + 0.45);
        state.val.push([t + 0.45, `${state.total} / s`, read(state.total)]);
        if (card)
          out.carry(
            [
              leg(
                [
                  [24 + 126, Y],
                  [166, Y],
                ],
                t,
                0.45
              ),
            ],
            t,
            t + 0.48,
            { role: "dim", h: 8 }
          );
        out.note(t, "counting", "dim");
        return { consumed: true };
      },
    },
    observe: {
      duration: 0.6,
      card: "none",
      description: "read the gauge against its warn and limit ticks",
      compile({ t, out, state }) {
        const total = state.total;
        out.note(
          t,
          total > LIMIT
            ? "over limit"
            : total > WARN
              ? "near limit · past 40"
              : "under limit",
          total > LIMIT ? "red" : total > WARN ? "amber" : "green"
        );
      },
    },
    fail: {
      duration: 0.6,
      card: "none",
      compile({ t, out }) {
        out.note(t, "over limit", "red");
      },
    },
  },
};
