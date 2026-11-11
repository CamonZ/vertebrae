/**
 * aggregator · many in, one out (catalogue "aggregator"): item bars spring
 * in as cards arrive, then a piston compresses them and one card leaves.
 * Ported from the gallery line for line (as drawn, the compacted bars stay
 * as stubs until the loop fades).
 */
import { Bar, PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { clamp, pop, smoothstep } from "../motion";
import { roleColor, type CardRole } from "../palette";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import { PlateLine } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface AggregatorExtra {
  /** `[t, role]`: an item bar springs in at `t`. */
  readonly items: readonly (readonly [number, CardRole])[];
}

/** The piston compresses the items from here. */
const SQUEEZE_AT = 2.4;

function aggregatorStory(f: boolean): PartScenario<AggregatorExtra> {
  const s = story(5.0);
  s.gates.push(gateV(200, Y), gateV(440, Y));
  const items: [number, CardRole][] = [];
  for (let i = 0; i < 5; i++) {
    const a = 0.6 + 0.25 * i;
    const bad = f && i === 3;
    s.cards.push(
      card(
        18,
        bad ? "red" : "edge",
        [
          [
            [
              [24, Y],
              [236, Y],
            ],
            a,
            0.5,
          ],
        ],
        a,
        a + 0.55
      )
    );
    items.push([a + 0.5, bad ? "red" : "ink"]);
  }
  s.cards.push(
    card(
      36,
      f ? "red" : "ink",
      [
        [
          [
            [340, Y],
            [616, Y],
          ],
          2.75,
          0.6,
        ],
      ],
      2.7,
      3.4,
      { tags: [[f ? "1 bad item" : "5 → 1", 2.9, 3.35]] }
    )
  );
  note(s, 0.6, "collecting", "dim");
  note(s, 1.8, "5 items", "ink");
  note(s, 2.4, "compacting", "dim");
  note(s, 2.75, f ? "failed · bad item" : "one summary", f ? "red" : "green");
  return {
    name: f ? "bad item" : "5 → 1",
    still: 2.0,
    timeline: seal(s),
    extra: { items },
  };
}

export const aggregatorMachine: MachinePartDef<AggregatorExtra> = {
  part: {
    name: "aggregator",
    job: "many in, one out",
    aka: "reducer · batcher · summarizer · compactor",
  },
  family: "compute",
  footprint: "M",
  bb: [200, 105, 240, 190],
  status: { x: 320, y: 328 },
  scenarios: [aggregatorStory(false), aggregatorStory(true)],
  draw: (t, { items }) => {
    const sq = clamp(t - SQUEEZE_AT);
    const px =
      420 -
      (420 - 345) *
        sq *
        (1 - smoothstep(SQUEEZE_AT + 0.5, SQUEEZE_AT + 0.9, t));
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [200, Y],
          ]}
        />
        <Rail
          points={[
            [440, Y],
            [616, Y],
          ]}
        />
        <PartBox x={200} y={105} w={240} h={190} />
        {items.map(([a, role], i) =>
          t < a ? null : (
            <Bar
              key={i}
              x={250}
              y={148 + i * 22}
              w={110 - 80 * sq}
              role={role}
              k={pop(t - a)}
              h={9}
            />
          )
        )}
        <rect
          x={424}
          y={140}
          width={8}
          height={120}
          rx={3}
          fill={roleColor("edge")}
        />
        <PlateLine x1={424} y1={Y} x2={px} y2={Y} />
        <rect
          x={px - 9}
          y={138}
          width={9}
          height={124}
          fill={roleColor("plate")}
        />
      </>
    );
  },
};
