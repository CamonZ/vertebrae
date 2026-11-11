/**
 * rate limiter · spends tokens to pass (catalogue "rate limiter"): a token
 * bucket; a card passes by spending a token. Ported from the gallery artifact
 * (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { PartBox } from "../fixtures";
import { pop } from "../motion";
import { RAIL_Y as Y } from "../MachinePart";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { Slab, Strokes } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** One token slot: `[_, spent at, refilled at, spent again at?]`. */
type TokenSlot = readonly [0, number, number, number?];

interface RateLimiterExtra {
  readonly tok: readonly TokenSlot[];
  readonly period: number;
}

function limiterStory(failed: boolean): PartScenario<RateLimiterExtra> {
  const s = story(5.6);
  const tok: TokenSlot[] = [
    [0, 1.05, 9],
    [0, 1.25, 3.6],
    [0, 1.45, 3.1],
    [0, 1.65, 2.25, failed ? 9 : 2.45],
  ];
  s.gates.push(gateV(210, Y), gateV(430, Y));
  for (let i = 0; i < 4; i++) {
    const a = 0.6 + 0.2 * i;
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [616, Y],
            ],
            a,
            1.1,
          ],
        ],
        a,
        a + 1.15
      )
    );
  }
  if (!failed)
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [184, Y],
            ],
            1.4,
            0.5,
          ],
          [
            [
              [184, Y],
              [616, Y],
            ],
            2.45,
            0.9,
          ],
        ],
        1.4,
        3.4,
        {
          col: [
            [1.85, "amber"],
            [2.45, "ink"],
          ],
          tags: [["waiting for a token", 1.9, 2.45]],
        }
      )
    );
  else
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [184, Y],
            ],
            1.4,
            0.5,
          ],
          [
            [
              [184, Y],
              [24, Y],
            ],
            2.0,
            0.6,
          ],
        ],
        1.4,
        2.65,
        { col: [[1.88, "red"]], lean: [2.0], tags: [["429", 2.1, 2.6]] }
      )
    );
  note(s, 0.6, "4 tokens", "dim");
  note(s, 1.05, "3 tokens", "ink");
  note(s, 1.65, "empty", "amber");
  note(
    s,
    failed ? 2.0 : 2.25,
    failed ? "rejected · 429" : "refilled · 1",
    failed ? "red" : "ink"
  );
  return {
    name: failed ? "429" : "waits for a token",
    still: 1.85,
    timeline: seal(s),
    extra: { tok, period: 5.6 },
  };
}

export const rateLimiterMachine: MachinePartDef<RateLimiterExtra> = {
  part: {
    name: "rate limiter",
    job: "spends tokens to pass",
    aka: "throttle · quota · token bucket · 429",
  },
  family: "messaging and flow control",
  footprint: "M",
  bb: [210, 115, 220, 170],
  status: { x: 320, y: 316 },
  scenarios: [limiterStory(false), limiterStory(true)],
  draw: (t, { tok, period }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [210, Y],
        ]}
      />
      <Rail
        points={[
          [430, Y],
          [616, Y],
        ]}
      />
      <PartBox x={210} y={115} w={220} h={170} />
      <SvgText
        x={260}
        y={132}
        runs={[["bucket", 400, "dim"]]}
        size={18}
        align="center"
      />
      {tok.map(([, use, refill, use2], i) => {
        const y = 246 - i * 24;
        let k = 1;
        if (t >= use) k = 0;
        if (t >= refill) k = pop(t - refill);
        if (use2 && t >= use2) k = 0;
        if (t >= period - 0.6) k = 1;
        return (
          <g key={i}>
            <Slab
              x={244}
              y={y - 6}
              w={32}
              h={12}
              r={6}
              role="hole"
              stroke="edge"
            />
            {k > 0 && (
              <Slab
                x={246}
                y={y - 4}
                w={28 * Math.min(k, 1.1)}
                h={8}
                r={4}
                role="plate"
              />
            )}
          </g>
        );
      })}
      <Strokes
        lines={[
          [
            [290, 150],
            [290, 250],
          ],
        ]}
        role="edge"
        w={2}
      />
    </>
  ),
};
