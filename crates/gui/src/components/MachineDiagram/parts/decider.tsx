/**
 * decider · command + state → events (catalogue "decider"): the press with a
 * state line above the box. A command that breaks an invariant bounces back
 * with no events; one that changes nothing produces none either. Ported from
 * the gallery line for line.
 */
import { Burst, PartBox } from "../fixtures";
import { litAt } from "../geometry";
import { RAIL_Y as Y } from "../MachinePart";
import { held } from "../motion";
import { Press } from "../Press";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story, type StatusNote } from "../timeline";
import { ValueNote } from "./eventTiles";
import type { MachinePartDef, PartScenario } from "./types";

interface DeciderExtra {
  /** The state line above the box over time. */
  readonly st: readonly StatusNote[];
  /** Clamp engaged / released. */
  readonly cl: readonly [number, number];
  readonly lights: readonly number[];
  /** A no-op closes with a green burst at this time. */
  readonly noop: number | null;
}

function deciderStory(
  kind: "decides" | "rejected · invariant" | "no-op · already closed"
): PartScenario<DeciderExtra> {
  const s = story(4.8);
  const f = kind === "rejected · invariant";
  const noop = kind === "no-op · already closed";
  const cmd = noop ? "close" : f ? "withdraw 80" : "withdraw 30";
  const cl: [number, number] = [1.25, 2.6];
  const amber = (t: number) => held(t, cl[0], cl[1]);
  s.gates.push(gateV(210, Y, amber), gateV(430, Y, amber));
  const st: StatusNote[] = [[0, noop ? "closed" : "balance 50", "ink"]];
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
        ...(f
          ? ([
              [
                [
                  [320, Y],
                  [24, Y],
                ],
                2.65,
                0.75,
              ],
            ] as const)
          : []),
      ],
      0.6,
      f ? 3.5 : 2.75,
      {
        col: f ? [[2.55, "red"]] : noop ? [[2.55, "green"]] : [],
        lean: f ? [2.65] : [],
        tags: [
          [cmd, 0.65, 1.0],
          ...(f ? ([["rejected", 2.8, 3.35]] as const) : []),
        ],
      }
    )
  );
  if (!noop && !f) {
    s.cards.push(
      card(
        28,
        "ink",
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
        { tags: [["Withdrawn 30", 2.8, 3.25]] }
      )
    );
    st.push([3.1, "balance 20", "ink"]);
  }
  st.push([s.period - 0.45, st[0][1], "ink"]);
  note(s, 0.6, `command · ${cmd}`, "ink");
  note(s, 1.35, "deciding · · ·", "dim");
  note(
    s,
    2.65,
    f
      ? "rejected · 80 > 50 · no events"
      : noop
        ? "0 events · already closed"
        : "1 event",
    f ? "red" : "green"
  );
  return {
    name: kind,
    still: f ? 3.0 : noop ? 3.1 : 1.9,
    timeline: seal(s),
    extra: {
      st,
      cl,
      lights: [1.35, 1.6, 1.85, 2.1, 2.35, 2.6],
      noop: noop ? 2.6 : null,
    },
  };
}

export const deciderMachine: MachinePartDef<DeciderExtra> = {
  part: {
    name: "decider",
    job: "command + state → events",
    aka: "aggregate · command handler · domain model",
  },
  family: "event sourcing",
  footprint: "M",
  bb: [210, 105, 220, 190],
  status: { x: 320, y: 328 },
  scenarios: [
    deciderStory("decides"),
    deciderStory("rejected · invariant"),
    deciderStory("no-op · already closed"),
  ],
  draw: (t, { st, cl, lights, noop }) => (
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
      {noop != null && (
        <Burst x={320} y={Y} t={t} at={noop} role="green" r0={30} r1={90} />
      )}
      <SvgText x={210} y={80} runs={[["state", 400, "dim"]]} size={18} />
      <ValueNote list={st} t={t} x={430} y={80} size={18} align="right" />
    </>
  ),
};
