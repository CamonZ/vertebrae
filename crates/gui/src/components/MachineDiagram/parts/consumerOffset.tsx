/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism helpers */
/**
 * consumer offset · remembers how far it read (catalogue "consumer offset"): a
 * tape of log tiles coloured by processed / committed, a read pointer and a
 * consumer. Committing before processing loses events; crashing before the
 * commit processes them twice. Ported from the gallery line for line.
 */
import { Burst, Hole, PartBox, Ring } from "../fixtures";
import { slide, track } from "../motion";
import type { CardRole, StateRole } from "../palette";
import { SvgText } from "../SvgText";
import { dot, note, seal, story, type StatusNote } from "../timeline";
import { Pointer, TL, Tiles, ValueNote, type TileSpec } from "./eventTiles";
import type { MachinePartDef, PartScenario } from "./types";

interface ConsumerOffsetExtra {
  readonly tl: readonly TileSpec[];
  readonly rings: readonly (readonly [number, number, StateRole])[];
  /** The read pointer's position (tile index + 1) over time. */
  readonly ptr: readonly (readonly [number, number])[];
  /** The committed line over time. */
  readonly cm: readonly StatusNote[];
  readonly crash: number | null;
}

const X = (i: number) => 130 + 48 * i;
const CN = [320, 270] as const;

function consumerOffsetStory(
  kind: "commit after process" | "crash before commit" | "commit before process"
): PartScenario<ConsumerOffsetExtra> {
  const s = story(5.2);
  const lost = kind === "commit before process";
  const f = kind === "crash before commit";
  const tl: TileSpec[] = [];
  const rings: [number, number, StateRole][] = [];
  const ptr: [number, number][] = [[0, 3]];
  const cm: StatusNote[] = [[0, "#3", "ink"]];
  let crash: number | null = null;
  for (let i = 0; i < 8; i++)
    tl.push(TL(X(i), 140, String(i + 1), -1, i < 3 ? [[-1e8, "green"]] : []));
  const read = (i: number, a: number, c: CardRole = "ink", done = true) => {
    ptr.push([a, i + 1]);
    tl[i].col.push([a - 0.05, "amber"]);
    s.cards.push(
      dot(
        [
          [X(i), 156],
          [CN[0], CN[1]],
        ],
        a,
        0.45,
        c,
        { dies: a + (done ? 0.75 : 0.85), col: done ? [] : [[a + 0.7, "red"]] }
      )
    );
    if (done) {
      rings.push([a + 0.45, a + 0.7, "green"]);
      tl[i].col.push([a + 0.7, "ink"]);
    }
  };
  const commit = (a: number, n: number, from = 3) => {
    for (let i = from; i < n; i++)
      tl[i].col.push([a + 0.05 * (i - 3), "green"]);
    cm.push([a, `#${n}`, "green"]);
  };
  let still = 3.3;
  if (lost) {
    s.period = 5.0;
    commit(0.7, 5);
    read(3, 1.2, "ink", false);
    crash = 1.95;
    ptr.push([2.6, 5]);
    tl[3].col.push([2.7, "red"]);
    tl[4].col.push([2.75, "red"]);
    read(5, 2.9);
    commit(3.8, 6, 5);
    note(s, 0.7, "commit #5 first", "amber");
    note(s, 1.2, "read #4", "dim");
    note(s, 1.95, "crashed mid #4", "red");
    note(s, 2.6, "restart after #5", "amber");
    note(s, 2.9, "#4 #5 never processed", "red");
    still = 3.2;
  } else if (f) {
    s.period = 5.6;
    read(3, 0.7);
    read(4, 1.3);
    crash = 2.2;
    ptr.push([2.4, 3]);
    tl[3].col.push([2.3, "edge"]);
    tl[4].col.push([2.3, "edge"]);
    read(3, 2.9, "amber");
    read(4, 3.5, "amber");
    commit(4.4, 5);
    note(s, 0.7, "read #4", "dim");
    note(s, 2.2, "crashed · committed #3", "red");
    note(s, 2.9, "restart from #4", "amber");
    note(s, 4.4, "#4 #5 processed twice", "amber");
  } else {
    read(3, 0.7);
    read(4, 1.3);
    read(5, 1.9);
    commit(2.8, 6);
    note(s, 0.7, "read #4", "dim");
    note(s, 1.3, "read #5", "dim");
    note(s, 1.9, "read #6", "dim");
    note(s, 2.8, "commit #6", "green");
  }
  return {
    name: kind,
    still,
    timeline: seal(s),
    extra: { tl, rings, ptr, cm, crash },
  };
}

export const consumerOffsetMachine: MachinePartDef<ConsumerOffsetExtra> = {
  part: {
    name: "consumer offset",
    job: "remembers how far it read",
    aka: "cursor · checkpoint · position · commit",
  },
  family: "event sourcing",
  footprint: "L",
  bb: [100, 105, 440, 200],
  status: { x: 320, y: 340 },
  scenarios: [
    consumerOffsetStory("commit after process"),
    consumerOffsetStory("crash before commit"),
    consumerOffsetStory("commit before process"),
  ],
  draw: (t, { tl, rings, ptr, cm, crash }) => (
    <>
      <PartBox x={100} y={105} w={440} h={200} />
      <Tiles list={tl} t={t} />
      <Pointer
        x={X(0) + 48 * track(ptr, t, slide)}
        y={160}
        role={crash != null && t >= crash && t < crash + 0.7 ? "red" : "amber"}
      />
      <PartBox x={270} y={240} w={100} h={60} r={12} />
      <Hole x={CN[0]} y={CN[1]} r={18} />
      <SvgText x={384} y={CN[1]} runs={[["consumer", 400, "dim"]]} size={18} />
      {rings.map(([from, to, result], i) => (
        <Ring
          key={i}
          x={CN[0]}
          y={CN[1]}
          t={t}
          from={from}
          to={to}
          result={result}
          r={18}
        />
      ))}
      {crash != null && (
        <Burst
          x={CN[0]}
          y={CN[1]}
          t={t}
          at={crash}
          role="red"
          r0={18}
          r1={70}
        />
      )}
      <SvgText x={100} y={84} runs={[["committed", 400, "dim"]]} size={18} />
      <ValueNote list={cm} t={t} x={540} y={84} size={18} align="right" />
    </>
  ),
};
