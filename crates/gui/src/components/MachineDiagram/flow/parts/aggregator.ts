/**
 * aggregator · many in, one out (catalogue "aggregator"): a piston that
 * compresses the collected items into one card. Frame 240×190, footprint M;
 * in W, out E. Durations from the gallery "5 → 1" story: an item lands in
 * 0.5 s, the piston squeezes for 0.35 s, the summary leaves in 0.6 s.
 */
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 200,
    y: Y,
    direction: "in",
    tokens: ["data", "batch", "event"],
  },
  out: { side: "E", x: 440, y: Y, direction: "out", tokens: ["data"] },
} as const satisfies PartKindDef["ports"];

interface AggregatorState {
  items: string[];
  bad: number;
}

type Ctx = VerbContext<Record<string, unknown>, AggregatorState>;

function empty(ctx: Ctx, at: number) {
  for (const id of ctx.state.items) ctx.out.end(id, at);
  ctx.state.items = [];
  ctx.state.bad = 0;
}

export const aggregatorPart: PartKindDef<
  Record<string, unknown>,
  AggregatorState
> = {
  kind: "aggregator",
  job: "many in, one out",
  family: "compute",
  footprint: "M",
  bb: [200, 105, 240, 190],
  status: { x: 320, y: 328 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ items: [], bad: 0 }),
  verbs: {
    record: {
      duration: 0.5,
      card: "required",
      description: "collect one item",
      args: {
        bad: {
          type: "boolean",
          default: false,
          description: "the item will fail the reduce",
        },
      },
      compile({ t, card, out, state, args }) {
        const bad = args.bad === true;
        out.carry(
          [
            leg(
              [
                [200, Y],
                [236, Y],
              ],
              t,
              0.4
            ),
          ],
          t,
          HELD,
          { role: bad ? "red" : card!.role }
        );
        state.items.push(card!.id);
        if (bad) state.bad++;
        out.note(
          t + 0.4,
          state.items.length > 1 ? `${state.items.length} items` : "collecting",
          state.items.length > 1 ? "ink" : "dim"
        );
        return { consumed: true };
      },
    },
    reduce: {
      duration: 0.35,
      card: "none",
      description: "the piston compresses the items",
      compile(ctx) {
        ctx.out.note(ctx.t, "compacting", "dim");
        if (ctx.state.bad > 0) {
          ctx.out.note(ctx.t + 0.35, "failed · bad item", "red");
        }
        for (const id of ctx.state.items) ctx.out.end(id, ctx.t + 0.3);
      },
    },
    flush: {
      duration: 0.65,
      card: "optional",
      description: "the one summary card leaves",
      compile(ctx) {
        const { t, card, out, state } = ctx;
        const n = state.items.length;
        const bad = state.bad > 0;
        empty(ctx, t);
        if (card)
          out.carry(
            [
              leg(
                [
                  [340, Y],
                  [440, Y],
                ],
                t,
                0.4
              ),
            ],
            t,
            t + 0.5,
            {
              role: bad ? "red" : card.role,
              tags: [[bad ? "1 bad item" : `${n} → 1`, t + 0.05, t + 0.5]],
            }
          );
        out.note(
          t,
          bad ? "failed · bad item" : "one summary",
          bad ? "red" : "green"
        );
        if (!card) return {};
        return bad ? { role: "red" as const, consumed: true } : { exit: "out" };
      },
    },
    fail: {
      duration: 0.6,
      card: "none",
      args: { reason: { type: "string", default: "bad item" } },
      compile(ctx) {
        ctx.out.note(ctx.t, `failed · ${String(ctx.args.reason)}`, "red");
        empty(ctx, ctx.t + 0.3);
      },
    },
  },
};
