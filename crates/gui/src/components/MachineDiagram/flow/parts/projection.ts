/**
 * projection · folds events into a read model (catalogue "projection"): a
 * handler hole, read-model bars and a checkpoint line. Frame 370×180,
 * footprint L; events enter W. Durations from the gallery "catches up" story:
 * an event reaches the handler in 0.55 s and the fold takes 0.45 s; a
 * rebuild replays at 0.38 s per event.
 */
import type { PartKindDef } from "../registry";
import { HELD } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 200,
    y: Y,
    direction: "in",
    tokens: ["event"],
    description: "event",
  },
} as const satisfies PartKindDef["ports"];

interface ProjectionProps {
  /** Events already folded (the checkpoint is `#<applied>`). */
  applied: number;
}

interface ProjectionState {
  applied: number;
  waiting: number;
  stuck: boolean;
}

export const projectionPart: PartKindDef<ProjectionProps, ProjectionState> = {
  kind: "projection",
  job: "folds events into a read model",
  family: "event sourcing",
  footprint: "L",
  bb: [200, 110, 370, 180],
  status: { x: 385, y: 322 },
  props: { applied: { type: "integer", min: 0, default: 3 } },
  ports,
  gates: () => sideGates(ports),
  init: (p) => ({ applied: p.applied, waiting: 0, stuck: false }),
  verbs: {
    fold: {
      duration: 1.1,
      card: "required",
      tokens: ["event"],
      description: "the handler applies one event to the read model",
      compile({ t, card, out, state }) {
        state.applied++;
        out.carry(
          [
            leg(
              [
                [200, Y],
                [260, Y],
              ],
              t,
              0.55
            ),
          ],
          t,
          t + 1.1,
          {
            role: card!.role,
            tags: [[`#${state.applied}`, t + 0.05, t + 0.4]],
          }
        );
        out.note(t + 1.05, `#${state.applied} applied`, "ink");
        return { consumed: true, role: "green" };
      },
    },
    record: {
      duration: 0.8,
      card: "required",
      tokens: ["event"],
      description: "an event arrives while the handler is stuck and waits",
      compile({ t, card, out, state }) {
        state.waiting++;
        out.carry(
          [
            leg(
              [
                [200, Y],
                [140, Y],
              ],
              t,
              0.5
            ),
          ],
          t,
          HELD,
          {
            role: "amber",
            tags: [
              [card!.label, t + 0.05, t + 0.4],
              ["waiting", t + 0.8, t + 2.0],
            ],
          }
        );
        out.note(
          t + 0.5,
          `lag ${state.waiting + (state.stuck ? 1 : 0)}`,
          "amber"
        );
        return { consumed: true };
      },
    },
    fail: {
      duration: 1.3,
      card: "required",
      tokens: ["event"],
      description:
        "the handler throws: the checkpoint stops at the last applied event and the lag grows",
      compile({ t, card, out, state }) {
        state.stuck = true;
        out.carry(
          [
            leg(
              [
                [200, Y],
                [260, Y],
              ],
              t,
              0.55
            ),
          ],
          t,
          HELD,
          {
            role: card!.role,
            col: [[t + 0.88, "red"]],
            tags: [[`#${state.applied + 1}`, t + 0.05, t + 0.4]],
          }
        );
        out.note(
          t + 1.0,
          `stuck at #${state.applied} · #${state.applied + 1} throws`,
          "red"
        );
        return { role: "red", consumed: true };
      },
    },
    replay: {
      duration: 3.2,
      card: "none",
      description: "wipe the read model and fold every event again from #0",
      args: { events: { type: "integer", min: 1, max: 12, default: 6 } },
      compile({ t, out, state, args }) {
        const n = Number(args.events);
        out.note(t, "wiped · replay from #0", "amber");
        out.note(t + 1.0, "rebuilding · · ·", "dim");
        state.applied = n;
        state.waiting = 0;
        state.stuck = false;
        const end = t + 1.0 + 0.38 * n + 0.2;
        out.note(end, `rebuilt · #${n}`, "green");
        return { duration: end - t + 0.4 };
      },
    },
  },
};
