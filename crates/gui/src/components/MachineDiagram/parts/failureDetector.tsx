import { Burst, Hole, PartBox } from "../fixtures";
import type { LampStep } from "../geometry";
import { windowed } from "../motion";
import { type CardRole } from "../palette";
import { Rail } from "../Rail";
import {
  dot,
  gateV,
  note,
  seal,
  story,
  type StatusNote,
  type StoryDraft,
} from "../timeline";
import { Fuse, NodeLamp, Readout } from "./distributedFixtures";
import { FadedText } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
export interface FailureDetectorExtra {
  beats: number[];
  node: LampStep[];
  vd: StatusNote[];
  vl: LampStep[];
  crash: number | null;
  pause: [number, number] | null;
}
const NAMES = [
  "alive",
  "missed beats · declared dead",
  "slow, not dead · false suspicion",
] as const;
const STILLS = [3.4, 3.5, 4.2];
function failureDetectorStory(
  index: number
): PartScenario<FailureDetectorExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & FailureDetectorExtra = Object.assign(story(4.8), {
      beats: [],
      node: [],
      vd: [],
      vl: [],
      crash: null,
      pause: null,
    } as FailureDetectorExtra),
    slow = s === "slow, not dead · false suspicion";
  const done = (): PartScenario<FailureDetectorExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push(gateV(200, 200), gateV(400, 200));
  S.beats = [];
  S.node = [[0, "green"]];
  S.vd = [[0, "alive", "green"]];
  S.vl = [[0, "green"]];
  S.crash = null;
  const beat = (a: number, c: CardRole = "ink") => {
    S.cards.push(
      dot(
        [
          [157, 200],
          [426, 200],
        ],
        a,
        0.45,
        c
      )
    );
    S.beats.push(a + 0.45);
  };
  if (!f && !slow) {
    [0.6, 1.3, 2.0, 2.7, 3.4, 4.1].forEach((a) => beat(a));
    note(S, 0.6, "heartbeat every 0.7 s", "dim");
    note(S, 1.1, "alive · timer resets", "green");
    return done();
  }
  beat(0.6);
  beat(1.3);
  S.vd.push([2.45, "suspect", "amber"]);
  S.vl.push([2.45, "amber"]);
  S.vd.push([3.15, "dead", "red"]);
  S.vl.push([3.15, "red"]);
  if (f) {
    S.crash = 1.6;
    S.node.push([1.6, "red"]);
    note(S, 0.6, "heartbeat every 0.7 s", "dim");
    note(S, 2.45, "0.7 s silent · suspect", "amber");
    note(S, 3.15, "1.4 s silent · declared dead", "red");
    return done();
  }
  S.period = 5.4;
  S.node.push([1.6, "amber"], [3.5, "green"]);
  S.pause = [1.6, 3.5];
  beat(3.5, "amber");
  S.vd.push([3.95, "alive?", "amber"]);
  S.vl.push([3.95, "amber"]);
  note(S, 0.6, "heartbeat every 0.7 s", "dim");
  note(S, 1.6, "node pauses", "amber");
  note(S, 3.15, "declared dead", "red");
  note(S, 3.95, "late beat · false positive", "amber");
  return done();
}
export const failureDetectorMachine: MachinePartDef<FailureDetectorExtra> = {
  part: {
    name: "failure detector",
    job: "decides who is dead",
    aka: "heartbeat \u00b7 phi accrual \u00b7 liveness probe",
  },
  family: "distributed systems",
  footprint: "L",
  bb: [70, 130, 520, 140],
  status: { x: 320, y: 330 },
  scenarios: [
    failureDetectorStory(0),
    failureDetectorStory(1),
    failureDetectorStory(2),
  ],
  draw: (t, S) => (
    <>
      <Rail
        points={[
          [200, 200],
          [400, 200],
        ]}
      />
      <PartBox x={70} y={150} w={130} h={100} />
      <NodeLamp x={135} y={200} r={20} steps={S.node} t={t} />
      <FadedText
        x={135}
        y={272}
        runs={[["node", 400, "dim"]]}
        size={18}
        align="center"
      />
      {S.crash != null && (
        <Burst x={135} y={200} t={t} at={S.crash} role="red" r0={20} r1={90} />
      )}
      {S.pause && (
        <FadedText
          x={135}
          y={128}
          runs={[["GC pause", 600, "amber"]]}
          size={18}
          align="center"
          opacity={windowed(t, ...S.pause)}
        />
      )}
      <PartBox x={400} y={130} w={190} h={140} />
      <Hole x={450} y={200} r={24} />
      <Fuse
        x={450}
        y={200}
        r={24}
        beats={S.beats}
        timeout={1.4}
        t={t}
        start={-0.2}
      />
      <FadedText
        x={495}
        y={292}
        runs={[["monitor", 400, "dim"]]}
        size={18}
        align="center"
      />
      <NodeLamp x={506} y={172} r={9} steps={S.vl} t={t} />
      <Readout steps={S.vd} t={t} x={492} y={214} />
    </>
  ),
};
