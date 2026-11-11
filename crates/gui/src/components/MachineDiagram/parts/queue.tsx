/* eslint-disable react-refresh/only-export-components -- part definitions sit beside their renderer */
/**
 * queue · first in, first out (catalogue "queue"): a long low box with slots,
 * a consumer box and a dead-letter bin. Ported from the gallery artifact
 * (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { Lamp, PartBox } from "../fixtures";
import { pop } from "../motion";
import type { CardRole } from "../palette";
import { RAIL_Y as Y } from "../MachinePart";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { SvgText } from "../SvgText";
import {
  card,
  gateH,
  gateV,
  note,
  seal,
  story,
  type LegInput,
  type StoryDraft,
} from "../timeline";
import { Outline } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface QueueExtra {
  /** Slots drawn. */
  readonly cap: number;
  /** Consumer deliveries `[t, role]` (lamp colour); null draws no consumer box. */
  readonly cons: readonly (readonly [number, CardRole])[] | null;
  readonly dlq: boolean;
}

const slot = (i: number): Point => [470 - i * 40, Y];
const IN = (i: number): Point[] => [[24, Y], slot(i)];
const CONSUMER: Point = [587, Y];

function fifoStory(failed: boolean): PartScenario<QueueExtra> {
  const s = story(6.6);
  const cap = failed ? 4 : 5;
  const arr = [0.6, 0.9, 1.2, 1.5, 1.8];
  const dep = [2.4, 3.2, 4.0, 4.8, 5.6];
  s.gates.push(gateV(130, Y), gateV(510, Y));
  const ev: [number, number][] = [
    ...arr.map((a): [number, number] => [a, 0]),
    ...dep.map((d): [number, number] => [d, 1]),
  ].sort((a, b) => a[0] - b[0]);
  arr.forEach((a, i) => {
    if (i >= cap) {
      s.cards.push(
        card(
          28,
          "ink",
          [
            [
              [
                [24, Y],
                [118, Y],
              ],
              a,
              0.4,
            ],
            [
              [
                [118, Y],
                [24, Y],
              ],
              a + 0.6,
              0.5,
            ],
          ],
          a,
          a + 1.1,
          {
            col: [[a + 0.45, "red"]],
            lean: [a + 0.6],
            tags: [["full", a + 0.5, a + 1.0]],
          }
        )
      );
      return;
    }
    const legs: LegInput[] = [];
    let idx: number | null = null;
    for (const [e] of ev) {
      if (e < a) continue;
      const present = arr.map((x, j) => j < cap && x <= e && dep[j] > e);
      if (!present[i]) {
        if (e >= dep[i]) {
          legs.push([[slot(0), [616, Y]], dep[i], 0.6]);
          break;
        }
        continue;
      }
      const n = present.slice(0, i).filter(Boolean).length;
      if (idx === null) legs.push([IN(n), a, 0.6]);
      else if (n !== idx) legs.push([[slot(idx), slot(n)], e + 0.05, 0.35]);
      idx = n;
    }
    s.cards.push(
      card(28, "ink", legs, a, dep[i] + 0.62, {
        tags: [[`job ${i + 1}`, a + 0.05, a + 0.4]],
      })
    );
  });
  const waiting = (e: number) =>
    arr.filter((x, j) => j < cap && x <= e && dep[j] > e).length;
  for (const [e] of ev) {
    const n = waiting(e);
    note(s, e + 0.01, `${n} waiting`, n ? "ink" : "dim");
  }
  if (failed) note(s, 1.85, "full · job 5 rejected", "red");
  return {
    name: failed ? "full" : "drains",
    still: 2.1,
    timeline: seal(s),
    extra: { cap, cons: null, dlq: false },
  };
}

function retryStory(dead: boolean): PartScenario<QueueExtra> {
  const s: StoryDraft = story(dead ? 8.0 : 6.6);
  const cons: [number, CardRole][] = [];
  s.gates.push(gateV(130, Y), gateV(510, Y), gateV(554, Y));
  if (!dead) {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [IN(0), 0.6, 0.6],
          [[slot(0), CONSUMER], 2.0, 0.6],
          [[CONSUMER, slot(0)], 2.95, 0.6],
          [[slot(0), CONSUMER], 3.9, 0.6],
        ],
        0.6,
        4.75,
        {
          col: [
            [2.75, "red"],
            [3.4, "amber"],
            [4.4, "green"],
          ],
          lean: [2.95],
          tags: [
            ["job 1", 0.65, 1.0],
            ["nack", 3.0, 3.4],
            ["try 2", 3.95, 4.4],
          ],
        }
      )
    );
    cons.push([2.75, "red"], [4.5, "green"]);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [IN(1), 0.9, 0.6],
          [[slot(1), slot(0)], 4.6, 0.35],
          [[slot(0), CONSUMER], 5.1, 0.6],
        ],
        0.9,
        5.75,
        { tags: [["job 2", 0.95, 1.3]] }
      )
    );
    cons.push([5.7, "green"]);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [IN(2), 1.2, 0.6],
          [[slot(2), slot(1)], 4.65, 0.35],
        ],
        1.2,
        9,
        { tags: [["job 3", 1.25, 1.6]] }
      )
    );
    note(s, 0.6, "1 waiting", "ink");
    note(s, 1.2, "3 waiting", "ink");
    note(s, 2.0, "job 1 delivered", "ink");
    note(s, 2.75, "job 1 failed", "red");
    note(s, 3.1, "back to the front", "amber");
    note(s, 3.9, "redelivered · try 2", "amber");
    note(s, 4.5, "job 1 done", "green");
    return {
      name: "redelivered",
      still: 3.45,
      timeline: seal(s),
      extra: { cap: 5, cons, dlq: false },
    };
  }
  s.gates.push(gateH(470, 240), gateH(470, 290));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [IN(0), 0.6, 0.6],
        [[slot(0), CONSUMER], 1.6, 0.6],
        [[CONSUMER, slot(0)], 2.5, 0.6],
        [[slot(0), CONSUMER], 3.5, 0.6],
        [[CONSUMER, slot(0)], 4.4, 0.6],
        [[slot(0), [470, 314]], 5.4, 0.6],
      ],
      0.6,
      9,
      {
        col: [
          [2.25, "red"],
          [3.1, "amber"],
          [4.15, "red"],
        ],
        lean: [2.5, 4.4, 5.4],
        tags: [
          ["job 1", 0.65, 1.0],
          ["fail 1", 2.55, 3.0],
          ["fail 2", 4.45, 4.9],
        ],
      }
    )
  );
  cons.push([2.25, "red"], [4.15, "red"]);
  s.cards.push(
    card(
      28,
      "ink",
      [
        [IN(1), 0.9, 0.6],
        [[slot(1), slot(0)], 5.5, 0.35],
        [[slot(0), CONSUMER], 6.0, 0.6],
      ],
      0.9,
      6.75,
      { tags: [["job 2", 0.95, 1.3]] }
    )
  );
  cons.push([6.65, "green"]);
  s.cards.push(
    card(
      28,
      "ink",
      [
        [IN(2), 1.2, 0.6],
        [[slot(2), slot(1)], 5.55, 0.35],
      ],
      1.2,
      9,
      { tags: [["job 3", 1.25, 1.6]] }
    )
  );
  note(s, 0.6, "1 waiting", "ink");
  note(s, 1.2, "3 waiting", "ink");
  note(s, 1.6, "job 1 delivered", "ink");
  note(s, 2.25, "failed · try 1 of 2", "red");
  note(s, 2.6, "redelivered", "amber");
  note(s, 4.15, "failed · try 2 of 2", "red");
  note(s, 5.4, "→ dead letter", "red");
  note(s, 6.0, "next job", "ink");
  note(s, 6.65, "job 2 done", "green");
  return {
    name: "dead letter",
    still: 5.9,
    timeline: seal(s),
    extra: { cap: 5, cons, dlq: true },
  };
}

export const queueMachine: MachinePartDef<QueueExtra> = {
  part: {
    name: "queue",
    job: "first in, first out",
    aka: "job queue · mailbox · buffer · inbox",
  },
  family: "messaging and flow control",
  footprint: "L",
  bb: [130, 160, 380, 80],
  status: { x: 320, y: 272 },
  scenarios: [
    fifoStory(false),
    fifoStory(true),
    retryStory(false),
    retryStory(true),
  ],
  draw: (t, { cap, cons, dlq }) => {
    let lamp: CardRole | null = null;
    let k = 0;
    for (const [a, c] of cons ?? [])
      if (t >= a && t < a + 0.9) {
        lamp = c;
        k = pop(t - a);
      }
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [130, Y],
          ]}
        />
        <Rail
          points={[
            [510, Y],
            [616, Y],
          ]}
        />
        <PartBox x={130} y={160} w={380} h={80} r={14} />
        {Array.from({ length: cap }, (_, i) => (
          <Outline
            key={i}
            x={470 - i * 40 - 16}
            y={Y - 11}
            w={32}
            h={22}
            r={4}
            role="rail"
            strokeWidth={1.5}
            dash="3 3"
          />
        ))}
        {cons && (
          <>
            <PartBox x={554} y={160} w={66} h={80} r={12} />
            <SvgText
              x={587}
              y={258}
              runs={[["consumer", 400, "dim"]]}
              size={18}
              align="center"
            />
            <Lamp x={587} y={176} r={6} role={lamp} k={k} />
          </>
        )}
        {dlq && (
          <>
            <Rail
              points={[
                [470, 240],
                [470, 290],
              ]}
            />
            <PartBox x={420} y={290} w={100} h={48} r={12} />
            <SvgText
              x={410}
              y={314}
              runs={[["dead letter", 400, "dim"]]}
              size={18}
              align="right"
            />
          </>
        )}
      </>
    );
  },
};
