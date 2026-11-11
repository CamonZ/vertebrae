/**
 * alert · gets someone's attention (catalogue "alert"; the gallery's Beacon):
 * a lamp with bursts and an escalation lane. Ported from the gallery artifact
 * (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { Burst, Lamp, PartBox } from "../fixtures";
import { pop } from "../motion";
import { RAIL_Y as Y } from "../MachinePart";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import { Caret } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface AlertExtra {
  /** When the lamp fires. */
  readonly fire: number;
  /** When someone acknowledges (null when nobody does). */
  readonly ack: number | null;
  readonly fail: boolean;
}

function alertStory(failed: boolean): PartScenario<AlertExtra> {
  const s = story(5.6);
  s.gates.push(gateV(220, Y), gateV(360, Y));
  s.cards.push(
    card(
      12,
      "red",
      [
        [
          [
            [24, Y],
            [236, Y],
          ],
          0.6,
          0.5,
        ],
      ],
      0.6,
      1.12,
      { h: 8, tags: [["errors > 5", 0.65, 1.1]] }
    )
  );
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [330, Y],
            [520, Y],
          ],
          1.5,
          0.6,
        ],
      ],
      1.5,
      2.15,
      { tags: [["page", 1.65, 2.1]] }
    )
  );
  if (!failed)
    s.cards.push(
      card(
        18,
        "ink",
        [
          [
            [
              [520, 236],
              [400, 236],
              [400, Y],
              [342, Y],
            ],
            3.0,
            0.6,
          ],
        ],
        3.0,
        3.65,
        { tags: [["ack", 3.05, 3.5, 28]] }
      )
    );
  note(s, 0.6, "quiet", "dim");
  note(s, 1.2, "firing", "amber");
  note(s, 2.2, "paged · waiting for ack", "amber");
  note(
    s,
    failed ? 3.6 : 3.65,
    failed ? "no ack · escalating" : "acknowledged",
    failed ? "red" : "green"
  );
  return {
    name: failed ? "escalates" : "acknowledged",
    still: 1.9,
    timeline: seal(s),
    extra: { fire: 1.2, ack: failed ? null : 3.6, fail: failed },
  };
}

export const alertMachine: MachinePartDef<AlertExtra> = {
  part: {
    name: "alert",
    job: "gets someone's attention",
    aka: "alarm · notification · toast · page",
  },
  family: "observability",
  footprint: "S",
  bb: [220, 150, 140, 100],
  status: { x: 290, y: 282 },
  scenarios: [alertStory(false), alertStory(true)],
  draw: (t, { fire, ack, fail }) => {
    const on = t >= fire && (!ack || t < ack);
    const role = fail && t >= 3.6 ? "red" : "amber";
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
            [360, Y],
            [520, Y],
          ]}
        />
        {!fail && (
          <Rail
            points={[
              [520, 236],
              [400, 236],
              [400, Y],
            ]}
            dashed
            dash="4 6"
          />
        )}
        <PartBox x={520} y={170} w={76} h={60} r={12} />
        <Caret x={538} y={Y} t={t} />
        <PartBox x={220} y={150} w={140} h={100} r={12} />
        <Lamp
          x={290}
          y={Y}
          r={18}
          role={on ? role : null}
          k={on ? pop(t - fire) : 0}
        />
        {on &&
          [0, 1, 2, 3, 4].map((k) => (
            <Burst
              key={k}
              x={290}
              y={Y}
              t={t}
              at={fire + 0.1 + k * 0.7}
              role={role}
              r0={18}
              r1={60}
            />
          ))}
      </>
    );
  },
};
