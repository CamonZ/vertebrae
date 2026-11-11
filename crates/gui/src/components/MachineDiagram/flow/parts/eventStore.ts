/**
 * event store · appends facts, never edits (catalogue "event store"): a tape
 * of event tiles with a head pointer. Frame 420×150, footprint L; commands
 * enter W, events read from a version leave E. Durations from the gallery
 * "append" story: a write travels the append lane and seats in 0.75 s; a
 * stale expectation bounces back in 0.8 s.
 */
import { card as makeCard } from "../../timeline";
import type { PartKindDef } from "../registry";
import { leg, sideGates } from "./common";

const LANE = 225;
const X = (i: number) => 162 + 44 * i;
const MAX = 8;

const ports = {
  in: {
    side: "W",
    x: 110,
    y: LANE,
    direction: "in",
    tokens: ["request", "data", "payload", "control"],
    description: "command (append, expected version)",
  },
  out: {
    side: "E",
    x: 530,
    y: LANE,
    direction: "out",
    tokens: ["event", "data", "result"],
    description: "event (read from a version)",
  },
} as const satisfies PartKindDef["ports"];

interface EventStoreProps {
  /** Events already written (the head is `v<events>`). */
  events: number;
}

export const eventStorePart: PartKindDef<EventStoreProps, { events: number }> =
  {
    kind: "event store",
    job: "appends facts, never edits",
    family: "event sourcing",
    footprint: "L",
    bb: [110, 110, 420, 150],
    status: { x: 320, y: 296 },
    props: { events: { type: "integer", min: 0, max: 7, default: 4 } },
    ports,
    gates: () => sideGates(ports),
    init: (p) => ({ events: Math.min(MAX - 1, p.events) }),
    verbs: {
      append: {
        duration: 1.7,
        card: "required",
        tokens: ["request", "data", "payload", "control"],
        description: "write one event at the head, expecting the head version",
        compile({ t, card, out, state }) {
          const i = Math.min(state.events, MAX - 1);
          out.note(t, `append · expect v${state.events}`, "ink");
          out.carry(
            [
              leg(
                [
                  [110, LANE],
                  [X(i), LANE],
                  [X(i), 170],
                ],
                t,
                0.75
              ),
            ],
            t,
            t + 0.85,
            {
              role: card!.role,
              tags: [[`expect v${state.events}`, t + 0.05, t + 0.45]],
            }
          );
          state.events++;
          out.note(t + 0.8, `v${state.events} written`, "green");
          return { consumed: true };
        },
      },
      fail: {
        duration: 1.9,
        card: "required",
        tokens: ["request", "data", "payload", "control"],
        description:
          "a writer expecting a stale version: it bounces back and nothing is written",
        args: {
          expect: {
            type: "integer",
            min: 0,
            description:
              "the version the writer expected (default: one behind)",
          },
        },
        compile({ t, card, out, state, args }) {
          const i = Math.min(state.events, MAX - 1);
          const expect = Number(args.expect ?? Math.max(0, state.events - 1));
          out.note(t, `append · expect v${expect}`, "ink");
          out.carry(
            [
              leg(
                [
                  [110, LANE],
                  [X(i), LANE],
                ],
                t,
                0.7
              ),
              leg(
                [
                  [X(i), LANE],
                  [110, LANE],
                ],
                t + 0.9,
                0.8
              ),
            ],
            t,
            t + 1.75,
            {
              role: card!.role,
              col: [[t + 0.75, "red"]],
              lean: [t + 0.9],
              tags: [
                [`expect v${expect}`, t + 0.05, t + 0.5],
                [`head is v${state.events}`, t + 1.0, t + 1.55],
              ],
            }
          );
          out.note(t + 0.75, `conflict · head is v${state.events}`, "red");
          return { role: "red", consumed: true };
        },
      },
      read: {
        duration: 1.2,
        card: "none",
        description: "read the events from a version to the head; they leave E",
        args: { from: { type: "integer", min: 1, default: 1 } },
        compile({ t, out, state, args }) {
          const from = Math.max(1, Number(args.from));
          out.note(t, `read from v${from}`, "ink");
          const n = Math.max(0, state.events - from + 1);
          for (let k = 0; k < n; k++) {
            const i = Math.min(from - 1 + k, MAX - 1);
            const a = t + 0.3 + 0.55 * k;
            out.card(
              makeCard(
                18,
                "ink",
                [
                  leg(
                    [
                      [X(i), 170],
                      [X(i), LANE],
                      [530, LANE],
                    ],
                    a,
                    0.75
                  ),
                ],
                a,
                a + 0.8
              )
            );
          }
          const end = t + 0.3 + 0.55 * n + 0.5;
          out.note(end, `caught up · v${state.events}`, "green");
          return { duration: end - t + 0.2 };
        },
      },
    },
  };
