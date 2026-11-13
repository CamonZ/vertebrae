/* eslint-disable react-refresh/only-export-components -- typed geometry and fixtures share one responsibility */
import { shardRingSpec, type ShardRingExtra } from "./shardRingSpec";

export type { ShardRingExtra } from "./shardRingSpec";

/* eslint-disable react-refresh/only-export-components -- part definitions and their fixtures are shared as data */
import { Bar, Lamp } from "../fixtures";
import { arcPath } from "../geometry";
import { pop, track, windowed } from "../motion";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { card, note, seal, story, type StoryDraft } from "../timeline";
import { arcPoints as arcPts, onCircle as onC } from "./distributedFixtures";
import { FadedText } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
const RC = [230, 205] as const,
  RR = 95;
const NAMES = ["key routed", "hot shard", "node added · keys move"] as const;
const STILLS = [2.3, 2.9, 1.9];
function shardRingStory(index: number): PartScenario<ShardRingExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & ShardRingExtra = Object.assign(story(4.8), {
      nodes: [],
      load: {},
      pulse: [],
      arc: null,
      red: null,
    } as ShardRingExtra),
    add = s === "node added · keys move";
  const done = (): PartScenario<ShardRingExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push();
  S.nodes = [
    ["A", 40, -1],
    ["B", 160, -1],
    ["C", 280, -1],
  ];
  S.load = { A: [[0, 40]], B: [[0, 40]], C: [[0, 40]], D: [[0, 0]] };
  S.pulse = [];
  S.arc = null;
  S.red = null;
  const key = (
    ang: number,
    owner: string,
    to: number,
    a: number,
    tag?: string
  ) => {
    S.cards.push(
      card(
        14,
        "ink",
        [
          [[onC(...RC, RR, ang), onC(...RC, RR, ang)], a, 0.05],
          [arcPts(...RC, RR, ang, to), a + 0.35, 0.6],
        ],
        a,
        a + 1.0,
        { dot: true, tags: tag ? [[tag, a, a + 0.6, -22]] : [] }
      )
    );
    S.pulse.push([owner, a + 0.95]);
    const L = S.load[owner];
    L.push([a + 0.95, L[L.length - 1][1] + 12]);
  };
  if (add) {
    S.period = 4.8;
    S.nodes.push(["D", 100, 0.9]);
    S.arc = [1.2, 3.4];
    for (const a of [1.4, 1.75]) {
      S.cards.push(
        card(14, "amber", [[arcPts(...RC, RR, 160, 100), a, 0.6]], a, a + 0.7, {
          dot: true,
        })
      );
    }
    S.load.B.push([2.0, 28], [2.35, 16]);
    S.load.D.push([2.0, 12], [2.35, 24]);
    note(S, 0.9, "add D at 100°", "ink");
    note(S, 1.4, "only 40°–100° moves · B → D", "amber");
    note(S, 2.6, "A and C untouched", "green");
    return done();
  }
  if (f) {
    S.period = 4.8;
    for (let k = 0; k < 6; k++) key(60 + 14 * k, "B", 160, 0.7 + 0.3 * k);
    S.red = 2.6;
    note(S, 0.7, "hot keys all hash near B", "amber");
    note(S, 2.6, "B over capacity", "red");
    note(S, 3.4, "A and C idle", "dim");
    return done();
  }
  key(100, "B", 160, 0.7, "user:42");
  key(220, "C", 280, 1.8, "cart:9");
  key(330, "A", 400, 2.9, "job:3");
  note(S, 0.7, "hash(user:42) = 100° → B", "ink");
  note(S, 1.8, "hash(cart:9) = 220° → C", "ink");
  note(S, 2.9, "hash(job:3) = 330° → A", "ink");
  note(S, 3.9, "next node clockwise owns it", "green");
  return done();
}

export const shardRingMachine: MachinePartDef<ShardRingExtra> = {
  part: {
    name: "shard ring",
    job: shardRingSpec.job,
    aka: "consistent hash \u00b7 partitioner \u00b7 shard map",
  },
  family: "distributed systems",
  footprint: "L",
  bb: shardRingSpec.bb,
  status: shardRingSpec.status,
  scenarios: [shardRingStory(0), shardRingStory(1), shardRingStory(2)],
  draw: (t, S) => <ShardRingDrawing t={t} S={S} />,
};

function ShardRingDrawing({ t, S }: { t: number; S: ShardRingExtra }) {
  const { fade } = usePart();
  return (
    <>
      <circle
        cx={RC[0]}
        cy={RC[1]}
        r={RR}
        fill="none"
        stroke={roleColor("rail")}
        strokeWidth={2.5}
      />
      {S.arc && (
        <path
          d={arcPath(
            ...RC,
            RR,
            ((40 - 90) * Math.PI) / 180,
            ((100 - 90) * Math.PI) / 180
          )}
          fill="none"
          stroke={roleColor("amber")}
          strokeWidth={6}
          opacity={windowed(t, ...S.arc) * fade}
        />
      )}
      {S.nodes.map(([n, a, at]) => {
        if (at >= 0 && t < at) return null;
        const k = at >= 0 ? Math.min(1.1, pop(t - at)) : 1,
          [x, y] = onC(...RC, RR, a),
          [lx, ly] = onC(...RC, RR + 30, a);
        let hit = 0;
        for (const [o, b] of S.pulse)
          if (o === n) hit = Math.max(hit, windowed(t, b - 0.05, b + 0.25));
        return (
          <g key={n}>
            <g transform={`translate(${x} ${y}) scale(${k})`}>
              <Lamp
                x={0}
                y={0}
                r={13}
                role={
                  hit > 0.3
                    ? "ink"
                    : S.red != null && n === "B" && t >= S.red
                      ? "red"
                      : "green"
                }
                k={1}
              />
            </g>
            <FadedText
              x={lx}
              y={ly}
              runs={[[n, 600, "dim"]]}
              size={18}
              align="center"
            />
          </g>
        );
      })}
      {S.nodes.map(([n], i) => {
        const y = 150 + 40 * i,
          w = track(S.load[n], t, pop);
        return (
          <g key={n}>
            <FadedText x={420} y={y} runs={[[n, 600, "dim"]]} size={18} />
            <line
              x1={550}
              y1={y - 14}
              x2={550}
              y2={y + 14}
              stroke={roleColor("rail")}
              strokeWidth={2}
            />
            {w > 0.5 && (
              <Bar
                x={445}
                y={y - 5}
                w={w * 1.4}
                role={S.red != null && n === "B" && t >= S.red ? "red" : "ink"}
                h={10}
              />
            )}
          </g>
        );
      })}
      <FadedText
        x={550}
        y={116}
        runs={[["limit", 400, "dim"]]}
        size={18}
        align="center"
      />
    </>
  );
}
