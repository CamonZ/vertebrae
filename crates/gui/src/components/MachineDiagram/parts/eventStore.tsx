/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism helpers */
/**
 * event store · appends facts, never edits (catalogue "event store"): a tape
 * of event tiles with a head pointer and an append lane under it. A write
 * carries the version it expects; a stale expectation bounces. Ported from the
 * gallery line for line.
 */
import { PartBox } from "../fixtures";
import { slide, track } from "../motion";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import { Pointer, TL, Tiles, type TileSpec } from "./eventTiles";
import type { MachinePartDef, PartScenario } from "./types";

interface EventStoreExtra {
  readonly tl: readonly TileSpec[];
  /** The head pointer's tile index over time. */
  readonly head: readonly (readonly [number, number])[];
}

const X = (i: number) => 162 + 44 * i;
const LANE = 225;

function eventStoreStory(
  kind: "append" | "version conflict" | "read from v3"
): PartScenario<EventStoreExtra> {
  const s = story(4.6);
  s.gates.push(gateV(110, LANE), gateV(530, LANE));
  const tl: TileSpec[] = [];
  let head: [number, number][] = [[0, 3]];
  const base = (n: number) => {
    for (let i = 0; i < n; i++) tl.push(TL(X(i), 170, String(i + 1)));
  };
  const append = (a: number, i: number, tag: string) => {
    s.cards.push(
      card(
        28,
        "amber",
        [
          [
            [
              [24, LANE],
              [X(i), LANE],
              [X(i), 170],
            ],
            a,
            0.75,
          ],
        ],
        a,
        a + 0.85,
        { tags: [[tag, a + 0.05, a + 0.45]] }
      )
    );
    tl.push(
      TL(X(i), 170, String(i + 1), a + 0.8, [
        [a + 0.8, "ink"],
        [a + 1.6, "edge"],
      ])
    );
    head.push([a + 0.8, i]);
  };
  if (kind === "read from v3") {
    base(6);
    head = [[0, 5]];
    [2, 3, 4, 5].forEach((i, k) => {
      const a = 0.9 + 0.55 * k;
      tl[i].col.push([a - 0.1, "amber"], [a + 0.5, "edge"]);
      s.cards.push(
        card(
          18,
          "ink",
          [
            [
              [
                [X(i), 170],
                [X(i), LANE],
                [616, LANE],
              ],
              a,
              0.75,
            ],
          ],
          a,
          a + 0.8
        )
      );
    });
    note(s, 0.6, "read from v3", "ink");
    note(s, 3.25, "caught up · v6", "green");
    return {
      name: kind,
      still: 2.3,
      timeline: seal(s),
      extra: { tl, head },
    };
  }
  base(4);
  if (kind === "append") {
    append(0.6, 4, "expect v4");
    append(2.3, 5, "expect v5");
    note(s, 0.6, "append · expect v4", "ink");
    note(s, 1.4, "v5 written", "green");
    note(s, 2.3, "append · expect v5", "ink");
    note(s, 3.1, "v6 written", "green");
    return {
      name: kind,
      still: 1.55,
      timeline: seal(s),
      extra: { tl, head },
    };
  }
  append(0.6, 4, "A · expect v4");
  tl[4].col.push([2.75, "red"], [3.4, "edge"]);
  s.cards.push(
    card(
      28,
      "amber",
      [
        [
          [
            [24, LANE],
            [X(4), LANE],
          ],
          2.0,
          0.7,
        ],
        [
          [
            [X(4), LANE],
            [24, LANE],
          ],
          2.9,
          0.8,
        ],
      ],
      2.0,
      3.75,
      {
        col: [[2.75, "red"]],
        lean: [2.9],
        tags: [
          ["B · expect v4", 2.05, 2.5],
          ["head is v5", 3.0, 3.55],
        ],
      }
    )
  );
  note(s, 0.6, "A appends · expect v4", "ink");
  note(s, 1.4, "v5 written", "green");
  note(s, 2.0, "B appends · expect v4", "ink");
  note(s, 2.75, "conflict · head is v5", "red");
  return { name: kind, still: 3.2, timeline: seal(s), extra: { tl, head } };
}

export const eventStoreMachine: MachinePartDef<EventStoreExtra> = {
  part: {
    name: "event store",
    job: "appends facts, never edits",
    aka: "event log · stream · ledger · journal",
  },
  family: "event sourcing",
  footprint: "L",
  bb: [110, 110, 420, 150],
  status: { x: 320, y: 296 },
  scenarios: [
    eventStoreStory("append"),
    eventStoreStory("version conflict"),
    eventStoreStory("read from v3"),
  ],
  draw: (t, { tl, head }) => (
    <>
      <Rail
        points={[
          [24, LANE],
          [110, LANE],
        ]}
      />
      <Rail
        points={[
          [530, LANE],
          [616, LANE],
        ]}
      />
      <PartBox x={110} y={110} w={420} h={150} />
      <Rail
        points={[
          [130, LANE],
          [510, LANE],
        ]}
      />
      <Tiles list={tl} t={t} />
      <Pointer
        x={X(0) + 44 * track(head, t, slide)}
        y={150}
        role="ink"
        dir={-1}
        label="head"
      />
    </>
  ),
};
