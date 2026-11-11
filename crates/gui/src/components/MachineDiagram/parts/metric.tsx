/**
 * metric · a number against a limit (catalogue "metric"): a gauge with a warn
 * tick and a limit tick. Ported from the gallery artifact
 * (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { PartBox } from "../fixtures";
import { pop, smoothstep } from "../motion";
import type { StateRole } from "../palette";
import { RAIL_Y as Y } from "../MachinePart";
import { Rail } from "../Rail";
import { StatusLine } from "../StatusLine";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, statusAt, story } from "../timeline";
import { Slab } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface MetricExtra {
  /** When each sample lands on the gauge. */
  readonly ev: readonly number[];
  /** The value read-out: `[t, text, role]`. */
  readonly val: readonly (readonly [number, string, StateRole])[];
  readonly period: number;
}

const LIMIT = 184 + (50 * 23) / 6;
const WARN = 184 + (40 * 23) / 6;

function metricStory(
  kind: "under limit" | "over limit" | "near limit"
): PartScenario<MetricExtra> {
  const s = story(5.2);
  const f = kind === "over limit";
  const n = f ? 11 : kind === "near limit" ? 7 : 5;
  const ev: number[] = [];
  s.gates.push(gateV(150, Y));
  for (let i = 0; i < n; i++) {
    const a = 0.6 + 0.24 * i;
    s.cards.push(
      card(
        12,
        "edge",
        [
          [
            [
              [24, Y],
              [166, Y],
            ],
            a,
            0.45,
          ],
        ],
        a,
        a + 0.48,
        { h: 8 }
      )
    );
    ev.push(a + 0.45);
  }
  const val: [number, string, StateRole][] = [[0, "0 / s", "dim"]];
  ev.forEach((a, i) => {
    const x = (i + 1) * 6;
    val.push([a, `${x} / s`, x > 50 ? "red" : x >= 40 ? "amber" : "ink"]);
  });
  note(s, 0.6, "counting", "dim");
  note(
    s,
    ev[n - 1] + 0.1,
    f ? "over limit" : n === 7 ? "near limit · past 40" : "under limit",
    f ? "red" : n === 7 ? "amber" : "green"
  );
  s.notes[0] = [0, "quiet", "dim"];
  return {
    name: kind,
    still: kind === "near limit" ? 3.0 : 2.85,
    timeline: seal(s),
    extra: { ev, val, period: 5.2 },
  };
}

export const metricMachine: MachinePartDef<MetricExtra> = {
  part: {
    name: "metric",
    job: "a number against a limit",
    aka: "counter · gauge · histogram · usage",
  },
  family: "observability",
  footprint: "L",
  bb: [150, 140, 340, 120],
  status: { x: 320, y: 290 },
  scenarios: [
    metricStory("under limit"),
    metricStory("over limit"),
    metricStory("near limit"),
  ],
  draw: (t, { ev, val, period }) => {
    let w = 0;
    for (const a of ev) if (t >= a) w += 23 * Math.min(pop(t - a), 1.1);
    w *= 1 - smoothstep(period - 1.2, period - 0.5, t);
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [150, Y],
          ]}
        />
        <PartBox x={150} y={140} w={340} h={120} r={14} />
        <Slab x={184} y={214} w={270} h={10} r={5} role="rail" />
        {w > 0 && (
          <>
            <Slab
              x={184}
              y={214}
              w={Math.min(w, WARN - 184)}
              h={10}
              r={5}
              role="plate"
            />
            {w > WARN - 184 && (
              <Slab
                x={WARN}
                y={214}
                w={Math.min(w, LIMIT - 184) - (WARN - 184)}
                h={10}
                role="amber"
              />
            )}
            {w > LIMIT - 184 && (
              <Slab
                x={LIMIT}
                y={214}
                w={Math.min(w - (LIMIT - 184), 454 - LIMIT)}
                h={10}
                r={5}
                role="red"
              />
            )}
          </>
        )}
        <Slab x={LIMIT - 1.5} y={206} w={3} h={26} role="amber" />
        <StatusLine
          status={statusAt(
            val.map((v) => [...v] as [number, string, StateRole]),
            t
          )}
          x={184}
          y={172}
          size={22}
          align="left"
        />
        <SvgText
          x={454}
          y={172}
          runs={[["limit 50", 400, "dim"]]}
          size={18}
          align="right"
        />
        <Slab x={WARN - 1} y={208} w={2} h={22} role="edge" />
        <SvgText
          x={WARN}
          y={244}
          runs={[["warn 40", 400, "dim"]]}
          size={18}
          align="center"
        />
      </>
    );
  },
};
