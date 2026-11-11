/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism helpers */
/**
 * replay · rebuilds state from the first fact (catalogue "replay"): payload
 * tiles, a playhead and a balance bar that grows as each event is folded in.
 * A changed handler diverges from the stored value; an as-of read stops at a
 * version. Ported from the gallery line for line.
 */
import { Bar, PartBox } from "../fixtures";
import { pop, slide, track, valueAt } from "../motion";
import { roleColor, type StateRole } from "../palette";
import { SvgText } from "../SvgText";
import { note, seal, story, type StatusNote } from "../timeline";
import { Pointer, TL, Tiles, ValueNote, type TileSpec } from "./eventTiles";
import type { MachinePartDef, PartScenario } from "./types";

interface ReplayExtra {
  readonly tl: readonly TileSpec[];
  /** The playhead's tile index over time. */
  readonly ph: readonly (readonly [number, number])[];
  /** The folded value over time (bar length is 4 px per unit). */
  readonly val: readonly (readonly [number, number])[];
  readonly vn: readonly StatusNote[];
  readonly barC: readonly (readonly [number, StateRole])[];
  /** A stored value to compare against (the diverging replay). */
  readonly stored: boolean;
}

const X = (i: number) => 150 + 85 * i;

function replayStory(
  kind: "to now" | "diverges" | "as of v3"
): PartScenario<ReplayExtra> {
  const s = story(4.8);
  const asof = kind === "as of v3";
  const f = kind === "diverges";
  const amt = [50, -30, f ? 45 : 50, 10, -20];
  const lab = ["+50", "-30", "+50", "+10", "-20"];
  const tl = lab.map((l, i) => TL(X(i), 160, l, -1, [], { w: 56 }));
  const ph: [number, number][] = [[0, -0.6]];
  const val: [number, number][] = [[0, 0]];
  const vn: StatusNote[] = [[0, "0", "dim"]];
  const barC: [number, StateRole][] = [[0, "ink"]];
  const n = asof ? 3 : 5;
  let v = 0;
  for (let k = 0; k < n; k++) {
    const a = 0.9 + 0.55 * k;
    v += amt[k];
    ph.push([a, k]);
    val.push([a + 0.2, v]);
    vn.push([a + 0.2, String(v), "ink"]);
    tl[k].col.push([a, "amber"], [a + 0.45, f && k === 2 ? "red" : "ink"]);
  }
  if (asof) {
    tl[3].dimAt = 0.6;
    tl[4].dimAt = 0.6;
    note(s, 0.6, "replay up to v3", "dim");
    note(s, 2.3, "as of v3 · balance 70", "ink");
  } else if (f) {
    barC.push([3.3, "red"]);
    note(s, 0.9, "replaying from v1", "dim");
    note(s, 2.0, "v3 handler changed", "amber");
    note(s, 3.3, "replayed 55 ≠ stored 60", "red");
  } else {
    note(s, 0.9, "replaying from v1", "dim");
    note(s, 3.3, "rebuilt · balance 60", "green");
  }
  vn.push([s.period - 0.45, "0", "dim"]);
  return {
    name: kind,
    still: asof ? 2.6 : 3.6,
    timeline: seal(s),
    extra: { tl, ph, val, vn, barC, stored: f },
  };
}

export const replayMachine: MachinePartDef<ReplayExtra> = {
  part: {
    name: "replay",
    job: "rebuilds state from the first fact",
    aka: "rehydrate · time travel · audit · as-of query",
  },
  family: "event sourcing",
  footprint: "L",
  bb: [80, 110, 480, 190],
  status: { x: 320, y: 332 },
  scenarios: [
    replayStory("to now"),
    replayStory("diverges"),
    replayStory("as of v3"),
  ],
  draw: (t, { tl, ph, val, vn, barC, stored }) => {
    const w = track(val, t, pop) * 4;
    return (
      <>
        <PartBox x={80} y={110} w={480} h={190} />
        <Tiles list={tl} t={t} />
        <Pointer x={X(0) + 85 * track(ph, t, slide)} y={180} role="amber" />
        <SvgText x={120} y={222} runs={[["balance", 400, "dim"]]} size={18} />
        {w > 0.5 && (
          <Bar x={120} y={240} w={w} role={valueAt(barC, t)} h={10} />
        )}
        <ValueNote list={vn} t={t} x={548} y={245} size={18} align="right" />
        {stored && (
          <>
            <line
              x1={360}
              y1={230}
              x2={360}
              y2={260}
              stroke={roleColor("amber")}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            <SvgText
              x={360}
              y={278}
              runs={[["stored 60", 400, "dim"]]}
              size={18}
              align="center"
            />
          </>
        )}
      </>
    );
  },
};
