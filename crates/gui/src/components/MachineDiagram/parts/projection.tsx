/**
 * projection · folds events into a read model (catalogue "projection"): a
 * handler hole, read-model bars and a checkpoint line. A handler that throws
 * stops the checkpoint; a rebuild wipes the model and replays from #0. Ported
 * from the gallery line for line.
 */
import { Bar, Hole, PartBox, Ring } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { pop, track, windowed } from "../motion";
import type { StateRole } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story, type StatusNote } from "../timeline";
import { ValueNote } from "./eventTiles";
import type { MachinePartDef, PartScenario } from "./types";

interface ProjectionExtra {
  readonly rings: readonly (readonly [number, number, StateRole])[];
  /** Per read-model row: `[time, width]` springs. */
  readonly rows: readonly (readonly (readonly [number, number])[])[];
  /** `[row, time]` amber highlights when a row is updated. */
  readonly hl: readonly (readonly [number, number])[];
  /** The checkpoint line over time. */
  readonly ck: readonly StatusNote[];
}

function projectionStory(
  kind: "catches up" | "handler throws" | "rebuild"
): PartScenario<ProjectionExtra> {
  const s = story(5.2);
  s.gates.push(gateV(200, Y));
  const rings: [number, number, StateRole][] = [];
  const rows: [number, number][][] = [
    [[0, 120]],
    [[0, 80]],
    [[0, 150]],
    [[0, 60]],
  ];
  const hl: [number, number][] = [];
  const ck: StatusNote[] = [[0, "#3", "ink"]];
  const ev = (
    a: number,
    n: number,
    row: number,
    w: number,
    res: StateRole = "green",
    d = 0.55,
    hold = 0.45
  ) => {
    const r = a + d + 0.05;
    const stuck = res === "red";
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [260, Y],
            ],
            a,
            d,
          ],
        ],
        a,
        stuck ? s.period : r + hold + 0.05,
        {
          col: stuck ? [[r + hold - 0.12, "red"]] : [],
          tags: [[`#${n}`, a + 0.05, a + Math.min(0.4, d - 0.1)]],
        }
      )
    );
    rings.push([r, r + hold, res]);
    if (!stuck) {
      rows[row].push([r + hold, w]);
      hl.push([row, r + hold]);
      ck.push([r + hold, `#${n}`, "ink"]);
    }
  };
  let still = 2.2;
  if (kind === "rebuild") {
    s.period = 5.6;
    rows.forEach((l) => l.push([0.6, 0]));
    ck.push([0.6, "#0", "amber"]);
    (
      [
        [0, 60],
        [1, 80],
        [2, 150],
        [3, 60],
        [0, 120],
        [1, 100],
      ] as const
    ).forEach(([row, w], k) =>
      ev(1.1 + 0.38 * k, k + 1, row, w, "green", 0.4, 0.2)
    );
    note(s, 0.6, "wiped · replay from #0", "amber");
    note(s, 1.6, "rebuilding · · ·", "dim");
    note(s, 3.6, "rebuilt · #6", "green");
    still = 2.0;
  } else {
    ev(0.6, 4, 1, 110);
    if (kind === "handler throws") {
      ev(1.6, 5, 0, 0, "red");
      s.cards.push(
        card(
          28,
          "ink",
          [
            [
              [
                [24, Y],
                [140, Y],
              ],
              2.4,
              0.5,
            ],
          ],
          2.4,
          s.period,
          {
            col: [[2.95, "amber"]],
            tags: [
              ["#6", 2.45, 2.8],
              ["waiting", 3.2, 4.5],
            ],
          }
        )
      );
      note(s, 0.6, "lag 3", "amber");
      note(s, 1.6, "#4 applied", "ink");
      note(s, 2.6, "stuck at #4 · #5 throws", "red");
      note(s, 3.4, "lag 2 · growing", "amber");
      still = 3.6;
    } else {
      ev(1.5, 5, 0, 150);
      ev(2.4, 6, 3, 95);
      note(s, 0.6, "lag 3", "amber");
      note(s, 1.6, "#4 applied", "ink");
      note(s, 2.5, "#5 applied", "ink");
      note(s, 3.4, "caught up · #6", "green");
    }
  }
  return {
    name: kind,
    still,
    timeline: seal(s),
    extra: { rings, rows, hl, ck },
  };
}

export const projectionMachine: MachinePartDef<ProjectionExtra> = {
  part: {
    name: "projection",
    job: "folds events into a read model",
    aka: "read model · view · denormalizer · query side",
  },
  family: "event sourcing",
  footprint: "L",
  bb: [200, 110, 370, 180],
  status: { x: 385, y: 322 },
  scenarios: [
    projectionStory("catches up"),
    projectionStory("handler throws"),
    projectionStory("rebuild"),
  ],
  draw: (t, { rings, rows, hl, ck }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [200, Y],
        ]}
      />
      <PartBox x={200} y={110} w={370} h={180} />
      <Hole x={260} y={Y} />
      <SvgText
        x={260}
        y={244}
        runs={[["handler", 400, "dim"]]}
        size={18}
        align="center"
      />
      {rings.map(([from, to, result], i) => (
        <Ring key={i} x={260} y={Y} t={t} from={from} to={to} result={result} />
      ))}
      <SvgText x={340} y={134} runs={[["read model", 400, "dim"]]} size={18} />
      {rows.map((list, i) => {
        const w = track(list, t, pop);
        if (w <= 0.5) return null;
        let hk = 0;
        for (const [r, a] of hl)
          if (r === i) hk = Math.max(hk, windowed(t, a, a + 0.3));
        const y = 158 + 26 * i;
        return (
          <g key={i}>
            <Bar x={340} y={y} w={w} role="ink" h={9} />
            {hk > 0 && (
              <g opacity={hk}>
                <Bar x={340} y={y} w={w} role="amber" h={9} />
              </g>
            )}
          </g>
        );
      })}
      <SvgText x={200} y={84} runs={[["checkpoint", 400, "dim"]]} size={18} />
      <ValueNote list={ck} t={t} x={570} y={84} size={18} align="right" />
    </>
  ),
};
