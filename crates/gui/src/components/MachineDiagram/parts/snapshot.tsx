/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism helpers */
/**
 * snapshot · skips the replay (catalogue "snapshot"): a tape of event tiles, a
 * snapshot bracket over the first ones and a state hole the tail is folded
 * into. An unreadable snapshot forces the slow full replay. Ported from the
 * gallery line for line.
 */
import { Hole, PartBox, Ring } from "../fixtures";
import { pop, smoothstep, valueAt } from "../motion";
import type { StateRole } from "../palette";
import { usePart } from "../partContext";
import { card, dot, note, seal, story, type StatusNote } from "../timeline";
import { SvgText } from "../SvgText";
import { Bar } from "../fixtures";
import { TL, Tiles, ValueNote, type TileSpec } from "./eventTiles";
import type { MachinePartDef, PartScenario } from "./types";

/** A snapshot bracket over tiles 1..n. */
interface Bracket {
  readonly n: number;
  /** Springs in at this time; `-1` is already there. */
  readonly at: number;
  readonly col: readonly (readonly [number, StateRole])[];
  /** Fades out from this time. */
  readonly gone?: number;
}

interface SnapshotExtra {
  readonly tl: readonly TileSpec[];
  readonly rings: readonly (readonly [number, number, StateRole])[];
  readonly br: readonly Bracket[];
  readonly st: readonly StatusNote[];
}

const X = (i: number) => 146 + 44 * i;
const HOLE = [320, 262] as const;

function snapshotStory(
  kind: "snapshot + tail" | "snapshot unreadable" | "take snapshot"
): PartScenario<SnapshotExtra> {
  const s = story(5.0);
  const tl: TileSpec[] = [];
  const rings: [number, number, StateRole][] = [];
  const br: Bracket[] = [];
  const st: StatusNote[] = [[0, "state · empty", "dim"]];
  for (let i = 0; i < 8; i++) tl.push(TL(X(i), 135, String(i + 1)));
  const ev = (i: number, a: number, d = 0.5) => {
    tl[i].col.push([a - 0.05, "amber"], [a + 0.4, "edge"]);
    s.cards.push(
      dot(
        [
          [X(i), 150],
          [HOLE[0], HOLE[1]],
        ],
        a,
        d,
        "ink"
      )
    );
  };
  const snap = (
    n: number,
    a: number,
    c: "ink" | "red" = "ink",
    col: readonly (readonly [number, "red"])[] = []
  ) => {
    const mid = (128 + X(n - 1) + 18) / 2;
    s.cards.push(
      card(
        28,
        c,
        [
          [
            [
              [mid, 168],
              [HOLE[0], HOLE[1]],
            ],
            a,
            0.6,
          ],
        ],
        a,
        a + 0.65,
        { col }
      )
    );
  };
  let still = 2.6;
  if (kind === "take snapshot") {
    s.period = 5.0;
    br.push({ n: 4, at: -1, col: [[-1e9, "ink"]], gone: 3.6 });
    snap(4, 0.6);
    [4, 5, 6, 7].forEach((i, k) => ev(i, 1.3 + 0.35 * k));
    rings.push([0.9, 2.85, "green"]);
    st.push([1.25, "state · v4", "ink"], [2.85, "state · v8", "ink"]);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [HOLE[0], HOLE[1]],
              [300, 172],
            ],
            3.0,
            0.5,
          ],
        ],
        3.0,
        3.55
      )
    );
    br.push({
      n: 8,
      at: 3.55,
      col: [
        [-1e9, "green"],
        [4.3, "ink"],
      ],
    });
    note(s, 0.6, "load snapshot v4", "ink");
    note(s, 1.3, "+ 4 events", "dim");
    note(s, 2.85, "4 since snapshot · take one", "amber");
    note(s, 3.6, "snapshot v8 saved", "green");
    still = 3.3;
  } else if (kind === "snapshot unreadable") {
    s.period = 5.8;
    br.push({
      n: 6,
      at: -1,
      col: [
        [-1e9, "ink"],
        [1.15, "red"],
      ],
    });
    snap(6, 0.6, "ink", [[1.1, "red"]]);
    rings.push([0.9, 1.25, "red"]);
    for (let i = 0; i < 8; i++) ev(i, 1.6 + 0.3 * i, 0.45);
    rings.push([1.9, 4.15, "green"]);
    st.push([4.15, "state · v8", "ink"]);
    note(s, 0.6, "load snapshot v6", "ink");
    note(s, 1.25, "snapshot unreadable", "red");
    note(s, 1.7, "full replay · 8 events", "amber");
    note(s, 4.2, "state at v8 · slow path", "ink");
    still = 4.5;
  } else {
    br.push({ n: 6, at: -1, col: [[-1e9, "ink"]] });
    snap(6, 0.6);
    ev(6, 1.4);
    ev(7, 1.9);
    rings.push([0.9, 2.45, "green"]);
    st.push(
      [1.25, "state · v6", "ink"],
      [1.95, "state · v7", "ink"],
      [2.45, "state · v8", "ink"]
    );
    note(s, 0.6, "load snapshot v6", "ink");
    note(s, 1.4, "+ 2 events", "dim");
    note(s, 2.45, "state at v8 · read 2, not 8", "green");
  }
  return {
    name: kind,
    still,
    timeline: seal(s),
    extra: { tl, rings, br, st },
  };
}

function Bracket({ b, t }: { b: Bracket; t: number }) {
  const { fade } = usePart();
  if (b.at >= 0 && t < b.at) return null;
  const a =
    (b.gone != null ? 1 - smoothstep(b.gone, b.gone + 0.25, t) : 1) * fade;
  if (a <= 0) return null;
  const w =
    (X(b.n - 1) + 18 - 128) * (b.at >= 0 ? Math.min(1.1, pop(t - b.at)) : 1);
  const c = valueAt(b.col, t);
  return (
    <g opacity={a < 1 ? a : undefined}>
      <Bar x={128} y={155} w={w} role={c} h={6} still />
      <SvgText
        x={128 + w / 2}
        y={180}
        runs={[[`snapshot v${b.n}`, 400, c === "ink" ? "dim" : c]]}
        size={18}
        align="center"
      />
    </g>
  );
}

export const snapshotMachine: MachinePartDef<SnapshotExtra> = {
  part: {
    name: "snapshot",
    job: "skips the replay",
    aka: "memento · checkpoint · materialized state",
  },
  family: "event sourcing",
  footprint: "L",
  bb: [100, 95, 440, 215],
  status: { x: 320, y: 340 },
  scenarios: [
    snapshotStory("snapshot + tail"),
    snapshotStory("snapshot unreadable"),
    snapshotStory("take snapshot"),
  ],
  draw: (t, { tl, rings, br, st }) => (
    <>
      <PartBox x={100} y={95} w={440} h={215} />
      <Tiles list={tl} t={t} />
      <Hole x={HOLE[0]} y={HOLE[1]} />
      {rings.map(([from, to, result], i) => (
        <Ring
          key={i}
          x={HOLE[0]}
          y={HOLE[1]}
          t={t}
          from={from}
          to={to}
          result={result}
        />
      ))}
      {br.map((b, i) => (
        <Bracket key={i} b={b} t={t} />
      ))}
      <ValueNote list={st} t={t} x={356} y={262} size={18} align="left" />
    </>
  ),
};
