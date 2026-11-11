/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * lock · one holder at a time (catalogue "lock"): a latch that drops for one
 * holder; the next waits outside, gives up, or takes over when the lease
 * runs out. The deadlock scenario is two locks held crosswise. Ported from
 * the gallery line for line.
 */
import { Hole, PartBox, Ring } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { held, smoothstep } from "../motion";
import type { CardRole } from "../palette";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story, type StoryDraft } from "../timeline";
import { PlateLine } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** `[x, from, to, result]`: the holder's ring, amber while held. */
type HeldRing = readonly [number, number, number, CardRole | null];

interface LockExtra {
  /** Latch down `[from, to, from, to, …]`. */
  readonly cl: readonly number[];
  readonly rings: readonly HeldRing[];
  /** The "lease" label inside the frame (lease expires). */
  readonly lease: boolean;
  /** The waiter's give-up ring `[x, from, to]`. */
  readonly wait: readonly [number, number, number] | null;
  /** Deadlock: two locks, each held from this time (null: a single lock). */
  readonly pair: readonly [number, number] | null;
  /** Deadlock: each holder's arrow towards the other lock appears at these times. */
  readonly want: readonly [number, number] | null;
}

const SL: Point = [320, Y];
const L1: Point = [320, 135];
const L2: Point = [320, 250];

function begin(period: number): StoryDraft {
  const s = story(period);
  s.gates.push(gateV(240, Y), gateV(400, Y));
  return s;
}

function lockStory(
  kind: "handoff" | "never released" | "lease expires" | "deadlock"
): PartScenario<LockExtra> {
  if (kind === "lease expires") {
    const s = begin(5.8);
    s.cards.push(
      card(28, "ink", [[[[24, Y], SL], 0.6, 0.6]], 0.6, 2.4, {
        col: [[1.9, "red"]],
        tags: [
          ["A", 0.65, 1.0],
          ["A crashed", 1.95, 2.4],
        ],
      })
    );
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [170, Y],
            ],
            1.5,
            0.5,
          ],
          [[[170, Y], SL], 3.45, 0.5],
          [[SL, [616, Y]], 4.7, 0.6],
        ],
        1.5,
        5.35,
        {
          col: [
            [1.9, "amber"],
            [3.45, "ink"],
            [4.58, "green"],
          ],
          lean: [4.7],
          tags: [["B waiting", 2.45, 3.4]],
        }
      )
    );
    note(s, 0.6, "free", "dim");
    note(s, 1.25, "held by A", "amber");
    note(s, 1.9, "A crashed · lease running", "red");
    note(s, 3.4, "lease expired · freed", "amber");
    note(s, 3.6, "held by B", "amber");
    note(s, 4.75, "free", "dim");
    return {
      name: kind,
      still: 2.7,
      timeline: seal(s),
      extra: {
        cl: [1.25, 3.4, 3.6, 4.75],
        rings: [
          [320, 1.2, 3.4, "edge"],
          [320, 3.9, 4.7, "green"],
        ],
        lease: true,
        wait: null,
        pair: null,
        want: null,
      },
    };
  }
  if (kind === "deadlock") {
    const s = story(5.6);
    s.gates.push(gateV(250, 135), gateV(250, 250));
    s.cards.push(
      card(28, "ink", [[[[24, 135], L1], 0.6, 0.6]], 0.6, 9, {
        col: [[3.6, "red"]],
        tags: [["A", 0.65, 1.0]],
      })
    );
    s.cards.push(
      card(28, "ink", [[[[24, 250], L2], 1.0, 0.6]], 1.0, 9, {
        col: [[3.6, "red"]],
        tags: [["B", 1.05, 1.4, 28]],
      })
    );
    note(s, 0.6, "both free", "dim");
    note(s, 1.2, "A holds 1", "amber");
    note(s, 1.6, "B holds 2", "amber");
    note(s, 1.9, "A wants 2", "amber");
    note(s, 2.3, "B wants 1", "amber");
    note(s, 3.6, "deadlock · neither can move", "red");
    return {
      name: kind,
      still: 3.95,
      timeline: seal(s),
      extra: {
        cl: [],
        rings: [
          [L1[0], 1.9, 3.6, "red"],
          [L2[0], 2.3, 3.6, "red"],
        ],
        lease: false,
        wait: null,
        pair: [1.2, 1.6],
        want: [1.9, 2.3],
      },
    };
  }
  const f = kind === "never released";
  const s = begin(5.6);
  const legs: [Point[], number, number][] = [[[[24, Y], SL], 0.6, 0.6]];
  if (!f) legs.push([[SL, [616, Y]], 2.7, 0.6]);
  s.cards.push(
    card(28, "ink", legs, 0.6, f ? 4.6 : 3.35, {
      col: f ? [] : [[2.58, "green"]],
      lean: f ? [] : [2.7],
      tags: [["A", 0.65, 1.0]],
    })
  );
  const cl = [1.25, f ? 9 : 2.75];
  const rings: HeldRing[] = [[320, 1.2, f ? 4.6 : 2.7, f ? null : "green"]];
  let wait: LockExtra["wait"] = null;
  if (!f) {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [170, Y],
            ],
            1.5,
            0.5,
          ],
          [[[170, Y], SL], 2.95, 0.5],
          [[SL, [616, Y]], 4.4, 0.6],
        ],
        1.5,
        5.05,
        {
          col: [
            [1.9, "amber"],
            [2.95, "ink"],
            [4.28, "green"],
          ],
          lean: [4.4],
          tags: [["B · waiting for lock", 1.95, 2.95]],
        }
      )
    );
    rings.push([320, 3.5, 4.4, "green"]);
    cl.push(3.0, 4.45);
  } else {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [170, Y],
            ],
            1.5,
            0.5,
          ],
          [
            [
              [170, Y],
              [24, Y],
            ],
            3.9,
            0.6,
          ],
        ],
        1.5,
        4.55,
        {
          col: [
            [1.9, "amber"],
            [3.78, "red"],
          ],
          lean: [3.9],
          tags: [
            ["B · waiting for lock", 1.95, 3.8],
            ["gave up", 4.0, 4.5],
          ],
        }
      )
    );
    wait = [170, 2.0, 3.9];
  }
  note(s, 0.6, "free", "dim");
  note(s, 1.25, "held by A", "amber");
  note(s, 1.9, "B waiting", "amber");
  if (f) note(s, 3.9, "B gave up · A never released", "red");
  else {
    note(s, 2.75, "released", "green");
    note(s, 3.0, "held by B", "amber");
    note(s, 4.45, "free", "dim");
  }
  return {
    name: kind,
    still: 2.1,
    timeline: seal(s),
    extra: { cl, rings, lease: false, wait, pair: null, want: null },
  };
}

/** The latch's mount and stem: an edge-grey bar above the plate, joined to it by a stem. */
function Latch({
  x,
  top,
  w,
  y,
}: {
  x: number;
  top: number;
  w: number;
  y: number;
}) {
  return (
    <>
      <rect
        x={x - w / 2}
        y={top}
        width={w}
        height={8}
        rx={3}
        fill={roleColor("edge")}
      />
      <PlateLine x1={x} y1={top + 8} x2={x} y2={y - 20} />
    </>
  );
}

/** A dashed amber arrow growing from `y0` to `y1` at `x`. */
function Want({
  x,
  y0,
  y1,
  at,
  t,
}: {
  x: number;
  y0: number;
  y1: number;
  at: number;
  t: number;
}) {
  const { fade } = usePart();
  const k = smoothstep(at, at + 0.3, t) * fade;
  if (k <= 0) return null;
  const y = y0 + (y1 - y0) * k;
  const d = Math.sign(y1 - y0);
  return (
    <g opacity={k} className="md-want">
      <line
        x1={x}
        y1={y0}
        x2={x}
        y2={y}
        stroke={roleColor("amber")}
        strokeWidth={2.5}
        strokeDasharray="5 5"
        strokeLinecap="round"
      />
      <path
        d={`M${x - 6} ${y - d * 8} L${x} ${y} L${x + 6} ${y - d * 8}`}
        fill="none"
        stroke={roleColor("amber")}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

function LockPair({ t, extra }: { t: number; extra: LockExtra }) {
  const { pair, want, rings } = extra;
  if (!pair || !want) return null;
  return (
    <>
      {(
        [
          [135, "lock 1", pair[0]],
          [250, "lock 2", pair[1]],
        ] as const
      ).map(([cy, name, closed]) => {
        const y = cy - 40 + 22 * held(t, closed, 99);
        return (
          <g key={cy}>
            <Rail
              points={[
                [24, cy],
                [250, cy],
              ]}
            />
            <PartBox x={250} y={cy - 40} w={140} h={80} r={14} />
            <Hole x={320} y={cy} r={22} />
            <SvgText x={402} y={cy} runs={[[name, 400, "dim"]]} size={18} />
            <rect
              x={262}
              y={cy - 62}
              width={24}
              height={8}
              rx={3}
              fill={roleColor("edge")}
            />
            <PlateLine x1={274} y1={cy - 54} x2={274} y2={y - 14} />
            <rect
              x={269}
              y={y - 14}
              width={10}
              height={30}
              fill={roleColor("plate")}
            />
          </g>
        );
      })}
      {rings.map(([x, a, b, c], i) => (
        <Ring
          key={i}
          x={x}
          y={i ? L2[1] : L1[1]}
          t={t}
          from={a}
          to={b}
          result={c}
          r={22}
        />
      ))}
      <Want x={352} y0={160} y1={224} at={want[0]} t={t} />
      <Want x={288} y0={225} y1={161} at={want[1]} t={t} />
    </>
  );
}

export const lockMachine: MachinePartDef<LockExtra> = {
  part: {
    name: "lock",
    job: "one holder at a time",
    aka: "mutex · lease · advisory lock · claim",
  },
  family: "data and state",
  footprint: "S",
  bb: [240, 130, 160, 140],
  status: { x: 320, y: 304 },
  scenarios: [
    lockStory("handoff"),
    lockStory("never released"),
    lockStory("lease expires"),
    lockStory("deadlock"),
  ],
  draw: (t, extra) => {
    if (extra.pair) return <LockPair t={t} extra={extra} />;
    const { cl, rings, lease, wait } = extra;
    let k = 0;
    for (let i = 0; i < cl.length; i += 2)
      k = Math.max(k, held(t, cl[i], cl[i + 1]));
    const y = Y - 62 + 62 * k;
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [240, Y],
          ]}
        />
        <Rail
          points={[
            [400, Y],
            [616, Y],
          ]}
        />
        <PartBox x={240} y={130} w={160} h={140} />
        <Hole x={320} y={Y} />
        {lease && (
          <SvgText
            x={320}
            y={158}
            runs={[["lease", 400, "dim"]]}
            size={18}
            align="center"
          />
        )}
        {rings.map(([x, a, b, c], i) => (
          <Ring key={i} x={x} y={Y} t={t} from={a} to={b} result={c} />
        ))}
        {wait && (
          <Ring
            x={wait[0]}
            y={Y}
            t={t}
            from={wait[1]}
            to={wait[2]}
            result="red"
            r={20}
          />
        )}
        <Latch x={229} top={104} w={30} y={y} />
        <rect
          x={224}
          y={y - 20}
          width={10}
          height={40}
          fill={roleColor("plate")}
        />
      </>
    );
  },
};
