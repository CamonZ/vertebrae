/**
 * client · asks, then renders (catalogue "client"). Frame 240×170,
 * footprint M; request out E upper, result in E lower. Control cards
 * (cancel) leave by the request port. Durations from the gallery "rendered"
 * story: send 0.6 → waiting 1.35; render pops bars in over 0.5 s.
 */
import type { PartKindDef } from "../registry";
import { centred, sideGates } from "./common";

const ports = {
  request: {
    side: "E",
    x: 440,
    y: 170,
    direction: "out",
    tokens: ["request", "control", "payload"],
  },
  result: { side: "E", x: 440, y: 230, direction: "in", tokens: ["result"] },
} as const satisfies PartKindDef["ports"];

interface ClientState {
  waiting: number;
}

export const clientPart: PartKindDef<Record<string, unknown>, ClientState> = {
  kind: "client",
  job: "asks, then renders",
  family: "actors",
  footprint: "M",
  bb: centred(240, 170),
  status: { x: 320, y: 318 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ waiting: 0 }),
  verbs: {
    send: {
      duration: 0.45,
      card: "required",
      tokens: ["request", "payload"],
      compile({ t, card, out, state }) {
        out.carry(
          [
            [
              [
                [320, 170],
                [440, 170],
              ],
              t,
              0.4,
            ],
          ],
          t,
          t + 0.45,
          {
            role: card!.role,
          }
        );
        out.note(t, `send · ${card!.label}`, "ink");
        state.waiting++;
        out.note(t + 0.45, "waiting · · ·", "amber");
        return { exit: "request" };
      },
    },
    wait: {
      duration: 1,
      card: "none",
      args: { seconds: { type: "number", min: 0, default: 1 } },
      compile({ t, out, args }) {
        out.note(t, "still waiting", "amber");
        return { duration: Number(args.seconds) };
      },
    },
    render: {
      duration: 0.5,
      card: "required",
      args: {
        outcome: { type: "string", enum: ["ok", "error"], default: "ok" },
      },
      compile({ t, card, out, state, args }) {
        const ok = args.outcome !== "error";
        out.carry(
          [
            [
              [
                [440, 230],
                [320, 230],
              ],
              t,
              0.35,
            ],
          ],
          t,
          t + 0.45,
          {
            role: ok ? card!.role : "red",
            tags: [],
          }
        );
        state.waiting = Math.max(0, state.waiting - 1);
        out.note(
          t + 0.35,
          ok ? "rendered" : "error shown",
          ok ? "green" : "red"
        );
        return { consumed: true };
      },
    },
    cancel: {
      duration: 0.4,
      card: "required",
      tokens: ["control"],
      compile({ t, card, out }) {
        out.carry(
          [
            [
              [
                [320, 170],
                [440, 170],
              ],
              t,
              0.35,
            ],
          ],
          t,
          t + 0.4,
          {
            role: card!.role,
          }
        );
        out.note(t, "cancel pressed", "ink");
        return { exit: "request" };
      },
    },
  },
};
