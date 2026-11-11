/**
 * pool · a fixed number of seats (catalogue "pool"): seat rings, one per
 * occupancy slot; a job takes a seat, a late job waits outside for one.
 * Ported from the gallery line for line.
 */
import { Hole, PartBox, Ring } from "../fixtures";
import type { CardRole } from "../palette";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { card, gateV, note, seal, story, type StoryDraft } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

type SeatRing = readonly [number, number, number, CardRole];

interface PoolExtra {
  readonly seats?: readonly number[];
  /** `[seatX, from, to, result]` seat rings. */
  readonly rings: readonly SeatRing[];
  /** The waiter's give-up ring outside the pool. */
  readonly wait: readonly [number, number] | null;
}

const SEATS = [230, 320, 410] as const;
const SEAT_Y = 190;
const enter = (x: number): Point[] => [
  [24, 140],
  [150, 140],
  [x - 30, 140],
  [x, SEAT_Y],
];
const leave = (x: number): Point[] => [
  [x, SEAT_Y],
  [x, 245],
  [490, 245],
  [616, 245],
];

function job(
  s: StoryDraft,
  rings: SeatRing[],
  a: number,
  x: number,
  end: number,
  role: CardRole,
  tag: string
) {
  s.cards.push(
    card(
      28,
      "ink",
      [
        [enter(x), a, 0.7],
        [leave(x), end, 0.7],
      ],
      a,
      end + 0.75,
      {
        col: [[end - 0.12, role]],
        lean: [end],
        tags: [[tag, a + 0.05, a + 0.45]],
      }
    )
  );
  rings.push([x, a + 0.7, end, role]);
}

function poolStory(
  kind: "seat freed" | "job fails" | "waiter gives up"
): PartScenario<PoolExtra> {
  const s = story(5.4);
  s.gates.push(gateV(150, 140), gateV(490, 245));
  const rings: SeatRing[] = [];
  if (kind === "waiter gives up") {
    job(s, rings, 0.6, SEATS[0], 3.6, "green", "job 1");
    job(s, rings, 0.9, SEATS[1], 3.9, "green", "job 2");
    job(s, rings, 1.2, SEATS[2], 4.2, "green", "job 3");
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, 140],
              [118, 140],
            ],
            1.5,
            0.5,
          ],
          [
            [
              [118, 140],
              [24, 140],
            ],
            3.1,
            0.6,
          ],
        ],
        1.5,
        3.75,
        {
          col: [
            [1.9, "amber"],
            [2.98, "red"],
          ],
          lean: [3.1],
          tags: [
            ["waiting for a seat", 1.9, 3.0],
            ["gave up", 3.2, 3.7],
          ],
        }
      )
    );
    note(s, 0.6, "1 of 3 busy", "ink");
    note(s, 1.2, "3 of 3 busy", "amber");
    note(s, 1.9, "queue · 1 waiting", "amber");
    note(s, 3.1, "waiter gave up", "red");
    note(s, 3.65, "seat freed · too late", "dim");
    note(s, 4.95, "0 of 3 busy", "dim");
    return {
      name: kind,
      still: 3.35,
      timeline: seal(s),
      extra: { rings, wait: [1.9, 3.1] },
    };
  }
  const f = kind === "job fails";
  job(s, rings, 0.6, SEATS[0], 2.2, "green", "job 1");
  job(s, rings, 0.9, SEATS[1], 2.8, f ? "red" : "green", "job 2");
  job(s, rings, 1.2, SEATS[2], 3.3, "green", "job 3");
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, 140],
            [118, 140],
          ],
          1.5,
          0.5,
        ],
        [enter(SEATS[0]), 2.45, 0.7],
        [leave(SEATS[0]), 4.2, 0.7],
      ],
      1.5,
      4.95,
      {
        col: [
          [1.9, "amber"],
          [2.45, "ink"],
          [4.08, "green"],
        ],
        lean: [4.2],
        tags: [["waiting for a seat", 1.9, 2.5]],
      }
    )
  );
  rings.push([SEATS[0], 3.15, 4.2, "green"]);
  note(s, 0.6, "1 of 3 busy", "ink");
  note(s, 1.2, "3 of 3 busy", "amber");
  note(s, 1.9, "queue · 1 waiting", "amber");
  note(s, 2.45, "seat freed", "ink");
  if (f) note(s, 2.8, "job 2 failed", "red");
  note(s, 4.95, "0 of 3 busy", "dim");
  return {
    name: kind,
    still: 2.25,
    timeline: seal(s),
    extra: { rings, wait: null },
  };
}

export const poolMachine: MachinePartDef<PoolExtra> = {
  part: {
    name: "pool",
    job: "a fixed number of seats",
    aka: "worker pool · connection pool · semaphore",
  },
  family: "compute",
  footprint: "L",
  bb: [150, 112, 340, 160],
  status: { x: 320, y: 304 },
  scenarios: [
    poolStory("seat freed"),
    poolStory("job fails"),
    poolStory("waiter gives up"),
  ],
  draw: (t, { rings, wait, seats = SEATS }) => (
    <>
      <Rail
        points={[
          [24, 140],
          [150, 140],
        ]}
      />
      <Rail
        points={[
          [490, 245],
          [616, 245],
        ]}
      />
      <PartBox x={150} y={112} w={340} h={160} />
      {seats.map((x) => (
        <Hole key={x} x={x} y={SEAT_Y} />
      ))}
      {rings.map(([x, from, to, result], i) => (
        <Ring
          key={i}
          x={x}
          y={SEAT_Y}
          t={t}
          from={from}
          to={to}
          result={result}
        />
      ))}
      {wait && (
        <Ring
          x={118}
          y={140}
          t={t}
          from={wait[0]}
          to={wait[1]}
          result="red"
          r={22}
        />
      )}
    </>
  ),
};
