/**
 * cache · answers from memory (catalogue "cache"): a scan line over cached
 * entries and an origin box behind it. A hit answers from the entries, a miss
 * goes on to the origin and fills one back. Ported from the gallery line for
 * line.
 */
import { Bar, PartBox } from "../fixtures";
import { clamp, pop, smoothstep, windowed } from "../motion";
import type { CardRole } from "../palette";
import { roleColor } from "../palette";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story, type StoryDraft } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface CacheRow {
  /** Row slot (0..3). */
  readonly i: number;
  readonly w: number;
  readonly c: "ink" | "edge";
  /** Row appears (spring in) at this time. */
  readonly add?: number;
  /** Amber/green highlights `[from, role]`, each shown for 0.3 s. */
  readonly hl?: readonly (readonly [number, CardRole])[];
  /** Row drains away between these times (ttl running out). */
  readonly drain?: readonly [number, number];
  /** Row is deleted (invalidated) at this time. */
  readonly del?: number;
}

interface CacheExtra {
  readonly rows: readonly CacheRow[];
  /** Scan-line passes `[from, to]`. */
  readonly scan: readonly (readonly [number, number])[];
}

const IN: Point[] = [
  [24, 160],
  [280, 160],
];
const OUT: Point[] = [
  [280, 160],
  [540, 160],
];
const BACK: Point[] = [
  [540, 250],
  [280, 250],
];
const HOME: Point[] = [
  [280, 250],
  [24, 250],
];
const HIT: Point[] = [
  [280, 160],
  [280, 250],
  [24, 250],
];

const baseRows = (): CacheRow[] => [
  { i: 0, w: 90, c: "ink" },
  { i: 1, w: 60, c: "edge" },
  { i: 2, w: 110, c: "ink" },
];

function begin(period: number): StoryDraft {
  const s = story(period);
  s.gates.push(
    gateV(180, 160),
    gateV(180, 250),
    gateV(380, 160),
    gateV(380, 250)
  );
  return s;
}

function cacheStory(
  kind: "miss then hit" | "origin fails" | "ttl expiry" | "invalidate on write"
): PartScenario<CacheExtra> {
  const scan: [number, number][] = [];
  if (kind === "ttl expiry") {
    const s = begin(7.2);
    const rows: CacheRow[] = baseRows();
    rows[1] = { ...rows[1], hl: [[1.4, "green"]], drain: [1.6, 3.2] };
    rows.push({ i: 1, w: 60, c: "ink", add: 5.65 });
    s.cards.push(
      card(
        28,
        "ink",
        [
          [IN, 0.6, 0.5],
          [HIT, 1.5, 0.7],
        ],
        0.6,
        2.25,
        {
          col: [[1.4, "green"]],
          tags: [
            ["get k2", 0.65, 1.0],
            ["hit", 1.7, 2.2, 28],
          ],
        }
      )
    );
    scan.push([1.05, 1.4]);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [IN, 3.4, 0.5],
          [OUT, 4.4, 0.55],
        ],
        3.4,
        5.0,
        {
          tags: [
            ["get k2", 3.45, 3.8],
            ["miss", 4.5, 4.95],
          ],
        }
      )
    );
    scan.push([3.95, 4.35]);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [BACK, 5.1, 0.55],
          [HOME, 5.75, 0.6],
        ],
        5.1,
        6.4,
        { tags: [["fresh k2", 5.15, 5.6, 28]] }
      )
    );
    note(s, 0.6, "lookup", "dim");
    note(s, 1.4, "hit", "green");
    note(s, 1.8, "k2 ttl running", "amber");
    note(s, 3.2, "k2 expired", "dim");
    note(s, 3.4, "lookup", "dim");
    note(s, 4.35, "miss → origin", "amber");
    note(s, 5.65, "refilled", "ink");
    return {
      name: kind,
      still: 3.35,
      timeline: seal(s),
      extra: { rows, scan },
    };
  }
  if (kind === "invalidate on write") {
    const s = begin(6.4);
    const rows: CacheRow[] = baseRows();
    rows[1] = { ...rows[1], hl: [[1.15, "amber"]], del: 1.35 };
    rows.push({ i: 1, w: 60, c: "ink", add: 4.65 });
    s.cards.push(
      card(
        28,
        "amber",
        [
          [IN, 0.6, 0.55],
          [OUT, 1.25, 0.55],
        ],
        0.6,
        1.9,
        { tags: [["write k2", 0.65, 1.1]] }
      )
    );
    s.cards.push(
      card(
        28,
        "ink",
        [
          [IN, 2.4, 0.5],
          [OUT, 3.4, 0.55],
        ],
        2.4,
        4.0,
        {
          tags: [
            ["get k2", 2.45, 2.8],
            ["miss", 3.5, 3.95],
          ],
        }
      )
    );
    scan.push([2.95, 3.35]);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [BACK, 4.1, 0.55],
          [HOME, 4.75, 0.6],
        ],
        4.1,
        5.4,
        { tags: [["new k2", 4.15, 4.6, 28]] }
      )
    );
    note(s, 0.6, "write → origin", "ink");
    note(s, 1.35, "k2 invalidated", "amber");
    note(s, 2.4, "lookup", "dim");
    note(s, 3.35, "miss → origin", "amber");
    note(s, 4.65, "new k2 cached", "green");
    return {
      name: kind,
      still: 1.65,
      timeline: seal(s),
      extra: { rows, scan },
    };
  }
  const f = kind === "origin fails";
  const s = begin(6.8);
  const rows: CacheRow[] = baseRows();
  s.cards.push(
    card(
      28,
      "ink",
      [
        [IN, 0.6, 0.55],
        [OUT, 1.65, 0.55],
      ],
      0.6,
      2.25,
      {
        tags: [
          ["get k9", 0.65, 1.0],
          ["miss", 1.75, 2.15],
        ],
      }
    )
  );
  scan.push([1.15, 1.6]);
  s.cards.push(
    card(
      28,
      f ? "red" : "ink",
      [
        [BACK, 2.5, 0.55],
        [HOME, 3.25, 0.6],
      ],
      2.5,
      3.9,
      { tags: [[f ? "origin 503" : "k9 from origin", 2.55, 2.95, 28]] }
    )
  );
  if (!f) {
    rows.push({ i: 3, w: 80, c: "ink", add: 3.1 });
    rows[1] = { ...rows[1], hl: [[5.25, "green"]] };
  }
  s.cards.push(
    card(
      28,
      "ink",
      [
        [IN, 4.3, 0.55],
        [HIT, 5.35, 0.7],
      ],
      4.3,
      6.1,
      {
        col: [[5.25, f ? "ink" : "green"]],
        tags: [
          ["get k2", 4.35, 4.7],
          [f ? "miss" : "hit", 5.5, 6.0, 28],
        ],
      }
    )
  );
  scan.push([4.85, 5.25]);
  note(s, 0.6, "lookup", "dim");
  note(s, 1.6, "miss → origin", "amber");
  note(s, 2.6, f ? "origin failed" : "filled", f ? "red" : "ink");
  note(s, 4.3, "lookup", "dim");
  note(s, 5.25, f ? "miss" : "hit", f ? "amber" : "green");
  return {
    name: kind,
    still: 1.45,
    timeline: seal(s),
    extra: { rows, scan },
  };
}

export const cacheMachine: MachinePartDef<CacheExtra> = {
  part: {
    name: "cache",
    job: "answers from memory",
    aka: "memo · CDN · query cache · LRU",
  },
  family: "data and state",
  footprint: "S",
  bb: [180, 110, 200, 180],
  status: { x: 280, y: 322 },
  scenarios: [
    cacheStory("miss then hit"),
    cacheStory("origin fails"),
    cacheStory("ttl expiry"),
    cacheStory("invalidate on write"),
  ],
  draw: (t, { rows, scan }) => (
    <>
      <Rail
        points={[
          [24, 160],
          [180, 160],
        ]}
      />
      <Rail
        points={[
          [24, 250],
          [180, 250],
        ]}
      />
      <Rail
        points={[
          [380, 160],
          [520, 160],
        ]}
      />
      <Rail
        points={[
          [380, 250],
          [520, 250],
        ]}
      />
      <PartBox x={520} y={130} w={80} h={150} r={12} />
      <SvgText
        x={560}
        y={296}
        runs={[["origin", 400, "dim"]]}
        size={18}
        align="center"
      />
      <PartBox x={180} y={110} w={200} h={180} />
      {rows.map((r, n) => {
        const y = 184 + r.i * 14;
        let w = r.w * 0.6;
        if (r.add != null && t < r.add) return null;
        if (r.drain)
          w *=
            1 -
            Math.min(
              1,
              Math.max(0, (t - r.drain[0]) / (r.drain[1] - r.drain[0]))
            );
        if (r.del != null && t >= r.del) w *= Math.max(0, 1 - clamp(t - r.del));
        if (w < 0.5) return null;
        return (
          <g key={n}>
            <Bar
              x={300}
              y={y}
              w={w}
              role={r.c}
              k={r.add != null ? pop(t - r.add) : 1}
              still={r.add == null}
            />
            {(r.hl ?? []).map(([a, c]) => {
              const k = windowed(t, a, a + 0.3);
              return k > 0 ? (
                <g key={a} opacity={k}>
                  <Bar x={300} y={y} w={w} role={c} still />
                </g>
              ) : null;
            })}
          </g>
        );
      })}
      {scan.map(([s0, s1]) =>
        t >= s0 && t <= s1 ? (
          <line
            key={s0}
            className="md-scan"
            x1={292}
            x2={372}
            y1={180 + 50 * smoothstep(s0, s1, t)}
            y2={180 + 50 * smoothstep(s0, s1, t)}
            stroke={roleColor("amber")}
            strokeWidth={2}
          />
        ) : null
      )}
    </>
  ),
};
