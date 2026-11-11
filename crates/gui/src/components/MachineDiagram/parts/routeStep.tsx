/**
 * route step · picks the next step by rules (catalogue "route step"): rule
 * tiles r1, r2, else lit in order, then the arm swings to the chosen
 * transition. Ported from the gallery line for line.
 */
import { PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { clamp, valueAt } from "../motion";
import type { CardRole } from "../palette";
import { roleColor } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { PlateLine, Tile } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface RuleTile {
  readonly x: number;
  readonly label: string;
  /** Colour changes after the edge-coloured start. */
  readonly col: readonly (readonly [number, CardRole])[];
}

interface RouteExtra {
  readonly tiles: readonly RuleTile[];
  /** The arm swings to out rail `to` (0 top, 1 middle, 2 bottom) at `at`. */
  readonly arm: readonly [at: number, to: 0 | 1 | 2];
  /** Labels of the three transitions (default review, docs, plan). */
  readonly labels?: readonly string[];
}

const OUT_Y = [150, Y, 250] as const;
const OUT_LABELS = ["review", "docs", "plan"] as const;
const PIVOT = [300, Y] as const;

function routeStory(
  kind: "rule matches" | "no rule, no default" | "default taken"
): PartScenario<RouteExtra> {
  const f = kind === "no rule, no default";
  const dflt = kind === "default taken";
  const s = story(4.4);
  s.gates.push(gateV(200, Y), gateV(400, 150), gateV(400, Y), gateV(400, 250));
  const to: 0 | 1 | 2 = f ? 0 : dflt ? 2 : 1;
  const tiles: RuleTile[] = [
    {
      x: 236,
      label: "r1",
      col: [
        [1.1, "amber"],
        [1.4, "edge"],
      ],
    },
    {
      x: 300,
      label: "r2",
      col: [
        [1.4, "amber"],
        [1.7, f || dflt ? "edge" : "green"],
      ],
    },
    {
      x: 364,
      label: f ? "none" : "else",
      col:
        f || dflt
          ? [
              [1.7, "amber"],
              [2.0, f ? "red" : "green"],
            ]
          : [],
    },
  ];
  if (f)
    s.cards.push(
      card(
        28,
        "ink",
        [
          [[[24, Y], [...PIVOT]], 0.6, 0.55],
          [[[...PIVOT], [24, Y]], 2.4, 0.6],
        ],
        0.6,
        3.1,
        {
          col: [[2.0, "red"]],
          lean: [2.4],
          tags: [
            ["run", 0.65, 1.0],
            ["no transition", 2.55, 3.05],
          ],
        }
      )
    );
  else
    s.cards.push(
      card(
        28,
        "ink",
        [
          [[[24, Y], [...PIVOT]], 0.6, 0.55],
          [[[...PIVOT], [400, OUT_Y[to]], [600, OUT_Y[to]]], 2.1, 0.6],
        ],
        0.6,
        2.8,
        { tags: [["run", 0.65, 1.0]] }
      )
    );
  note(s, 0.6, "evaluating rules", "dim");
  note(s, 1.4, "r1 no", "dim");
  if (f) {
    note(s, 1.7, "r2 no", "dim");
    note(s, 2.0, "no rule · no default · step failed", "red");
  } else if (dflt) {
    note(s, 1.7, "r2 no", "dim");
    note(s, 2.0, "default → plan", "ink");
  } else note(s, 1.7, "r2 yes → docs", "ink");
  return {
    name: kind,
    still: f ? 2.7 : dflt ? 2.2 : 2.0,
    timeline: seal(s),
    extra: { tiles, arm: [1.75, to] },
  };
}

const armAngle = (i: 0 | 1 | 2) => Math.atan2(OUT_Y[i] - Y, 100);

export const routeStepMachine: MachinePartDef<RouteExtra> = {
  part: {
    name: "route step",
    job: "picks the next step by rules",
    aka: "route · route_config · rules + default",
  },
  family: "vertebrae workflows",
  footprint: "S",
  bb: [200, 110, 200, 180],
  status: { x: 300, y: 322 },
  scenarios: [
    routeStory("rule matches"),
    routeStory("no rule, no default"),
    routeStory("default taken"),
  ],
  draw: (t, { tiles, arm, labels = OUT_LABELS }) => {
    const a = t >= arm[0] ? armAngle(arm[1]) * clamp(t - arm[0]) : 0;
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [200, Y],
          ]}
        />
        {OUT_Y.map((y) => (
          <Rail
            key={y}
            points={[
              [400, y],
              [600, y],
            ]}
          />
        ))}
        <PartBox x={200} y={110} w={200} h={180} />
        {tiles.map((q) => (
          <Tile
            key={q.label}
            x={q.x}
            y={128}
            label={q.label}
            role={valueAt<CardRole>([[-1e9, "edge"], ...q.col], t)}
            w={52}
            k={1}
          />
        ))}
        <PlateLine
          x1={PIVOT[0]}
          y1={PIVOT[1]}
          x2={PIVOT[0] + 62 * Math.cos(a)}
          y2={PIVOT[1] + 62 * Math.sin(a)}
          w={6}
        />
        <circle cx={PIVOT[0]} cy={PIVOT[1]} r={8} fill={roleColor("plate")} />
        {labels.slice(0, 3).map((label, i) => (
          <SvgText
            key={label}
            x={596}
            y={170 + 50 * i}
            runs={[[label, 400, "dim"]]}
            size={18}
            align="right"
          />
        ))}
      </>
    );
  },
};
