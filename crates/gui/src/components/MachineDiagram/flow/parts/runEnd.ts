/**
 * run end · stop pauses, finish completes (catalogue "run end"): a stop bar
 * that drops across the rail, and the finish terminal. Frame 120×120,
 * footprint S; TaskRun in W, a resumed run out E, stop-taskrun N (dashed).
 * Durations from the gallery stories: the run seats in 0.6 s, the stop bar
 * drops 0.3 s later, finish fills the terminal 0.9 s after the run arrives.
 */
import { RAIL_Y as Y } from "../../partGeometry";
import { card as makeCard } from "../../timeline";
import { HELD, type PartKindDef } from "../registry";
import { leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 270,
    y: Y,
    direction: "in",
    tokens: ["payload", "request", "data"],
    description: "TaskRun",
  },
  out: {
    side: "E",
    x: 390,
    y: Y,
    direction: "out",
    tokens: ["payload", "request", "data"],
    description: "the next TaskRun continuing from a stop step",
  },
  stop: {
    side: "N",
    x: 330,
    y: 140,
    direction: "in",
    tokens: ["control"],
    dashed: true,
    description: "stop-taskrun",
  },
} as const satisfies PartKindDef["ports"];

interface RunEndState {
  held: string | null;
  /** The stop bar is across the rail. */
  barDown: boolean;
}

export const runEndPart: PartKindDef<Record<string, unknown>, RunEndState> = {
  kind: "run end",
  job: "stop pauses, finish completes",
  family: "vertebrae workflows",
  footprint: "S",
  bb: [270, 140, 120, 120],
  status: { x: 330, y: 318 },
  ports,
  gates: () => sideGates({ in: ports.in, out: ports.out }),
  init: () => ({ held: null, barDown: false }),
  verbs: {
    finish: {
      duration: 1.1,
      card: "required",
      tokens: ["payload", "request", "data"],
      description:
        "the run crosses to the finish terminal and the task completes",
      compile({ t, card, out }) {
        out.carry(
          [
            leg(
              [
                [270, Y],
                [546, Y],
              ],
              t,
              0.9
            ),
          ],
          t,
          t + 1.0,
          { role: card!.role, tags: [[card!.label, t + 0.05, t + 0.4]] }
        );
        out.note(t, "run working", "ink");
        out.note(t + 0.9, "finish · task completed", "green");
        return { consumed: true, role: "green" as const };
      },
    },
    stop: {
      duration: 1.3,
      card: "required",
      tokens: ["payload", "request", "data"],
      description:
        "the run is parked: a stop step drops the bar, stop-taskrun stops it from outside",
      args: {
        by: { type: "string", enum: ["step", "user"], default: "step" },
      },
      compile({ t, card, out, state, args }) {
        const user = args.by === "user";
        out.carry(
          [
            leg(
              [
                [270, Y],
                [300, Y],
              ],
              t,
              0.6
            ),
          ],
          t,
          HELD,
          {
            role: card!.role,
            col: [[t + (user ? 1.5 : 0.9), "edge"]],
            tags: [[card!.label, t + 0.05, t + 0.4]],
          }
        );
        state.held = card!.id;
        if (user) {
          out.card(
            makeCard(
              28,
              "ink",
              [
                leg(
                  [
                    [330, 96],
                    [330, 170],
                  ],
                  t + 0.3,
                  0.4
                ),
              ],
              t + 0.3,
              t + 0.8,
              { hollow: true, tags: [["stop", t + 0.35, t + 0.75]] }
            )
          );
          out.note(t, "run working", "ink");
          out.note(t + 0.6, "stop-taskrun · stopping", "amber");
          out.note(t + 1.5, "stopped · task not done", "dim");
          return { duration: 1.6, consumed: true, role: "ink" as const };
        }
        state.barDown = true;
        out.note(t, `${card!.label} at stop step`, "ink");
        out.note(t + 0.9, `${card!.label} stopped · task open`, "dim");
        return { consumed: true, role: "ink" as const };
      },
    },
    resume: {
      duration: 1.3,
      card: "required",
      tokens: ["payload", "request", "data"],
      description: "a new TaskRun starts and continues from the stop step",
      compile({ t, card, out, state }) {
        if (state.held) out.end(state.held, t);
        state.held = null;
        state.barDown = false;
        out.carry(
          [
            leg(
              [
                [300, Y],
                [390, Y],
              ],
              t + 0.2,
              0.5
            ),
          ],
          t + 0.15,
          t + 1.2,
          { role: card!.role, tags: [[card!.label, t + 0.25, t + 0.9]] }
        );
        out.note(t, "next TaskRun starts", "ink");
        out.note(t + 0.5, "continues from the stop", "dim");
        return { exit: "out" };
      },
    },
  },
};
