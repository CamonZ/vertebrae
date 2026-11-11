/**
 * worker · runs one job (catalogue "worker"): the press, mounts with six
 * lights and plates on stems that clamp the card. Ported from the gallery
 * line for line.
 */
import { Burst, PartBox } from "../fixtures";
import { litAt } from "../geometry";
import { RAIL_Y as Y } from "../MachinePart";
import { held } from "../motion";
import { Press } from "../Press";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface WorkerExtra {
  /** Clamp engaged / released. */
  readonly cl: readonly [number, number];
  /** When each press light comes on. */
  readonly lights: readonly number[];
  readonly crash: number | null;
}

function workerStory(
  kind: "done" | "exit 1" | "crash mid-job"
): PartScenario<WorkerExtra> {
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
        { col: [[1.85, "red"]], tags: [["job", 0.65, 1.0]] }
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
      { tags: [[f ? "exit 1" : "result", 2.85, 3.25]] }
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

export const workerMachine: MachinePartDef<WorkerExtra> = {
  part: {
    name: "worker",
    job: "runs one job",
    aka: "process · handler · function · model call",
  },
  family: "compute",
  footprint: "M",
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
