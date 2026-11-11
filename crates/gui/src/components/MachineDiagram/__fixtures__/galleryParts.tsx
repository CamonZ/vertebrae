/* eslint-disable react-refresh/only-export-components -- test and perf fixture data, never hot-reloaded UI */
/**
 * Four gallery parts ported onto the motion core, used as parity, strip and
 * performance fixtures. They follow the catalogue gallery artifact
 * (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line; the
 * reusable part components themselves belong to the component tickets.
 */
import type { ReactNode } from "react";
import type { PartIdentity } from "../accessibility";
import type { BBox } from "../ChangeMark";
import { Burst, Hole, Lamp, PartBox, Ring, Spinner } from "../fixtures";
import { lampAt, litAt, type LampStep } from "../geometry";
import { RAIL_Y as Y } from "../MachinePart";
import { held, smoothstep } from "../motion";
import { roleColor, type StateRole } from "../palette";
import { Press } from "../Press";
import { Rail } from "../Rail";
import { Glyph, SvgText } from "../SvgText";
import {
  card,
  dot,
  gateV,
  note,
  seal,
  statusAt,
  story,
  type StatusNote,
  type Timeline,
} from "../timeline";
import { StatusLine } from "../StatusLine";

export interface FixtureScenario<E> {
  readonly name: string;
  readonly still: number;
  readonly timeline: Timeline;
  readonly extra: E;
}

export interface GalleryPartFixture<E = unknown> {
  readonly part: PartIdentity;
  readonly bb: BBox;
  readonly status: { readonly x: number; readonly y: number };
  readonly scenarios: readonly [
    FixtureScenario<E>,
    FixtureScenario<E>,
    ...FixtureScenario<E>[],
  ];
  readonly draw: (t: number, extra: E) => ReactNode;
}

/* ---------- source ---------- */

function sourceStory(kind: "sends" | "no listener" | "burst"): Timeline {
  const s = story(3.6);
  if (kind === "burst") {
    for (let i = 0; i < 5; i++) {
      const a = 0.6 + 0.12 * i;
      s.cards.push(
        card(
          28,
          "amber",
          [
            [
              [
                [190, Y],
                [600, Y],
              ],
              a,
              0.7,
            ],
          ],
          a,
          a + 0.72,
          {
            tags: i === 4 ? [["5 at once", 0.75, 1.4]] : [],
          }
        )
      );
    }
    note(s, 0.6, "burst · 5 in 0.5 s", "amber");
    note(s, 1.8, "ready", "dim");
    return seal(s);
  }
  const f = kind === "no listener";
  s.cards.push(
    card(
      28,
      "amber",
      [
        [
          [
            [190, Y],
            [600, Y],
          ],
          0.6,
          0.7,
        ],
      ],
      0.6,
      1.32,
      { tags: [["request", 0.65, 1.1]] }
    )
  );
  s.cards.push(
    f
      ? card(
          28,
          "amber",
          [
            [
              [
                [190, Y],
                [380, Y],
              ],
              2.0,
              0.5,
            ],
          ],
          2.0,
          2.75,
          {
            col: [[2.5, "red"]],
            tags: [["no listener", 2.5, 3.0]],
          }
        )
      : card(
          28,
          "amber",
          [
            [
              [
                [190, Y],
                [600, Y],
              ],
              2.0,
              0.7,
            ],
          ],
          2.0,
          2.72,
          { tags: [["tick", 2.05, 2.5]] }
        )
  );
  note(s, 0.6, "send", "ink");
  note(s, 1.3, "ready", "dim");
  note(s, 2.0, f ? "dropped" : "send", f ? "red" : "ink");
  return seal(s);
}

export const sourceFixture: GalleryPartFixture<null> = {
  part: {
    name: "source",
    job: "emits work",
    aka: "person · trigger · scheduler · watcher",
  },
  bb: [110, 168, 80, 64],
  status: { x: 150, y: 262 },
  scenarios: [
    { name: "sends", still: 1.0, timeline: sourceStory("sends"), extra: null },
    {
      name: "no listener",
      still: 1.0,
      timeline: sourceStory("no listener"),
      extra: null,
    },
    { name: "burst", still: 1.25, timeline: sourceStory("burst"), extra: null },
  ],
  draw: (t) => (
    <>
      <Rail
        points={[
          [190, Y],
          [600, Y],
        ]}
      />
      <PartBox x={110} y={168} w={80} h={64} r={12} />
      <Glyph x={128} y={Y} text=">" size={26} role="ink" />
      {Math.floor(t * 4) % 2 === 0 && (
        <rect x={140} y={Y + 6} width={14} height={3} fill={roleColor("ink")} />
      )}
    </>
  ),
};

/* ---------- worker ---------- */

interface WorkerExtra {
  readonly cl: readonly [number, number];
  readonly lights: readonly number[];
  readonly crash: number | null;
}

function workerStory(
  kind: "done" | "exit 1" | "crash mid-job"
): FixtureScenario<WorkerExtra> {
  const s = story(4.6);
  const crash = kind === "crash mid-job";
  const cl: [number, number] = crash ? [1.25, 1.9] : [1.25, 2.6];
  const amber = (t: number) => held(t, cl[0], cl[1]);
  s.gates.push(gateV(210, Y, amber), gateV(430, Y, amber));
  if (crash) {
    s.cards.push(
      card(
        36,
        "ink",
        [
          [
            [
              [24, Y],
              [320, Y],
            ],
            0.6,
            0.6,
          ],
        ],
        0.6,
        2.0,
        {
          col: [[1.85, "red"]],
          tags: [["job", 0.65, 1.0]],
        }
      )
    );
    note(s, 0.6, "job arrives", "ink");
    note(s, 1.35, "working · · ·", "dim");
    note(s, 1.9, "crashed · no result", "red");
    note(s, 3.0, "caller still waiting", "amber");
    return {
      name: kind,
      still: 2.3,
      timeline: seal(s),
      extra: { cl, lights: [1.35, 1.6, 1.85], crash: 1.9 },
    };
  }
  const f = kind === "exit 1";
  s.cards.push(
    card(
      36,
      "ink",
      [
        [
          [
            [24, Y],
            [320, Y],
          ],
          0.6,
          0.6,
        ],
      ],
      0.6,
      2.75,
      { tags: [["job", 0.65, 1.0]] }
    )
  );
  s.cards.push(
    card(
      28,
      f ? "red" : "ink",
      [
        [
          [
            [320, Y],
            [616, Y],
          ],
          2.65,
          0.6,
        ],
      ],
      2.65,
      3.3,
      {
        tags: [[f ? "exit 1" : "result", 2.85, 3.25]],
      }
    )
  );
  note(s, 0.6, "job arrives", "ink");
  note(s, 1.35, "working · · ·", "dim");
  note(s, 2.65, f ? "failed · exit 1" : "done", f ? "red" : "green");
  return {
    name: kind,
    still: 1.9,
    timeline: seal(s),
    extra: { cl, lights: [1.35, 1.6, 1.85, 2.1, 2.35, 2.6], crash: null },
  };
}

export const workerFixture: GalleryPartFixture<WorkerExtra> = {
  part: {
    name: "worker",
    job: "runs one job",
    aka: "process · handler · function · model call",
  },
  bb: [210, 105, 220, 190],
  status: { x: 320, y: 328 },
  scenarios: [
    workerStory("done"),
    workerStory("exit 1"),
    workerStory("crash mid-job"),
  ],
  draw: (t, { cl, lights, crash }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [210, Y],
        ]}
      />
      <Rail
        points={[
          [430, Y],
          [616, Y],
        ]}
      />
      <PartBox x={210} y={105} w={220} h={190} />
      <Press
        cx={320}
        cy={Y}
        half={80}
        closed={held(t, cl[0], cl[1])}
        lit={litAt(lights, t, cl[1] + 0.5)}
        clampAt={cl[0]}
        t={t}
      />
      {crash != null && (
        <Burst x={320} y={Y} t={t} at={crash} role="red" r0={30} r1={110} />
      )}
    </>
  ),
};

/* ---------- splitter ---------- */

function splitterStory(f: boolean): Timeline {
  const s = story(4.2);
  s.gates.push(gateV(220, Y), gateV(400, 155), gateV(400, 245));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, Y],
            [300, Y],
          ],
          0.6,
          0.6,
        ],
      ],
      0.6,
      1.32,
      { tags: [["event", 0.65, 1.0]] }
    )
  );
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [300, Y],
            [340, Y],
            [400, 155],
            [600, 155],
          ],
          1.3,
          0.7,
        ],
      ],
      1.3,
      2.05,
      {
        tags: [["copy 1", 1.5, 2.0]],
      }
    )
  );
  s.cards.push(
    card(
      28,
      f ? "red" : "ink",
      [
        [
          [
            [300, Y],
            [340, Y],
            [400, 245],
            [600, 245],
          ],
          1.4,
          0.7,
        ],
      ],
      1.4,
      2.15,
      {
        tags: [[f ? "branch down" : "copy 2", 1.6, 2.1, 28]],
      }
    )
  );
  note(s, 0.6, "one in", "ink");
  note(s, 1.3, "copy ×2", "dim");
  note(
    s,
    2.1,
    f ? "1 of 2 delivered" : "2 of 2 delivered",
    f ? "red" : "green"
  );
  return seal(s);
}

const SPLIT_AT = 1.25;

export const splitterFixture: GalleryPartFixture<null> = {
  part: {
    name: "splitter",
    job: "copies to every branch",
    aka: "fan-out · broadcast · tee",
  },
  bb: [220, 120, 180, 160],
  status: { x: 310, y: 312 },
  scenarios: [
    {
      name: "2 of 2",
      still: 1.55,
      timeline: splitterStory(false),
      extra: null,
    },
    {
      name: "branch down",
      still: 1.55,
      timeline: splitterStory(true),
      extra: null,
    },
  ],
  draw: (t) => {
    const k =
      smoothstep(SPLIT_AT, SPLIT_AT + 0.1, t) *
      (1 - smoothstep(SPLIT_AT + 0.3, SPLIT_AT + 0.5, t));
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [220, Y],
          ]}
        />
        <Rail
          points={[
            [400, 155],
            [600, 155],
          ]}
        />
        <Rail
          points={[
            [400, 245],
            [600, 245],
          ]}
        />
        <PartBox x={220} y={120} w={180} h={160} />
        <path
          d={`M330 ${Y} L380 160 M330 ${Y} L380 240`}
          stroke={roleColor("edge")}
          strokeWidth={3}
          fill="none"
        />
        {k > 0 && (
          <circle
            cx={300}
            cy={Y}
            r={10 + 10 * k}
            fill={roleColor("plate")}
            opacity={0.6 * k}
          />
        )}
      </>
    );
  },
};

/* ---------- two-phase commit (the busiest gallery scenario) ---------- */

interface TwoPhaseExtra {
  readonly lamps: readonly (readonly LampStep[])[];
  readonly rings: readonly (readonly [number, number, StateRole])[];
  readonly phase: readonly StatusNote[];
  readonly crash: number | null;
  readonly spin: readonly [number, number] | null;
}

const PARTICIPANTS = [110, 200, 290] as const;

function twoPhaseStory(
  kind: "commits" | "one votes no · abort" | "coordinator dies · blocked"
) {
  const s = story(4.6);
  const f = kind === "one votes no · abort";
  const blocked = kind === "coordinator dies · blocked";
  const lamps: LampStep[][] = PARTICIPANTS.map(() => [[0, "off"]]);
  const rings: [number, number, StateRole][] = [];
  const phase: [number, string, StateRole][] = [[0, "idle", "dim"]];
  let crash: number | null = null;
  let spin: [number, number] | null = null;
  const out = (y: number): [number, number][] => [
    [210, 200],
    [330, 200],
    [330, y],
    [420, y],
  ];
  const back = (y: number) => out(y).slice().reverse();
  s.gates.push(gateV(70, 200));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, 200],
            [115, 200],
          ],
          0.6,
          0.5,
        ],
      ],
      0.6,
      1.2,
      { tags: [["txn 9", 0.65, 1.05]] }
    )
  );
  phase.push([1.2, "prepare", "amber"]);
  PARTICIPANTS.forEach((y, i) => {
    s.cards.push(dot(out(y), 1.2, 0.55));
    const no = f && i === 2;
    lamps[i].push([1.75, no ? "red" : "amber"]);
    s.cards.push(dot(back(y), 1.95, 0.55, no ? "red" : "ink"));
  });
  const done = (still: number): FixtureScenario<TwoPhaseExtra> => ({
    name: kind,
    still,
    timeline: seal(s),
    extra: { lamps, rings, phase, crash, spin },
  });
  if (blocked) {
    s.period = 5.0;
    crash = 2.5;
    rings.push([1.2, 2.5, "red"]);
    spin = [2.8, s.period - 0.3];
    phase.push([2.5, "?", "red"]);
    note(s, 0.6, "begin txn 9", "ink");
    note(s, 1.75, "3 prepared · locks held", "amber");
    note(s, 2.5, "coordinator crashed", "red");
    note(s, 3.1, "can't decide alone", "amber");
    note(s, 3.8, "blocked · locks held", "red");
    return done(4.0);
  }
  rings.push([1.2, 2.55, f ? "red" : "green"]);
  phase.push([2.65, f ? "abort" : "commit", f ? "red" : "green"]);
  if (f) {
    [110, 200].forEach((y, i) => {
      s.cards.push(dot(out(y), 2.7, 0.55, "red"));
      lamps[i].push([3.3, "off"]);
    });
    lamps[2].push([3.3, "off"]);
    s.cards.push(
      card(
        28,
        "red",
        [
          [
            [
              [115, 200],
              [24, 200],
            ],
            3.4,
            0.5,
          ],
        ],
        3.4,
        4.0,
        { tags: [["aborted", 3.45, 3.9]] }
      )
    );
    note(s, 0.6, "begin txn 9", "ink");
    note(s, 1.75, "p3 can't prepare", "red");
    note(s, 2.55, "one no · abort all", "red");
    note(s, 3.3, "rolled back · locks freed", "dim");
    return done(2.8);
  }
  PARTICIPANTS.forEach((y, i) => {
    s.cards.push(dot(out(y), 2.7, 0.55, "green"));
    lamps[i].push([3.3, "green"]);
  });
  s.cards.push(
    card(
      28,
      "green",
      [
        [
          [
            [115, 200],
            [24, 200],
          ],
          3.4,
          0.5,
        ],
      ],
      3.4,
      4.0,
      { tags: [["committed", 3.45, 3.9]] }
    )
  );
  note(s, 0.6, "begin txn 9", "ink");
  note(s, 1.75, "3 prepared · locks held", "amber");
  note(s, 2.55, "3 yes · commit", "green");
  note(s, 3.3, "all committed", "green");
  return done(2.0);
}

export const twoPhaseFixture: GalleryPartFixture<TwoPhaseExtra> = {
  part: {
    name: "two-phase commit",
    job: "all commit or none do",
    aka: "2PC · XA · atomic commit",
  },
  bb: [70, 84, 500, 232],
  status: { x: 320, y: 346 },
  scenarios: [
    twoPhaseStory("commits"),
    twoPhaseStory("one votes no · abort"),
    twoPhaseStory("coordinator dies · blocked"),
  ],
  draw: (t, { lamps, rings, phase, crash, spin }) => (
    <>
      <Rail
        points={[
          [24, 200],
          [70, 200],
        ]}
      />
      {PARTICIPANTS.map((y) => (
        <Rail
          key={y}
          points={[
            [210, 200],
            [330, 200],
            [330, y],
            [420, y],
          ]}
        />
      ))}
      <PartBox
        x={70}
        y={150}
        w={140}
        h={100}
        dashed={crash != null && t >= crash}
      />
      <Hole x={140} y={200} r={22} />
      {rings.map(([a, b, c], i) => (
        <Ring key={i} x={140} y={200} t={t} from={a} to={b} result={c} r={22} />
      ))}
      {crash != null && (
        <Burst x={140} y={200} t={t} at={crash} role="red" r0={22} r1={100} />
      )}
      <StatusLine status={statusAt(phase, t)} x={140} y={272} size={18} />
      {PARTICIPANTS.map((y, i) => {
        const [role, k] = lampAt(lamps[i], t);
        return (
          <g key={y}>
            <PartBox x={420} y={y - 26} w={150} h={52} r={12} />
            <Lamp x={444} y={y} r={9} role={role} k={k} />
            <SvgText
              x={474}
              y={y}
              runs={[[`p${i + 1}`, 400, "dim"]]}
              size={18}
            />
            {spin && (
              <Spinner x={444} y={y} t={t} from={spin[0]} to={spin[1]} r={15} />
            )}
          </g>
        );
      })}
    </>
  ),
};

export const GALLERY_FIXTURES = {
  source: sourceFixture,
  worker: workerFixture,
  splitter: splitterFixture,
  "two-phase commit": twoPhaseFixture,
} as const;
