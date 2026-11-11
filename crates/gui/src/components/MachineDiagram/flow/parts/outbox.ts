/**
 * outbox · saves and publishes together (catalogue "outbox"): one transaction
 * frame (state + outbox row), a relay and a broker. Frame 250×190, footprint
 * M; commands enter W, the relayed event leaves E. Durations from the gallery
 * "relayed" story: the command seats in 0.55 s, the relay picks the message
 * up in 0.55 s, the broker takes it 1.05 s later.
 */
import { card as makeCard } from "../../timeline";
import type { PartKindDef, VerbContext } from "../registry";
import { leg, sideGates } from "./common";

const TB = [262, 225] as const;
const R = [440, 225] as const;

const ports = {
  in: {
    side: "W",
    x: 130,
    y: 165,
    direction: "in",
    tokens: ["request", "control", "data"],
    description: "command",
  },
  out: {
    side: "E",
    x: 380,
    y: 225,
    direction: "out",
    tokens: ["event"],
    description: "event (relay to broker)",
  },
} as const satisfies PartKindDef["ports"];

interface OutboxState {
  next: number;
  /** Outbox rows not yet marked published. */
  pending: number[];
  published: number[];
}

type Ctx = VerbContext<Record<string, unknown>, OutboxState>;

/** The relay carries the oldest pending message to the broker (or fails). */
function send(ctx: Ctx, ok: boolean): number {
  const { t, out, state } = ctx;
  const n = state.pending[0];
  if (n === undefined) {
    out.note(t, "nothing to relay", "dim");
    return 0.5;
  }
  out.note(t, `relay picks up m${n}`, "dim");
  const a = t + 0.5;
  out.card(
    makeCard(
      28,
      "amber",
      [
        leg([[...TB], [...R]], a, 0.55),
        ok
          ? leg([[...R], [560, 225]], a + 1.05, 0.45)
          : leg([[...R], [...TB]], a + 1.05, 0.55),
      ],
      a,
      ok ? a + 1.55 : a + 1.65,
      {
        col: ok ? [] : [[a + 0.88, "red"]],
        lean: [a + 1.05],
        tags: [[`m${n}`, a + 0.05, a + 0.45]],
      }
    )
  );
  if (ok) state.published.push(n);
  return 2.3;
}

export const outboxPart: PartKindDef<Record<string, unknown>, OutboxState> = {
  kind: "outbox",
  job: "saves and publishes together",
  family: "event sourcing",
  footprint: "M",
  bb: [130, 105, 250, 190],
  status: { x: 365, y: 332 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ next: 1, pending: [], published: [] }),
  verbs: {
    record: {
      duration: 0.8,
      card: "required",
      tokens: ["request", "control", "data"],
      description: "the command arrives and is handled inside one transaction",
      compile({ t, card, out }) {
        out.note(t, "command", "ink");
        out.carry(
          [
            leg(
              [
                [130, 165],
                [230, 165],
              ],
              t,
              0.55
            ),
          ],
          t,
          t + 0.7,
          { role: card!.role, tags: [[card!.label, t + 0.05, t + 0.4]] }
        );
        return { consumed: true };
      },
    },
    commit: {
      duration: 1.0,
      card: "none",
      description: "state and the outbox row are written together",
      compile({ t, out, state }) {
        state.pending.push(state.next++);
        out.note(t, "commit · state + outbox row", "green");
      },
    },
    publish: {
      duration: 2.4,
      card: "none",
      description:
        "the relay sends the pending message to the broker and marks the row; `marked: false` is a relay that crashes first",
      args: { marked: { type: "boolean", default: true } },
      compile(ctx) {
        const { t, out, state, args } = ctx;
        const n = state.pending[0];
        const d = send(ctx, true);
        if (n === undefined) return { duration: d };
        if (args.marked === false) {
          out.note(t + 2.05, "published", "ink");
          out.note(t + 2.25, "relay crashed before marking", "red");
          return { duration: d, role: "red" };
        }
        state.pending.shift();
        out.note(t + 2.05, "published · row marked", "green");
        return { duration: d };
      },
    },
    retry: {
      duration: 2.8,
      card: "none",
      description:
        "the relay restarts and sends the message that is still pending again",
      compile(ctx) {
        const { t, out, state } = ctx;
        const n = state.pending[0];
        if (n === undefined) {
          out.note(t, "nothing to relay", "dim");
          return { duration: 0.5 };
        }
        out.note(t, `restart · m${n} still pending`, "amber");
        const again = state.published.includes(n);
        const sub = { ...ctx, t: t + 0.6 };
        const d = send(sub, true);
        state.pending.shift();
        out.note(
          t + 0.6 + 0.5 + 1.55,
          again ? `m${n} published twice` : "published · row marked",
          again ? "amber" : "green"
        );
        return { duration: d + 0.6 };
      },
    },
    fail: {
      duration: 2.4,
      card: "none",
      description:
        "the broker is down: the message comes back, stays in the outbox and will be retried",
      compile(ctx) {
        const { t, out, state } = ctx;
        const n = state.pending[0];
        const d = send(ctx, false);
        if (n === undefined) return { duration: d };
        out.note(t + 1.5, "broker down", "red");
        out.note(t + 2.2, `m${n} kept · will retry`, "amber");
        return { duration: d + 0.3, role: "red" };
      },
    },
  },
};
