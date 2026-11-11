/**
 * client · asks, then renders (catalogue "client"): a wide box with a
 * screen inset; the request rail goes out, the response rail comes back and
 * bars spring in on the screen. Ported from the gallery line for line.
 */
import { Bar, PartBox, Spinner } from "../fixtures";
import { pop } from "../motion";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import { Outline } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface ClientExtra {
  /** When the response lands and the screen fills. */
  readonly done: number | null;
  /** Spinner while waiting with no deadline. */
  readonly hang: readonly [number, number] | null;
  /** The screen shows an error bar. */
  readonly error: boolean;
}

function clientStory(
  kind: "rendered" | "error 500" | "no response"
): PartScenario<ClientExtra> {
  const hang = kind === "no response";
  const f = kind === "error 500";
  const s = story(hang ? 5.6 : 4.6);
  s.gates.push(gateV(390, 160), gateV(390, 240));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [330, 160],
            [600, 160],
          ],
          0.6,
          0.7,
        ],
      ],
      0.6,
      1.35,
      { tags: [["request", 0.75, 1.2]] }
    )
  );
  if (hang) {
    note(s, 0.6, "send request", "ink");
    note(s, 1.3, "waiting · · ·", "amber");
    note(s, 3.0, "still waiting", "amber");
    note(s, 3.9, "no deadline · hangs", "red");
    return {
      name: kind,
      still: 4.4,
      timeline: seal(s),
      extra: { done: null, hang: [1.3, s.period - 0.5], error: false },
    };
  }
  s.cards.push(
    card(
      28,
      f ? "red" : "ink",
      [
        [
          [
            [600, 240],
            [300, 240],
          ],
          1.9,
          0.6,
        ],
      ],
      1.9,
      2.55,
      { tags: [[f ? "500" : "response", 1.95, 2.4]] }
    )
  );
  note(s, 0.6, "send request", "ink");
  note(s, 1.3, "waiting · · ·", "amber");
  note(s, 2.6, f ? "error shown" : "rendered", f ? "red" : "green");
  return {
    name: kind,
    still: 3.0,
    timeline: seal(s),
    extra: { done: 2.6, hang: null, error: f },
  };
}

export const clientMachine: MachinePartDef<ClientExtra> = {
  part: {
    name: "client",
    job: "asks, then renders",
    aka: "browser · CLI · GUI view · SDK",
  },
  family: "actors",
  footprint: "M",
  bb: [150, 110, 240, 170],
  status: { x: 270, y: 310 },
  scenarios: [
    clientStory("rendered"),
    clientStory("error 500"),
    clientStory("no response"),
  ],
  draw: (t, { done, hang, error }) => {
    const k = (delay: number) => (done == null ? 0 : pop(t - done - delay));
    return (
      <>
        <Rail
          points={[
            [390, 160],
            [600, 160],
          ]}
        />
        <Rail
          points={[
            [390, 240],
            [600, 240],
          ]}
        />
        <PartBox x={150} y={110} w={240} h={170} />
        <Outline x={170} y={128} w={170} h={96} r={8} role="rail" />
        <Bar x={186} y={144} w={70} role="edge" still />
        {hang ? (
          <Spinner x={255} y={182} t={t} from={hang[0]} to={hang[1]} r={18} />
        ) : error ? (
          <Bar x={186} y={166} w={120} role="red" k={k(0)} />
        ) : (
          <>
            <Bar x={186} y={166} w={130} role="ink" k={k(0)} />
            <Bar x={186} y={182} w={90} role="ink" k={k(0.08)} />
            <Bar x={186} y={198} w={110} role="edge" k={k(0.16)} />
          </>
        )}
        <Outline x={186} y={246} w={64} h={20} r={10} />
      </>
    );
  },
};
