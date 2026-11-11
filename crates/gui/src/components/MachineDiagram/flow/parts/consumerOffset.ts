/**
 * consumer offset · remembers how far it read (catalogue "consumer offset"): a
 * tape of log tiles coloured by processed / committed, a read pointer and a
 * consumer. Frame 440×200, footprint L; no ports. Durations from the gallery
 * "commit after process" story: a read crosses to the consumer in 0.45 s, the
 * processing ring takes 0.25 s and a commit sweeps the tiles at 0.05 s each.
 */
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";

const X = (i: number) => 130 + 48 * i;
const CN = [320, 270] as const;
const TILES = 8;

interface ConsumerOffsetProps {
  /** Events already processed and committed (the committed line is `#<committed>`). */
  committed: number;
}

interface ConsumerOffsetState {
  /** Events read so far (the pointer's position). */
  read: number;
  processed: number;
  committed: number;
}

export const consumerOffsetPart: PartKindDef<
  ConsumerOffsetProps,
  ConsumerOffsetState
> = {
  kind: "consumer offset",
  job: "remembers how far it read",
  family: "event sourcing",
  footprint: "L",
  bb: [100, 105, 440, 200],
  status: { x: 320, y: 340 },
  props: { committed: { type: "integer", min: 0, max: 7, default: 3 } },
  ports: {},
  init: (p) => ({
    read: p.committed,
    processed: p.committed,
    committed: p.committed,
  }),
  verbs: {
    read: {
      duration: 0.9,
      card: "none",
      description: "read the next event from the log; the pointer moves on",
      compile({ t, out, state }) {
        if (state.read >= TILES) {
          out.note(t, "end of log", "dim");
          return { duration: 0.4 };
        }
        const i = state.read++;
        out.card(
          dot(
            [
              [X(i), 156],
              [CN[0], CN[1]],
            ],
            t,
            0.45,
            "ink",
            { dies: t + 0.75 }
          )
        );
        out.note(t, `read #${i + 1}`, "dim");
      },
    },
    process: {
      duration: 0.5,
      card: "none",
      description: "the consumer handles the event it just read",
      compile({ t, out, state }) {
        if (state.processed >= state.read) {
          out.note(t, "nothing to process", "dim");
          return { duration: 0.3 };
        }
        state.processed = state.read;
        out.note(t, `processed #${state.processed}`, "ink");
      },
    },
    commit: {
      duration: 0.9,
      card: "none",
      description:
        "store the offset: every event up to it counts as done, even one not yet processed",
      args: {
        upTo: {
          type: "integer",
          min: 1,
          max: TILES,
          description: "the offset to commit (default: how far it has read)",
        },
      },
      compile({ t, out, state, args }) {
        const n = Math.min(TILES, Number(args.upTo ?? Math.max(state.read, 1)));
        const early = n > state.processed;
        state.committed = Math.max(state.committed, n);
        if (early) state.read = Math.max(state.read, n);
        out.marker({ t, kind: "checkpoint", label: `#${n}` });
        out.note(
          t,
          early ? `commit #${n} first` : `commit #${n}`,
          early ? "amber" : "green"
        );
      },
    },
    fail: {
      duration: 1.8,
      card: "none",
      description:
        "the consumer crashes and restarts from the committed offset: events read after it are read again (or, if committed early, never processed)",
      compile({ t, out, state }) {
        const lost = state.committed > state.processed;
        out.note(
          t,
          lost
            ? "crashed mid event"
            : `crashed · committed #${state.committed}`,
          "red"
        );
        state.read = state.committed;
        out.note(
          t + 0.7,
          lost
            ? `restart after #${state.committed}`
            : `restart from #${state.committed + 1}`,
          "amber"
        );
        if (lost) {
          out.note(
            t + 1.4,
            `#${state.processed + 1} #${state.committed} never processed`,
            "red"
          );
          state.processed = state.committed;
        }
        return { role: "red" };
      },
    },
  },
};
