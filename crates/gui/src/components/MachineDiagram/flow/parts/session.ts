/**
 * session · lives across turns (catalogue "session"): dashed frame with a
 * pid lamp and a resume id. Frame 200×190, footprint S; turn in W, resume id
 * on a dashed ctl W, out E. Durations from the gallery "resumed" story
 * (spawn 0.6 s, a turn clamps in 0.55 s, close → resume id kept 0.9 s).
 *
 * `lifecycle` is the behaviour a change usually flips: a `one-shot` session
 * spawns a process for every turn and closes it after the reply or on
 * cancel; a `persistent` one keeps its process between turns, interrupts
 * instead of closing on cancel, and resumes from its id after a close.
 */
import { stay } from "../../timeline";
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { sideGates } from "./common";

/** The gallery draws the session on a rail at y 170, above the canvas centre. */
const Y = 170;

const ports = {
  turn: {
    side: "W",
    x: 220,
    y: Y,
    direction: "in",
    tokens: ["request", "payload"],
  },
  resume: {
    side: "W",
    x: 220,
    y: 245,
    direction: "in",
    tokens: ["control"],
    dashed: true,
    description: "control (cancel, resume id)",
  },
  out: {
    side: "E",
    x: 420,
    y: Y,
    direction: "out",
    tokens: ["result", "request", "event"],
  },
} as const satisfies PartKindDef["ports"];

interface SessionProps {
  lifecycle: "persistent" | "one-shot";
  /** Status text when a process starts, e.g. `--tools Read,Grep,Glob`. */
  launch?: string;
}

interface SessionState {
  live: boolean;
  resumable: boolean;
  processes: number;
  turns: number;
  clamped: string | null;
}

type Ctx = VerbContext<SessionProps, SessionState>;

function start(ctx: Ctx, t: number): "spawn" | "resume" {
  const { state, part, out } = ctx;
  const resume = state.resumable && part.props.lifecycle === "persistent";
  state.live = true;
  state.resumable = false;
  state.processes++;
  out.marker({
    t,
    kind: resume ? "resume" : "spawn",
    label: `process ${state.processes}`,
  });
  out.note(
    t,
    resume
      ? "resume · resume id"
      : `spawn${part.props.launch ? ` · ${part.props.launch}` : ""}`,
    "ink"
  );
  return resume ? "resume" : "spawn";
}

function close(ctx: Ctx, t: number, keepId: boolean, text: string) {
  ctx.state.live = false;
  ctx.state.resumable = keepId;
  ctx.out.marker({ t, kind: "close", label: `process ${ctx.state.processes}` });
  ctx.out.note(t, text, keepId ? "amber" : "dim");
}

function release(ctx: Ctx, t: number) {
  if (ctx.state.clamped) ctx.out.end(ctx.state.clamped, t);
  ctx.state.clamped = null;
}

export const sessionPart: PartKindDef<SessionProps, SessionState> = {
  kind: "session",
  job: "lives across turns",
  family: "topology and lifecycle",
  footprint: "S",
  bb: [220, 100, 200, 190],
  status: { x: 320, y: 322 },
  props: {
    lifecycle: {
      type: "string",
      enum: ["persistent", "one-shot"],
      default: "persistent",
      description:
        "one-shot: a process per turn; persistent: one process kept between turns",
    },
    launch: {
      type: "string",
      description: "status text when a process starts",
    },
  },
  ports,
  gates: () => sideGates(ports),
  init: () => ({
    live: false,
    resumable: false,
    processes: 0,
    turns: 0,
    clamped: null,
  }),
  verbs: {
    connect: {
      duration: 0.6,
      card: "none",
      compile(ctx) {
        if (ctx.state.live) {
          ctx.out.note(ctx.t, "already live", "dim");
          return;
        }
        start(ctx, ctx.t);
      },
    },
    stage: {
      duration: 0.55,
      card: "required",
      tokens: ["request", "payload"],
      description:
        "a turn: starts or resumes a process when none is live, then clamps the turn",
      compile(ctx) {
        const { t, card, out, state, part } = ctx;
        let at = t;
        if (!state.live) {
          start(ctx, t);
          at += 0.6;
        } else {
          out.note(t, "same process · no spawn", "ink");
        }
        state.turns++;
        // The card waits at the port while a process starts, so the hand-off from the rail is seamless.
        out.carry(
          [
            stay(220, Y, t),
            [
              [
                [220, Y],
                [320, Y],
              ],
              at,
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
        out.note(
          at + 0.45,
          part.props.lifecycle === "persistent"
            ? `live · turn ${state.turns}`
            : `process ${state.processes} · one shot`,
          "amber"
        );
        return { duration: at - t + 0.55 };
      },
    },
    finish: {
      duration: 0.5,
      card: "optional",
      description:
        "the reply leaves; a one-shot session then closes its process",
      compile(ctx) {
        const { t, card, out, part } = ctx;
        release(ctx, t);
        if (card)
          out.carry(
            [
              [
                [
                  [320, Y],
                  [420, Y],
                ],
                t,
                0.35,
              ],
            ],
            t,
            t + 0.4,
            {
              role: card.role,
            }
          );
        out.note(t, "turn done", "green");
        if (part.props.lifecycle === "one-shot") {
          close(ctx, t + 0.5, false, "one shot · closed");
          return { duration: 0.8, exit: "out" };
        }
        out.note(t + 0.3, "idle · process kept", "amber");
        return { exit: "out" };
      },
    },
    cancel: {
      duration: 0.8,
      card: "optional",
      tokens: ["control"],
      description: "interrupt the turn; a one-shot session closes its process",
      compile(ctx) {
        const { t, card, out, part } = ctx;
        if (card)
          out.carry(
            [
              [
                [
                  [220, 245],
                  [300, 245],
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
        release(ctx, t + 0.1);
        if (part.props.lifecycle === "one-shot") {
          close(ctx, t + 0.3, false, "stop · process closed");
        } else {
          out.marker({
            t: t + 0.1,
            kind: "interrupt",
            label: "turn interrupted",
          });
          out.note(t + 0.1, "interrupted · process kept", "amber");
        }
        return { consumed: true };
      },
    },
    close: {
      duration: 0.9,
      card: "none",
      description:
        "close an idle process; a persistent session keeps its resume id",
      compile(ctx) {
        const { t, out, state, part } = ctx;
        if (!state.live) {
          out.note(t, "nothing to close", "dim");
          return { duration: 0.5 };
        }
        const keep = part.props.lifecycle === "persistent";
        close(ctx, t + 0.3, keep, keep ? "closed · resume id kept" : "closed");
        if (keep)
          out.marker({
            t: t + 0.3,
            kind: "checkpoint",
            label: "resume id kept",
          });
      },
    },
    resume: {
      duration: 0.6,
      card: "optional",
      tokens: ["control"],
      compile(ctx) {
        const { t, out, state } = ctx;
        if (state.live) {
          out.note(t, "already live", "dim");
          return;
        }
        if (!state.resumable) {
          out.note(t, "resume failed · history lost", "red");
          return;
        }
        start(ctx, t);
      },
    },
  },
};
