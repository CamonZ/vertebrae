/**
 * timeout · stops waiting at a deadline (catalogue "timeout"): a fuse that
 * burns down to the deadline; a callee box for cancel. Frame 240×150,
 * footprint M; in W, out E (callee), ctl S (cancel at the deadline).
 * Durations from the gallery "in time" story: a request seats in 0.6 s and
 * the fuse burns from 1.2 s.
 */
import { HELD, type PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: { side: "W", x: 200, y: Y, direction: "in", tokens: ["request"] },
  out: {
    side: "E",
    x: 440,
    y: Y,
    direction: "out",
    tokens: ["request", "result"],
    description: "request (callee)",
  },
  cancel: {
    side: "S",
    x: 320,
    y: 275,
    direction: "out",
    tokens: ["control"],
    dashed: true,
    description: "cancel at the deadline",
  },
} as const satisfies PartKindDef["ports"];

interface TimeoutProps {
  /** Seconds the caller will wait. */
  budget: number;
}

interface TimeoutState {
  held: string | null;
  /** The fuse burns `from → to`; `to` is null until it ends. */
  fuse: {
    from: number;
    to: number | null;
    role: "green" | "red" | null;
  } | null;
  /** Callee spinner while it works on a request: `[from, to]`. */
  callee: [number, number | null] | null;
}

export const timeoutPart: PartKindDef<TimeoutProps, TimeoutState> = {
  kind: "timeout",
  job: "stops waiting at a deadline",
  family: "messaging and flow control",
  footprint: "M",
  bb: [200, 125, 240, 150],
  status: { x: 320, y: 306 },
  props: { budget: { type: "number", min: 0, default: 2 } },
  ports,
  gates: () => sideGates(ports).slice(0, 2),
  init: () => ({ held: null, fuse: null, callee: null }),
  verbs: {
    wait: {
      duration: 0.6,
      card: "required",
      tokens: ["request"],
      description: "the caller's request seats and the fuse starts burning",
      compile({ t, card, out, state, part }) {
        out.carry(
          [
            leg(
              [
                [200, Y],
                [300, Y],
              ],
              t,
              0.6
            ),
          ],
          t,
          HELD,
          { role: card!.role }
        );
        state.held = card!.id;
        state.fuse = { from: t + 0.6, to: null, role: null };
        state.callee = [t + 0.7, null];
        out.note(t + 0.6, `waiting · ${part.props.budget} s budget`, "amber");
      },
    },
    tick: {
      duration: 1,
      card: "none",
      args: {
        seconds: { type: "number", min: 0, default: 1 },
        answer: {
          type: "boolean",
          default: false,
          description: "the callee answers in time: the caller is released",
        },
      },
      compile({ t, out, state, args, part }) {
        const d = Number(args.seconds ?? 1);
        if (args.answer === true && state.held) {
          out.end(state.held, t + d);
          out.note(t + d, "answered in time", "green");
          if (state.fuse)
            state.fuse = { ...state.fuse, to: t + d, role: "green" };
          if (state.callee) state.callee = [state.callee[0], t + d];
          state.held = null;
        } else out.note(t, `waiting · ${part.props.budget} s budget`, "amber");
        return { duration: d };
      },
    },
    expire: {
      duration: 0.8,
      card: "none",
      description: "the deadline passes: the caller stops waiting",
      compile({ t, out, state, part }) {
        if (state.held) out.end(state.held, t + 0.3);
        state.held = null;
        if (state.fuse) state.fuse = { ...state.fuse, to: t, role: "red" };
        out.note(t, `timed out · ${part.props.budget} s`, "red");
      },
    },
    cancel: {
      duration: 0.8,
      card: "optional",
      tokens: ["control"],
      description: "the deadline cancels the callee so nothing leaks",
      compile({ t, card, out, state }) {
        if (card)
          out.carry(
            [
              leg(
                [
                  [452, Y],
                  [560, Y],
                ],
                t,
                0.5
              ),
            ],
            t,
            t + 0.6,
            { role: card.role }
          );
        if (state.callee) state.callee = [state.callee[0], t + 0.6];
        out.note(t + 0.6, "callee stopped · no leak", "green");
        return { consumed: true };
      },
    },
  },
};
