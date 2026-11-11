/**
 * transaction · all of it or none (catalogue "transaction"): a staged zone
 * and a committed zone; a rollback empties the staged zone. Frame 240×226,
 * footprint M; writes enter W. Durations from the gallery "commit" story:
 * each write seats in 0.6 s, a commit drops every staged write into the
 * committed zone in 0.35 s, a rollback sends them back in 0.7 s.
 */
import { card as makeCard } from "../../timeline";
import { HELD, type PartKindDef, type VerbContext } from "../registry";
import { leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 200,
    y: 145,
    direction: "in",
    tokens: ["data", "request", "payload"],
    description: "staged writes",
  },
} as const satisfies PartKindDef["ports"];

const SLOTS = [270, 320, 370] as const;

interface TxState {
  /** Staged writes: card id, and the slot it sits in. */
  staged: { id: string; x: number }[];
  /** A commit lost to another writer, so the next commit is a retry. */
  conflicted: boolean;
}

type Ctx = VerbContext<Record<string, unknown>, TxState>;

/** Move every staged write to `to(x)`, `step` seconds apart, and end it there. */
function sendStaged(ctx: Ctx, t: number, d: number, down: boolean) {
  const { out, state } = ctx;
  state.staged.forEach(({ id, x }, i) => {
    const at = t + (down ? 0.05 : 0.1) * i;
    out.end(id, at);
    out.card(
      makeCard(
        28,
        down ? "amber" : "red",
        [
          leg(
            down
              ? [
                  [x, 145],
                  [x, 250],
                ]
              : [
                  [x, 145],
                  [200, 145],
                ],
            at,
            d
          ),
        ],
        at,
        at + d + 0.05,
        { id, lean: down ? [] : [at] }
      )
    );
  });
  state.staged = [];
}

export const transactionPart: PartKindDef<Record<string, unknown>, TxState> = {
  kind: "transaction",
  job: "all of it or none",
  family: "data and state",
  footprint: "M",
  bb: [200, 92, 240, 226],
  status: { x: 320, y: 350 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ staged: [], conflicted: false }),
  verbs: {
    stage: {
      duration: 0.9,
      card: "required",
      tokens: ["data", "request", "payload"],
      description: "a write is staged; nothing is written until the commit",
      compile({ t, card, out, state }) {
        const i = state.staged.length;
        const x = SLOTS[Math.min(i, SLOTS.length - 1)];
        if (i === 0) out.note(t, "begin", "ink");
        out.carry(
          [
            leg(
              [
                [200, 145],
                [x, 145],
              ],
              t,
              0.6
            ),
          ],
          t,
          HELD,
          {
            role: card!.role,
            tags: [[`write ${i + 1}`, t + 0.05, t + 0.4]],
          }
        );
        state.staged.push({ id: card!.id, x });
        out.note(t + 0.6, `${state.staged.length} writes staged`, "amber");
      },
    },
    commit: {
      duration: 0.9,
      card: "none",
      description:
        "every staged write lands together; another writer's conflict leaves them staged for a retry",
      args: {
        outcome: { type: "string", enum: ["ok", "conflict"], default: "ok" },
      },
      compile(ctx) {
        const { t, out, state, args } = ctx;
        const n = state.staged.length;
        if (n === 0) {
          out.note(t, "nothing staged", "dim");
          return { duration: 0.4 };
        }
        if (args.outcome === "conflict") {
          state.conflicted = true;
          out.note(t, "conflict · another writer", "red");
          return { duration: 0.6 };
        }
        if (state.conflicted) out.note(t, "retrying commit", "amber");
        state.conflicted = false;
        sendStaged(ctx, t + 0.1, 0.35, true);
        out.marker({ t: t + 0.1, kind: "checkpoint", label: `${n} rows` });
        out.note(t + 0.1, `commit · ${n} rows`, "green");
      },
    },
    rollback: {
      duration: 1.0,
      card: "none",
      description: "every staged write is thrown away and nothing is written",
      compile(ctx) {
        const { t, out, state } = ctx;
        if (state.staged.length === 0) {
          out.note(t, "nothing staged", "dim");
          return { duration: 0.4 };
        }
        state.conflicted = false;
        sendStaged(ctx, t + 0.1, 0.7, false);
        out.note(t + 0.1, "rollback · nothing written", "red");
      },
    },
  },
};
