/**
 * replay · rebuilds state from the first fact (catalogue "replay"): payload
 * tiles, a playhead and a balance bar. Frame 480×190, footprint L; no ports.
 * Durations from the gallery "to now" story: the playhead folds one event
 * every 0.55 s.
 */
import type { PartKindDef } from "../registry";

/** The event payloads on the tape and the balance after each. */
const AMOUNTS = [50, -30, 50, 10, -20] as const;
const BALANCE = AMOUNTS.reduce<number[]>(
  (acc, v) => [...acc, (acc.at(-1) ?? 0) + v],
  []
);

interface ReplayState {
  /** Events folded so far. */
  pos: number;
}

export const replayPart: PartKindDef<Record<string, unknown>, ReplayState> = {
  kind: "replay",
  job: "rebuilds state from the first fact",
  family: "event sourcing",
  footprint: "L",
  bb: [80, 110, 480, 190],
  status: { x: 320, y: 332 },
  ports: {},
  init: () => ({ pos: 0 }),
  verbs: {
    replay: {
      duration: 3.8,
      card: "none",
      description:
        "fold the events from the first one up to now, or up to a version (an as-of read)",
      args: { upTo: { type: "integer", min: 1, max: 5, default: 5 } },
      compile({ t, out, state, args }) {
        const n = Number(args.upTo);
        const asof = n < AMOUNTS.length;
        out.note(t, asof ? `replay up to v${n}` : "replaying from v1", "dim");
        state.pos = n;
        const end = t + 0.9 + 0.55 * n;
        out.note(
          end,
          asof
            ? `as of v${n} · balance ${BALANCE[n - 1]}`
            : `rebuilt · balance ${BALANCE[n - 1]}`,
          asof ? "ink" : "green"
        );
        return { duration: end - t + 0.6 };
      },
    },
    fold: {
      duration: 0.6,
      card: "none",
      description: "fold the next event into the balance",
      compile({ t, out, state }) {
        if (state.pos >= AMOUNTS.length) {
          out.note(t, "nothing left to fold", "dim");
          return { duration: 0.4 };
        }
        state.pos++;
        out.note(t, `v${state.pos} · balance ${BALANCE[state.pos - 1]}`, "ink");
      },
    },
    fail: {
      duration: 3.2,
      card: "none",
      description:
        "a handler changed since the events were written: the replayed value differs from the stored one",
      compile({ t, out, state }) {
        out.note(t, "replaying from v1", "dim");
        out.note(t + 1.1, "v3 handler changed", "amber");
        state.pos = AMOUNTS.length;
        out.note(t + 2.4, "replayed 55 ≠ stored 60", "red");
        return { role: "red", duration: 3.2 };
      },
    },
  },
};
