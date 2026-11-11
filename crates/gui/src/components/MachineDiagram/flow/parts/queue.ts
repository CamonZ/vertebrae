/**
 * queue · first in, first out (catalogue "queue"): a long low box with slots,
 * a consumer box and a dead-letter bin. Frame 380×80, footprint L; in W, out E
 * (to the consumer), dead letter S. Durations from the gallery "drains" and
 * "dead letter" stories: a job seats in 0.6 s, shifts forward in 0.35 s and
 * is delivered or redelivered in 0.6 s.
 */
import { card as makeCard } from "../../timeline";
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { Y, leg, sideGates } from "./common";

const slot = (i: number) => [470 - i * 40, Y] as const;
const CONSUMER = [587, Y] as const;

const ports = {
  in: {
    side: "W",
    x: 130,
    y: Y,
    direction: "in",
    tokens: ["request", "batch", "data", "payload"],
  },
  out: {
    side: "E",
    x: 510,
    y: Y,
    direction: "out",
    tokens: ["request", "data", "payload"],
  },
  dead: {
    side: "S",
    x: 470,
    y: 240,
    direction: "out",
    tokens: ["request", "data", "payload"],
    description: "dead-letter bin",
  },
} as const satisfies PartKindDef["ports"];

interface QueueProps {
  /** Slots in the queue (1..5); a card that finds none free is rejected. */
  slots: number;
}

interface QueueState {
  /** Card ids waiting, front first. */
  waiting: string[];
  /** Card label by id, for status text. */
  labels: Record<string, string>;
  tries: Record<string, number>;
}

type Ctx = VerbContext<QueueProps, QueueState>;

function waitingNote(ctx: Ctx, t: number) {
  const n = ctx.state.waiting.length;
  ctx.out.note(t, `${n} waiting`, n ? "ink" : "dim");
}

/** Cards behind position `from` move one slot forward, keeping their ids. */
function shift(ctx: Ctx, from: number, t: number) {
  const { state, out } = ctx;
  for (let j = from; j < state.waiting.length; j++) {
    const id = state.waiting[j];
    out.end(id, t);
    out.card(
      makeCard(28, "ink", [leg([slot(j + 1), slot(j)], t, 0.35)], t, HELD, {
        id,
      })
    );
  }
}

function take(ctx: Ctx, t: number): number {
  const i = ctx.state.waiting.indexOf(ctx.card!.id);
  if (i < 0) ctx.out.note(t, `${ctx.card!.label} is not waiting`, "dim");
  return i;
}

export const queuePart: PartKindDef<QueueProps, QueueState> = {
  kind: "queue",
  job: "first in, first out",
  family: "messaging and flow control",
  footprint: "L",
  bb: [130, 160, 380, 80],
  status: { x: 320, y: 272 },
  props: { slots: { type: "integer", min: 1, max: 5, default: 5 } },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ waiting: [], labels: {}, tries: {} }),
  verbs: {
    send: {
      duration: 0.6,
      card: "required",
      tokens: ["request", "batch", "data", "payload"],
      description: "a job takes the next slot, or is rejected when full",
      compile(ctx) {
        const { t, card, out, state, part } = ctx;
        const n = state.waiting.length;
        if (n >= part.props.slots) {
          out.carry(
            [
              leg(
                [
                  [130, Y],
                  [118, Y],
                ],
                t,
                0.3
              ),
              leg(
                [
                  [118, Y],
                  [24, Y],
                ],
                t + 0.4,
                0.5
              ),
            ],
            t,
            t + 1.0,
            { role: "ink", col: [[t + 0.35, "red"]], lean: [t + 0.4] }
          );
          out.note(t + 0.3, `full · ${card!.label} rejected`, "red");
          return { consumed: true, role: "red" as const };
        }
        out.carry([leg([[130, Y], slot(n)], t, 0.6)], t, HELD, {
          role: card!.role,
        });
        state.waiting.push(card!.id);
        state.labels[card!.id] = card!.label;
        waitingNote(ctx, t + 0.01);
        return {};
      },
    },
    wait: {
      duration: 1,
      card: "none",
      args: { seconds: { type: "number", min: 0, default: 1 } },
      compile(ctx) {
        const n = ctx.state.waiting.length;
        ctx.out.note(ctx.t, `${n} waiting`, n ? "amber" : "dim");
        return { duration: Number(ctx.args.seconds) };
      },
    },
    drain: {
      duration: 0.8,
      card: "required",
      description: "the consumer takes a waiting job; the rest move forward",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const i = take(ctx, t);
        if (i < 0) return { duration: 0.4 };
        out.end(card!.id, t);
        out.carry([leg([slot(i), [510, Y]], t, 0.6)], t, t + 0.65, {
          role: "ink",
          lean: [t],
        });
        state.waiting.splice(i, 1);
        shift(ctx, i, t + 0.05);
        out.note(t, `${card!.label} delivered`, "ink");
        waitingNote(ctx, t + 0.7);
        return { exit: "out", role: "ink" as const };
      },
    },
    retry: {
      duration: 1.6,
      card: "required",
      description:
        "the consumer rejects a delivery: the job goes back to the front",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const i = take(ctx, t);
        if (i < 0) return { duration: 0.4 };
        const tries = (state.tries[card!.id] =
          (state.tries[card!.id] ?? 1) + 1);
        out.end(card!.id, t);
        out.carry(
          [
            leg([slot(i), CONSUMER], t, 0.6),
            leg([CONSUMER, slot(0)], t + 0.95, 0.6),
          ],
          t,
          HELD,
          {
            role: card!.role,
            col: [
              [t + 0.75, "red"],
              [t + 1.4, "amber"],
            ],
            lean: [t + 0.95],
            tags: [
              ["nack", t + 1.0, t + 1.4],
              [`try ${tries}`, t + 1.6, t + 2.0],
            ],
          }
        );
        out.note(t, `${card!.label} delivered`, "ink");
        out.note(t + 0.75, `${card!.label} failed`, "red");
        out.note(t + 1.1, "back to the front", "amber");
        out.note(t + 1.6, `redelivered · try ${tries}`, "amber");
        state.waiting.splice(i, 1);
        state.waiting.unshift(card!.id);
        return { duration: 1.9 };
      },
    },
    fail: {
      duration: 0.9,
      card: "required",
      description: "the job runs out of tries and goes to the dead-letter bin",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const i = take(ctx, t);
        if (i < 0) return { duration: 0.4 };
        out.end(card!.id, t);
        out.carry(
          [
            leg(
              [
                [470, Y],
                [470, 240],
                [470, 314],
              ],
              t,
              0.6
            ),
          ],
          t,
          t + 0.65,
          { role: "ink", col: [[t, "red"]], lean: [t] }
        );
        state.waiting.splice(i, 1);
        shift(ctx, i, t + 0.05);
        out.note(t, "→ dead letter", "red");
        return { exit: "dead", role: "red" as const, consumed: true };
      },
    },
  },
};
