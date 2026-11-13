/**
 * worker · runs one job (catalogue "worker", the press). Frame 220×190,
 * footprint M; in W, out E, ctl N. Durations from the gallery "done" story:
 * job arrives 0.6 → working 1.35 (stage 0.75) → done 2.65 (finish 0.6 after
 * the work hold). A finished job leaves as a result with the same card id.
 */
import { RAIL_Y as Y } from "../../partGeometry";
import { HELD, type PartKindDef } from "../registry";
import { sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 210,
    y: Y,
    direction: "in",
    tokens: ["request", "data", "payload"],
  },
  out: { side: "E", x: 430, y: Y, direction: "out", tokens: ["result"] },
  ctl: { side: "N", x: 320, y: 105, direction: "in", tokens: ["control"] },
} as const satisfies PartKindDef["ports"];

interface WorkerState {
  /** Id of the card clamped in the press. */
  clamped: string | null;
}

export const workerPart: PartKindDef<Record<string, unknown>, WorkerState> = {
  kind: "worker",
  job: "runs one job",
  family: "compute",
  footprint: "M",
  bb: [210, 105, 220, 190],
  status: { x: 320, y: 328 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ clamped: null }),
  verbs: {
    stage: {
      duration: 0.75,
      card: "required",
      tokens: ["request", "data", "payload"],
      compile({ t, card, out, state }) {
        out.carry(
          [
            [
              [
                [210, Y],
                [320, Y],
              ],
              t,
              0.45,
            ],
          ],
          t,
          HELD,
          {
            role: card!.role,
          }
        );
        state.clamped = card!.id;
        out.note(t, "job arrives", "ink");
        out.note(t + 0.75, "working · · ·", "dim");
      },
    },
    finish: {
      duration: 0.6,
      card: "optional",
      args: { work: { type: "number", min: 0, default: 0 } },
      compile({ t, card, out, state, args }) {
        const at = t + Number(args.work ?? 0);
        if (state.clamped) out.end(state.clamped, at);
        state.clamped = null;
        if (card)
          out.carry(
            [
              [
                [
                  [320, Y],
                  [430, Y],
                ],
                at,
                0.4,
              ],
            ],
            at,
            at + 0.5,
            {
              role: "green",
            }
          );
        out.note(at, "done", "green");
        // The job leaves as its result, keeping its id (catalogue: returns keep request identity).
        return {
          duration: at - t + 0.6,
          role: "green",
          exit: "out",
          ...(card ? { token: "result" as const } : {}),
        };
      },
    },
    fail: {
      duration: 0.6,
      card: "none",
      args: { reason: { type: "string", default: "exit 1" } },
      compile({ t, out, state, args }) {
        if (state.clamped) out.end(state.clamped, t + 0.3);
        state.clamped = null;
        out.note(t, `failed · ${String(args.reason)}`, "red");
      },
    },
    cancel: {
      duration: 0.6,
      card: "optional",
      tokens: ["control"],
      compile({ t, card, out, state }) {
        if (card)
          out.carry(
            [
              [
                [
                  [320, 105],
                  [320, 170],
                ],
                t,
                0.3,
              ],
            ],
            t,
            t + 0.35,
            {
              role: card.role,
            }
          );
        if (state.clamped) out.end(state.clamped, t + 0.3);
        state.clamped = null;
        out.note(t + 0.3, "cancelled", "dim");
        return { consumed: true };
      },
    },
  },
};
