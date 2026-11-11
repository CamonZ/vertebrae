/**
 * snapshot · skips the replay (catalogue "snapshot"): a tape of event tiles, a
 * snapshot bracket and a state hole. Frame 440×215, footprint L; no ports,
 * the snapshot tile and the event tail move inside. Durations from the
 * gallery "snapshot + tail" story: the snapshot reaches the hole in 0.6 s and
 * each tail event follows in 0.5 s.
 */
import { card as makeCard, dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { leg } from "./common";

const X = (i: number) => 146 + 44 * i;
const HOLE = [320, 262] as const;
const MAX = 8;

interface SnapshotProps {
  /** Events on the tape (at most 8). */
  events: number;
  /** The last snapshot covers this many events (0 = none). */
  snapshot: number;
}

interface SnapshotState {
  events: number;
  snapshot: number;
}

/** The snapshot tile leaves its bracket for the state hole. */
function load(t: number, n: number) {
  const mid = (128 + X(n - 1) + 18) / 2;
  return makeCard(
    28,
    "ink",
    [
      leg(
        [
          [mid, 168],
          [HOLE[0], HOLE[1]],
        ],
        t,
        0.6
      ),
    ],
    t,
    t + 0.65
  );
}

export const snapshotPart: PartKindDef<SnapshotProps, SnapshotState> = {
  kind: "snapshot",
  job: "skips the replay",
  family: "event sourcing",
  footprint: "L",
  bb: [100, 95, 440, 215],
  status: { x: 320, y: 340 },
  props: {
    events: { type: "integer", min: 1, max: MAX, default: 8 },
    snapshot: { type: "integer", min: 0, max: MAX, default: 6 },
  },
  ports: {},
  init: (p) => ({
    events: Math.min(MAX, p.events),
    snapshot: Math.min(p.snapshot, p.events),
  }),
  verbs: {
    read: {
      duration: 2.6,
      card: "none",
      description:
        "load the snapshot and fold only the events after it into the state",
      compile({ t, out, state }) {
        if (state.snapshot === 0) {
          out.note(t, "no snapshot", "dim");
          return { duration: 0.5 };
        }
        const tail = state.events - state.snapshot;
        out.note(t, `load snapshot v${state.snapshot}`, "ink");
        out.card(load(t, state.snapshot));
        for (let k = 0; k < tail; k++) {
          const a = t + 0.8 + 0.5 * k;
          out.card(
            dot(
              [
                [X(state.snapshot + k), 150],
                [HOLE[0], HOLE[1]],
              ],
              a,
              0.5
            )
          );
        }
        out.note(t + 0.8, `+ ${tail} events`, "dim");
        const end = t + 0.9 + 0.5 * tail;
        out.note(
          end,
          `state at v${state.events} · read ${tail}, not ${state.events}`,
          "green"
        );
        return { duration: end - t + 0.6 };
      },
    },
    replay: {
      duration: 4,
      card: "none",
      description:
        "fold every event from the first one (no snapshot to skip with)",
      compile({ t, out, state }) {
        out.note(t, `full replay · ${state.events} events`, "amber");
        for (let i = 0; i < state.events; i++) {
          const a = t + 0.3 + 0.3 * i;
          out.card(
            dot(
              [
                [X(i), 150],
                [HOLE[0], HOLE[1]],
              ],
              a,
              0.45
            )
          );
        }
        const end = t + 0.3 + 0.3 * state.events + 0.5;
        out.note(end, `state at v${state.events} · slow path`, "ink");
        return { duration: end - t + 0.5 };
      },
    },
    snapshot: {
      duration: 2.4,
      card: "none",
      description: "save the state as a snapshot covering every event so far",
      compile({ t, out, state }) {
        const since = state.events - state.snapshot;
        out.note(t, `${since} since snapshot · take one`, "amber");
        out.card(
          makeCard(
            28,
            "ink",
            [
              leg(
                [
                  [HOLE[0], HOLE[1]],
                  [300, 172],
                ],
                t + 0.5,
                0.5
              ),
            ],
            t + 0.5,
            t + 1.05
          )
        );
        state.snapshot = state.events;
        out.marker({
          t: t + 1.05,
          kind: "checkpoint",
          label: `v${state.events}`,
        });
        out.note(t + 1.05, `snapshot v${state.events} saved`, "green");
        return { duration: 2.0 };
      },
    },
    fail: {
      duration: 1.8,
      card: "none",
      description:
        "the snapshot is unreadable: it is dropped and the next read replays everything",
      compile({ t, out, state }) {
        out.note(t, `load snapshot v${state.snapshot}`, "ink");
        out.card(
          makeCard(
            28,
            "ink",
            [
              leg(
                [
                  [(128 + X(Math.max(1, state.snapshot) - 1) + 18) / 2, 168],
                  [HOLE[0], HOLE[1]],
                ],
                t,
                0.6
              ),
            ],
            t,
            t + 0.65,
            { col: [[t + 0.5, "red"]] }
          )
        );
        state.snapshot = 0;
        out.note(t + 0.65, "snapshot unreadable", "red");
        return { role: "red" };
      },
    },
  },
};
