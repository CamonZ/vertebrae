/**
 * circuit breaker · fails fast when broken (catalogue "circuit breaker"):
 * blade and contacts; an open blade fails fast. Ported from the gallery
 * artifact (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { Lamp, PartBox, Ring } from "../fixtures";
import { held, pop } from "../motion";
import { roleColor } from "../palette";
import { RAIL_Y as Y } from "../MachinePart";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { PlateLine } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface BreakerExtra {
  /** When each failure lands (lamps and the service lamp). */
  readonly fails: readonly number[];
  /** Blade open window. */
  readonly open: readonly [number, number];
  /** Half-open window (a trial); null follows the default recovery. */
  readonly half: readonly [number, number] | null;
  /** Cooling-down ring. */
  readonly cool: readonly [number, number];
  /** When the trial outcome lands. */
  readonly trial: number;
  readonly fail: boolean;
}

function breakerStory(failed: boolean): PartScenario<BreakerExtra> {
  const s = story(8.6);
  const fails: number[] = [];
  s.gates.push(gateV(180, Y), gateV(430, Y));
  [0.6, 1.3, 2.0].forEach((a) => {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [556, Y],
            ],
            a,
            1.0,
          ],
        ],
        a,
        a + 1.05
      )
    );
    fails.push(a + 1.1);
  });
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, Y],
            [262, Y],
          ],
          3.8,
          0.5,
        ],
        [
          [
            [262, Y],
            [24, Y],
          ],
          4.4,
          0.5,
        ],
      ],
      3.8,
      4.95,
      {
        col: [[4.28, "red"]],
        lean: [4.4],
        tags: [["fail fast", 4.5, 4.9]],
      }
    )
  );
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, Y],
            [556, Y],
          ],
          6.2,
          1.0,
        ],
      ],
      6.2,
      7.25,
      { tags: [["trial", 6.25, 6.7]] }
    )
  );
  note(s, 0.6, "closed", "dim");
  note(s, 1.7, "1 failure", "red");
  note(s, 2.4, "2 failures", "red");
  note(s, 3.1, "3 failures · open", "red");
  note(s, 4.4, "open · fail fast", "red");
  note(s, 4.6, "cooling down", "amber");
  note(s, 5.9, "half-open · one trial", "amber");
  note(
    s,
    7.3,
    failed ? "trial failed · open" : "trial ok · closed",
    failed ? "red" : "green"
  );
  return {
    name: failed ? "stays open" : "recovers",
    still: 4.2,
    timeline: seal(s),
    extra: {
      fails,
      open: failed ? [3.2, 9] : [3.2, 6.3],
      half: failed ? [5.9, 7.35] : null,
      cool: [4.6, 5.9],
      trial: 7.3,
      fail: failed,
    },
  };
}

export const circuitBreakerMachine: MachinePartDef<BreakerExtra> = {
  part: {
    name: "circuit breaker",
    job: "fails fast when broken",
    aka: "breaker · bulkhead · kill switch",
  },
  family: "messaging and flow control",
  footprint: "M",
  bb: [180, 135, 250, 130],
  status: { x: 305, y: 296 },
  scenarios: [breakerStory(false), breakerStory(true)],
  draw: (t, { fails, open, half, cool, trial, fail }) => {
    let ang = -0.75 * held(t, open[0], open[1]);
    if (half) ang += 0.4 * held(t, half[0], half[1]);
    else ang += 0.4 * held(t, 5.9, open[1]) * (t < open[1] ? 1 : 0);
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [180, Y],
          ]}
        />
        <Rail
          points={[
            [430, Y],
            [520, Y],
          ]}
        />
        <PartBox x={520} y={150} w={80} h={100} r={12} />
        <SvgText
          x={560}
          y={266}
          runs={[["service", 400, "dim"]]}
          size={18}
          align="center"
        />
        <PartBox x={180} y={135} w={250} h={130} />
        <Lamp
          x={560}
          y={176}
          r={7}
          role={
            t >= trial
              ? fail
                ? "red"
                : "green"
              : fails.some((a) => t >= a && t < a + 0.4)
                ? "red"
                : null
          }
          k={1}
        />
        {fails.map((a, i) => (
          <Lamp
            key={i}
            x={210 + 26 * i}
            y={158}
            r={7}
            role={t >= a && (t < trial || fail) ? "red" : null}
            k={pop(t - a)}
          />
        ))}
        <circle cx={290} cy={Y} r={6} fill={roleColor("edge")} />
        <circle cx={350} cy={Y} r={6} fill={roleColor("edge")} />
        <PlateLine
          x1={290}
          y1={Y}
          x2={290 + 60 * Math.cos(ang)}
          y2={Y + 60 * Math.sin(ang)}
          w={6}
        />
        <Ring
          x={320}
          y={Y}
          t={t}
          from={cool[0]}
          to={cool[1]}
          result={null}
          r={46}
        />
      </>
    );
  },
};
