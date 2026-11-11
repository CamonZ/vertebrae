/**
 * pipeline · ordered stages (catalogue "pipeline"): divided stages, each
 * lighting in order as the card visits it. Frame 480×150, footprint L; in
 * W, out E. Durations from the gallery "all pass" story: a stage hop takes
 * 0.45 s and each stage works for about a second.
 */
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 80,
    y: Y,
    direction: "in",
    tokens: ["payload", "request", "data"],
  },
  out: { side: "E", x: 560, y: Y, direction: "out", tokens: ["result"] },
} as const satisfies PartKindDef["ports"];

interface PipelineProps {
  /** Stage names, in order (drawn three per frame). */
  stages: readonly string[];
}

interface PipelineState {
  /** Index of the stage holding the card, -1 before the first. */
  at: number;
  card: string | null;
}

type Ctx = VerbContext<PipelineProps, PipelineState>;

const stageX = (i: number) => 160 + 160 * Math.min(i, 2);
const stageName = (ctx: Ctx, i: number) =>
  ctx.part.props.stages[i] ?? `stage ${i + 1}`;

function stop(ctx: Ctx, at: number) {
  if (ctx.state.card) ctx.out.end(ctx.state.card, at);
  ctx.state.card = null;
}

export const pipelinePart: PartKindDef<PipelineProps, PipelineState> = {
  kind: "pipeline",
  job: "ordered stages",
  family: "compute",
  footprint: "L",
  bb: [80, 125, 480, 150],
  status: { x: 320, y: 310 },
  props: {
    stages: { type: "string[]", default: ["build", "test", "ship"] },
  },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ at: -1, card: null }),
  verbs: {
    stage: {
      duration: 1.0,
      card: "required",
      description: "the card moves into the next stage",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const from = state.at < 0 ? 80 : stageX(state.at);
        stop(ctx, t);
        state.at++;
        out.carry(
          [
            leg(
              [
                [from, Y],
                [stageX(state.at), Y],
              ],
              t,
              0.45
            ),
          ],
          t,
          HELD,
          { role: card!.role, lean: state.at > 0 ? [t] : [] }
        );
        state.card = card!.id;
        out.note(
          t,
          `stage ${state.at + 1} · ${stageName(ctx, state.at)}`,
          "dim"
        );
      },
    },
    finish: {
      duration: 0.6,
      card: "optional",
      description: "the last stage passed: the result leaves",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const from = stageX(Math.max(0, state.at));
        stop(ctx, t);
        state.at = -1;
        if (card)
          out.carry(
            [
              leg(
                [
                  [from, Y],
                  [560, Y],
                ],
                t,
                0.45
              ),
            ],
            t,
            t + 0.5,
            { role: "green", lean: [t] }
          );
        out.note(t, "all stages passed", "green");
        return card
          ? { exit: "out", role: "green" as const, token: "result" as const }
          : {};
      },
    },
    fail: {
      duration: 0.6,
      card: "none",
      compile(ctx) {
        ctx.out.note(
          ctx.t,
          `failed at ${stageName(ctx, Math.max(0, ctx.state.at))}`,
          "red"
        );
        stop(ctx, ctx.t + 0.35);
        ctx.state.at = -1;
      },
    },
    cancel: {
      duration: 0.5,
      card: "optional",
      tokens: ["control"],
      compile(ctx) {
        const { t, card, out } = ctx;
        if (card)
          out.carry(
            [
              leg(
                [
                  [stageX(Math.max(0, ctx.state.at)), 125],
                  [stageX(Math.max(0, ctx.state.at)), 170],
                ],
                t,
                0.3
              ),
            ],
            t,
            t + 0.35,
            { role: card.role }
          );
        out.note(
          t + 0.3,
          `cancelled at ${stageName(ctx, Math.max(0, ctx.state.at))}`,
          "ink"
        );
        stop(ctx, t + 0.3);
        ctx.state.at = -1;
        return { consumed: true };
      },
    },
  },
};
