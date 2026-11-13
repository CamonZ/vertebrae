import { Bar, Hole, PartBox, Ring } from "../fixtures";
import { valueAt, windowed } from "../motion";
import { roleColor } from "../palette";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { card, gateV, note, seal, story, type StoryDraft } from "../timeline";
import { NodeLamp, Readout } from "./distributedFixtures";
import { FadedText } from "./draw";
import { fencingTokenSpec, type FencingTokenExtra } from "./fencingTokenSpec";
import type { MachinePartDef, PartScenario } from "./types";

export type { FencingTokenExtra } from "./fencingTokenSpec";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
const NAMES = [
  "accepted",
  "zombie · stale token rejected",
  "no fencing · both write",
] as const;
const STILLS = [2.1, 4.3, 4.0];
function fencingTokenStory(index: number): PartScenario<FencingTokenExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & FencingTokenExtra = Object.assign(story(4.4), {
      tok: [],
      cl: [],
      max: [],
      rings: [],
      data: [],
      nocheck: false,
      pause: null,
    } as FencingTokenExtra),
    nof = s === "no fencing · both write";
  const done = (): PartScenario<FencingTokenExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push(gateV(380, 225));
  S.tok = [[[0, "A · 33", "dim"]], [[0, "B", "dim"]]];
  S.cl = [[[0, "green"]], [[0, "off"]]];
  S.max = [[0, "33", "ink"]];
  S.rings = [];
  S.data = [[0, "ink"]];
  S.nocheck = nof;
  S.pause = null;
  const RA: Point[] = [
      [160, 200],
      [330, 200],
      [330, 225],
      [440, 225],
    ],
    RB: Point[] = [
      [160, 280],
      [330, 280],
      [330, 225],
      [440, 225],
    ];
  if (f || nof) {
    S.period = 5.6;
    S.cl[0].push([0.6, "amber"]);
    S.pause = [0.6, 2.8];
    S.tok[1].push([1.2, "B · 34", "ink"]);
    S.cl[1].push([1.2, "green"]);
    S.cards.push(
      card(28, "ink", [[RB, 1.45, 0.7]], 1.45, 2.2, {
        tags: [["34", 1.5, 1.95]],
      })
    );
    S.rings.push([2.1, 2.4, "green"]);
    S.max.push([2.4, "34", "ink"]);
    S.data.push([2.4, "ink"]);
    S.cl[0].push([2.8, "green"]);
    if (f) {
      S.cards.push(
        card(
          28,
          "ink",
          [
            [RA, 2.95, 0.7],
            [RA.slice().reverse(), 3.95, 0.7],
          ],
          2.95,
          4.75,
          {
            col: [[3.85, "red"]],
            lean: [3.95],
            tags: [
              ["33", 3.0, 3.45],
              ["33 < 34", 4.0, 4.6],
            ],
          }
        )
      );
      S.rings.push([3.6, 3.9, "red"]);
      note(S, 0.6, "A pauses · holds 33", "amber");
      note(S, 1.2, "lease expired · B gets 34", "dim");
      note(S, 2.4, "B writes · max 34", "green");
      note(S, 2.95, "A wakes · writes with 33", "amber");
      note(S, 3.9, "rejected · 33 < 34", "red");
      return done();
    }
    S.cards.push(
      card(28, "ink", [[RA, 2.95, 0.7]], 2.95, 3.75, {
        tags: [["33", 3.0, 3.45]],
      })
    );
    S.data.push([3.7, "red"]);
    note(S, 0.6, "A pauses · holds 33", "amber");
    note(S, 1.2, "lease expired · B gets 34", "dim");
    note(S, 2.4, "B writes", "green");
    note(S, 2.95, "A wakes · writes too", "amber");
    note(S, 3.7, "no check · A overwrote B", "red");
    return done();
  }
  S.tok[0] = [[0, "A", "dim"]];
  S.cl[0] = [[0, "off"]];
  S.tok[1].push([0.6, "B · 34", "ink"]);
  S.cl[1].push([0.6, "green"]);
  S.cards.push(
    card(28, "ink", [[RB, 0.9, 0.7]], 0.9, 1.65, { tags: [["34", 0.95, 1.4]] })
  );
  S.rings.push([1.55, 1.95, "green"]);
  S.max.push([1.95, "34", "ink"]);
  S.data.push([1.95, "green"]);
  note(S, 0.6, "B holds lease · token 34", "ink");
  note(S, 0.9, "write with 34", "dim");
  note(S, 1.95, "34 ≥ 33 · accepted", "green");
  return done();
}

export const fencingTokenMachine: MachinePartDef<FencingTokenExtra> = {
  part: {
    name: "fencing token",
    job: fencingTokenSpec.job,
    aka: "epoch \u00b7 generation \u00b7 term check",
  },
  family: "distributed systems",
  footprint: "L",
  bb: fencingTokenSpec.bb,
  status: fencingTokenSpec.status,
  scenarios: [fencingTokenStory(0), fencingTokenStory(1), fencingTokenStory(2)],
  draw: (t, S) => (
    <>
      <Rail
        points={[
          [160, 200],
          [330, 200],
          [330, 225],
          [380, 225],
        ]}
      />
      <Rail
        points={[
          [160, 280],
          [330, 280],
          [330, 225],
        ]}
      />
      {[200, 280].map((y, i) => (
        <g key={y}>
          <PartBox x={40} y={y - 28} w={120} h={56} r={12} />
          <NodeLamp x={62} y={y} r={8} steps={S.cl[i]} t={t} />
          <Readout steps={S.tok[i]} t={t} x={78} y={y} />
        </g>
      ))}
      {S.pause && (
        <FadedText
          x={100}
          y={146}
          runs={[["paused", 600, "amber"]]}
          size={18}
          align="center"
          opacity={windowed(t, ...S.pause)}
        />
      )}
      <PartBox x={380} y={150} w={210} h={150} />
      {S.nocheck ? (
        <circle
          cx={440}
          cy={225}
          r={22}
          fill="none"
          stroke={roleColor("rail")}
          strokeWidth={2}
          strokeDasharray="4 5"
        />
      ) : (
        <Hole x={440} y={225} r={22} />
      )}
      {S.rings.map(([a, b, c], i) => (
        <Ring key={i} x={440} y={225} from={a} to={b} result={c} t={t} r={22} />
      ))}
      <FadedText
        x={440}
        y={270}
        runs={[[S.nocheck ? "no check" : "check", 400, "dim"]]}
        size={18}
        align="center"
      />
      <FadedText x={484} y={190} runs={[["max seen", 400, "dim"]]} size={18} />
      <Readout steps={S.max} t={t} x={484} y={222} size={20} />
      <Bar x={484} y={252} w={80} h={9} role={valueAt(S.data, t)} />
    </>
  ),
};
