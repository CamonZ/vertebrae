/**
 * splitter · copies to every branch (catalogue "splitter"): Y guides; one
 * card in, an origin-linked copy on each branch. Frame 180×160, footprint S;
 * in W, out E b1 (upper) and b2 (lower). `split` takes the card in; each
 * copy (a card declared with `origin: <splitter>`) then leaves by `send`.
 * Durations from the gallery "2 of 2" story.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const BRANCH = { b1: 155, b2: 245 } as const;
const tokens = ["copy", "data", "event", "request", "payload"] as const;

const ports = {
  in: { side: "W", x: 220, y: Y, direction: "in", tokens },
  b1: { side: "E", x: 400, y: 155, direction: "out", tokens },
  b2: { side: "E", x: 400, y: 245, direction: "out", tokens },
} as const satisfies PartKindDef["ports"];

interface SplitterState {
  copies: number;
  delivered: number;
  down: number;
}

export const splitterPart: PartKindDef<
  Record<string, unknown>,
  SplitterState
> = {
  kind: "splitter",
  job: "copies to every branch",
  family: "compute",
  footprint: "S",
  bb: [220, 120, 180, 160],
  status: { x: 310, y: 312 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ copies: 0, delivered: 0, down: 0 }),
  verbs: {
    split: {
      duration: 0.7,
      card: "required",
      description: "take one card in; its copies leave by `send`",
      args: { copies: { type: "integer", min: 1, default: 2 } },
      compile({ t, card, out, state, args }) {
        out.carry(
          [
            leg(
              [
                [220, Y],
                [300, Y],
              ],
              t,
              0.4
            ),
          ],
          t,
          t + 0.72,
          { role: card!.role }
        );
        state.copies = Number(args.copies);
        state.delivered = 0;
        state.down = 0;
        out.note(t, "one in", "ink");
        out.note(t + 0.7, `copy ×${state.copies}`, "dim");
        return { consumed: true };
      },
    },
    send: {
      duration: 0.5,
      card: "required",
      description: "a copy leaves on its branch",
      args: {
        branch: { type: "string", enum: ["b1", "b2"], required: true },
      },
      compile({ t, card, out, state, args }) {
        const b = args.branch as keyof typeof BRANCH;
        out.carry(
          [
            leg(
              [
                [300, Y],
                [340, Y],
                [400, BRANCH[b]],
              ],
              t,
              0.45
            ),
          ],
          t,
          t + 0.5,
          { role: card!.role }
        );
        state.delivered++;
        if (state.delivered + state.down >= state.copies)
          out.note(
            t + 0.45,
            `${state.delivered} of ${state.copies} delivered`,
            state.down ? "red" : "green"
          );
        return { exit: b };
      },
    },
    fail: {
      duration: 0.5,
      card: "none",
      description: "a branch is down: its copy is not delivered",
      args: { branch: { type: "string", enum: ["b1", "b2"] } },
      compile({ t, out, state }) {
        state.down++;
        out.note(
          t,
          `${state.delivered} of ${state.copies || 2} delivered`,
          "red"
        );
      },
    },
  },
};
