/**
 * router · picks one way out (catalogue "router"): a swinging arm that picks
 * one of three out rails, or drops the card to the fallback / 404 lane below.
 * Ported from the gallery line for line.
 */
import { PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { clamp } from "../motion";
import { roleColor } from "../palette";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { SvgText } from "../SvgText";
import { card, gateH, gateV, note, seal, story } from "../timeline";
import { PlateLine } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** Arm positions: -1 upper rail, 0 middle, 1 lower, 2 straight down. */
type ArmPosition = -1 | 0 | 1 | 2;

interface RouterExtra {
  readonly routes?: readonly string[];
  /** `[t, position]`: the arm swings to `position` at `t` (clamp spring). */
  readonly arm: readonly (readonly [number, ArmPosition])[];
  /** The card leaves down: a fallback box or a dashed 404 lane. */
  readonly down: boolean;
  readonly fallback: boolean;
}

const OUT_Y = [140, Y, 260] as const;
const PIVOT: Point = [270, Y];
const ROUTES = ["/tasks", "/runs", "/health"] as const;

const armAngle = (i: ArmPosition) =>
  i === 2 ? Math.PI / 2 : Math.atan2(OUT_Y[i + 1] - Y, 120);

function routerStory(
  kind: "routed" | "no route · 404" | "fallback"
): PartScenario<RouterExtra> {
  const s = story(5.0);
  const fb = kind === "fallback";
  const f = kind === "no route · 404";
  const down = f || fb;
  s.gates.push(gateV(200, Y), gateV(390, 140), gateV(390, Y), gateV(390, 260));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [[[24, Y], PIVOT], 0.6, 0.55],
        [[PIVOT, [390, 140], [600, 140]], 1.3, 0.6],
      ],
      0.6,
      1.95,
      { tags: [["/tasks", 0.65, 1.0]] }
    )
  );
  if (fb)
    s.cards.push(
      card(
        28,
        "ink",
        [
          [[[24, Y], PIVOT], 2.6, 0.55],
          [[PIVOT, [270, 285], [270, 334]], 3.35, 0.6],
        ],
        2.6,
        4.3,
        { tags: [["/nope", 2.65, 3.0]] }
      )
    );
  else if (f)
    s.cards.push(
      card(
        28,
        "ink",
        [
          [[[24, Y], PIVOT], 2.6, 0.55],
          [[PIVOT, [270, 285], [270, 370]], 3.35, 0.6],
        ],
        2.6,
        3.95,
        {
          col: [[3.2, "red"]],
          tags: [
            ["/nope", 2.65, 3.0],
            ["no route", 3.5, 3.95],
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
          [[[24, Y], PIVOT], 2.6, 0.55],
          [[PIVOT, [390, 260], [600, 260]], 3.3, 0.6],
        ],
        2.6,
        3.95,
        { tags: [["/health", 2.65, 3.0]] }
      )
    );
  if (down) s.gates.push(gateH(270, 290));
  note(s, 0.6, "match path", "dim");
  note(s, 1.2, "→ tasks", "ink");
  note(s, 2.6, "match path", "dim");
  note(
    s,
    3.2,
    fb ? "no match → fallback" : f ? "no route · 404" : "→ health",
    fb ? "amber" : f ? "red" : "ink"
  );
  return {
    name: kind,
    still: fb ? 4.1 : 1.6,
    timeline: seal(s),
    extra: {
      arm: [
        [0, 0],
        [1.05, -1],
        [3.05, down ? 2 : 1],
      ],
      down,
      fallback: fb,
    },
  };
}

function angleAt(arm: RouterExtra["arm"], t: number): number {
  if (arm.length < 2 || t < arm[1][0]) return 0;
  let a = armAngle(arm[0][1]);
  for (let i = 1; i < arm.length; i++) {
    const [t0, to] = arm[i];
    const from = arm[i - 1][1];
    if (t >= t0)
      a = armAngle(from) + (armAngle(to) - armAngle(from)) * clamp(t - t0);
  }
  return a;
}

export const routerMachine: MachinePartDef<RouterExtra> = {
  part: {
    name: "router",
    job: "picks one way out",
    aka: "dispatcher · switch · load balancer",
  },
  family: "compute",
  footprint: "S",
  bb: [200, 110, 190, 180],
  status: { x: 480, y: 322 },
  scenarios: [
    routerStory("routed"),
    routerStory("no route · 404"),
    routerStory("fallback"),
  ],
  draw: (t, { arm, down, fallback, routes = ROUTES }) => {
    const a = angleAt(arm, t);
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
              [390, y],
              [600, y],
            ]}
          />
        ))}
        {fallback ? (
          <>
            <Rail
              points={[
                [270, 290],
                [270, 312],
              ]}
            />
            <PartBox x={226} y={312} w={88} h={44} r={12} />
            <SvgText
              x={216}
              y={334}
              runs={[["fallback", 400, "dim"]]}
              size={18}
              align="right"
            />
          </>
        ) : (
          down && (
            <Rail
              points={[
                [270, 290],
                [270, 370],
              ]}
              dashed
              dash="4 6"
            />
          )
        )}
        <PartBox x={200} y={110} w={190} h={180} />
        <PlateLine
          x1={270}
          y1={Y}
          x2={270 + 64 * Math.cos(a)}
          y2={Y + 64 * Math.sin(a)}
          w={6}
        />
        <circle cx={270} cy={Y} r={8} fill={roleColor("plate")} />
        {routes.map((r, i) => (
          <SvgText
            key={r}
            x={596}
            y={160 + 60 * i}
            runs={[[r, 400, "dim"]]}
            size={18}
            align="right"
          />
        ))}
      </>
    );
  },
};
