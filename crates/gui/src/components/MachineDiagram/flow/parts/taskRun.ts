/**
 * task run · one durable run through the steps (catalogue "task run"): step
 * stations by step type with lamps, and a status pill sliding queued →
 * executing → waiting → completed / failed. Frame 520×80, footprint L; the
 * TaskRun card enters W. Durations from the gallery "completes" and "parks at
 * a gate" stories: the run is queued 0.4 s, seats at the first station 0.4 s
 * later, hops between stations in 0.6 s and the pill slides in 0.35 s.
 */
import { card as makeCard } from "../../timeline";
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { leg } from "./common";

const R = 145;
const X = [110, 300, 490] as const;

const ports = {
  in: {
    side: "W",
    x: 50,
    y: R,
    direction: "in",
    tokens: ["payload", "request", "data"],
    description: "the TaskRun",
  },
} as const satisfies PartKindDef["ports"];

interface TaskRunProps {
  steps: readonly string[];
}

interface TaskRunState {
  id: string | null;
  /** Station the run is at (0..2). */
  cur: number;
  waiting: boolean;
}

type Ctx = VerbContext<TaskRunProps, TaskRunState>;
const label = (ctx: Ctx, i: number) =>
  ctx.part.props.steps[i] ?? `step ${i + 1}`;

export const taskRunPart: PartKindDef<TaskRunProps, TaskRunState> = {
  kind: "task run",
  job: "one durable run through the steps",
  family: "vertebrae workflows",
  footprint: "L",
  bb: [50, 105, 520, 80],
  status: { x: 320, y: 330 },
  props: {
    steps: {
      type: "string[]",
      default: ["llm", "execute", "finish"],
      description: "the step types at the three stations, never step names",
    },
  },
  ports,
  gates: () => [],
  // Around each station box; the tag sits left of the station lamp.
  stages: (props) =>
    X.map((x, i) => ({
      name: props.steps[i] ?? `step ${i + 1}`,
      bb: [x - 56, 104, 112, 82],
      tag: [x - 30, 126],
    })),
  init: () => ({ id: null, cur: 0, waiting: false }),
  verbs: {
    start: {
      duration: 1.0,
      card: "required",
      tokens: ["payload", "request", "data"],
      description: "the TaskRun is queued, then executes its first step",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        out.carry(
          [
            leg(
              [
                [50, R],
                [X[0], R],
              ],
              t + 0.4,
              0.5
            ),
          ],
          t + 0.4,
          HELD,
          { role: card!.role, tags: [["run", t + 0.45, t + 0.8]] }
        );
        state.id = card!.id;
        state.cur = 0;
        state.waiting = false;
        out.note(t, "queued", "dim");
        out.note(t + 0.8, `executing · ${label(ctx, 0)}`, "ink");
      },
    },
    stage: {
      duration: 1.3,
      card: "none",
      description:
        "the step at this station ends and the run moves to the next one",
      compile(ctx) {
        const { t, out, state } = ctx;
        const from = state.cur;
        if (from >= 2) {
          out.note(t, `executing · ${label(ctx, 2)}`, "ink");
          return;
        }
        const resumed = state.waiting;
        if (resumed) out.note(t, "answered · executing", "ink");
        state.waiting = false;
        if (state.id) {
          out.end(state.id, t);
          out.card(
            makeCard(
              28,
              "ink",
              [
                leg(
                  [
                    [X[from], R],
                    [X[from + 1], R],
                  ],
                  t,
                  0.6
                ),
              ],
              t,
              HELD,
              { id: state.id }
            )
          );
        }
        state.cur = from + 1;
        if (!resumed && state.cur < 2)
          out.note(t + 0.7, `executing · ${label(ctx, state.cur)}`, "ink");
      },
    },
    wait: {
      duration: 0.8,
      card: "none",
      description:
        "the step parks the run (a gate, child tasks) until something answers",
      compile(ctx) {
        const { t, out, state } = ctx;
        state.waiting = true;
        out.note(t, `waiting · ${label(ctx, state.cur)}`, "amber");
      },
    },
    finish: {
      duration: 0.8,
      card: "none",
      description: "the last step ends and the TaskRun completes",
      compile({ t, out, state }) {
        if (state.id) out.end(state.id, t + 0.2);
        state.id = null;
        state.waiting = false;
        out.note(t, "completed", "green");
      },
    },
    fail: {
      duration: 1.0,
      card: "none",
      description: "a step fails and the TaskRun fails with the reason saved",
      compile(ctx) {
        const { t, out, state } = ctx;
        out.note(t, `failed at ${label(ctx, state.cur)} · reason saved`, "red");
        if (state.id) out.end(state.id, t + 1.0);
        state.id = null;
      },
    },
    stop: {
      duration: 0.8,
      card: "none",
      description:
        "stop-taskrun parks the run: a stopped card is dimmed, not a new colour",
      compile(ctx) {
        const { t, out, state } = ctx;
        out.note(t, `stopped at ${label(ctx, state.cur)}`, "dim");
        if (state.id) out.end(state.id, t + 0.8);
        state.id = null;
      },
    },
  },
};
