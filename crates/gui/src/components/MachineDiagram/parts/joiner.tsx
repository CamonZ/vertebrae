/**
 * joiner · waits for all, then goes (catalogue "joiner"): one wait ring per
 * declared branch; it releases one card when every ring has filled. Ported
 * from the gallery line for line.
 */
import { Hole, PartBox, Ring } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import type { CardRole } from "../palette";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { card, gateV, note, seal, story } from "../timeline";
import { Strokes } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** `[slot, from, to, result]`: a wait ring at a branch slot. */
type RingStep = readonly [Point, number, number, CardRole];

interface JoinerExtra {
  readonly rings: readonly RingStep[];
}

const A: Point = [260, 150];
const B: Point = [260, 250];
const M: Point = [330, Y];

function joinerStory(
  kind: "joined" | "timed out" | "one fails · fail fast"
): PartScenario<JoinerExtra> {
  const s = story(4.8);
  s.gates.push(gateV(200, 150), gateV(200, 250), gateV(420, Y));
  let rings: RingStep[];
  if (kind === "one fails · fail fast") {
    s.cards.push(
      card(28, "ink", [[[[24, 150], A], 0.6, 0.6]], 0.6, 2.6, {
        col: [[2.45, "edge"]],
        tags: [["a", 0.65, 1.0]],
      })
    );
    s.cards.push(
      card(28, "red", [[[[24, 250], B], 1.6, 0.6]], 1.6, 2.4, {
        tags: [["b failed", 1.65, 2.2, 28]],
      })
    );
    s.cards.push(
      card(36, "red", [[[M, [616, Y]], 2.4, 0.6]], 2.38, 3.05, {
        tags: [["failed", 2.55, 3.0]],
      })
    );
    rings = [
      [A, 1.2, 2.35, "edge"],
      [B, 2.2, 2.3, "red"],
    ];
    note(s, 0.6, "0 of 2", "dim");
    note(s, 1.2, "1 of 2 · waiting", "amber");
    note(s, 2.2, "b failed → fail fast", "red");
    note(s, 3.1, "a discarded", "dim");
  } else if (kind === "joined") {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [[[24, 150], A], 0.6, 0.6],
          [[A, M], 2.45, 0.3],
        ],
        0.6,
        2.8,
        { tags: [["a", 0.65, 1.0]] }
      )
    );
    s.cards.push(
      card(
        28,
        "ink",
        [
          [[[24, 250], B], 1.6, 0.6],
          [[B, M], 2.45, 0.3],
        ],
        1.6,
        2.8,
        { tags: [["b", 1.65, 2.0, 28]] }
      )
    );
    s.cards.push(
      card(36, "ink", [[[M, [616, Y]], 2.8, 0.6]], 2.78, 3.45, {
        tags: [["a + b", 2.95, 3.4]],
      })
    );
    rings = [
      [A, 1.2, 2.4, "green"],
      [B, 2.2, 2.4, "green"],
    ];
    note(s, 0.6, "0 of 2", "dim");
    note(s, 1.2, "1 of 2 · waiting", "amber");
    note(s, 2.2, "2 of 2", "ink");
    note(s, 2.8, "joined", "green");
  } else {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [[[24, 150], A], 0.6, 0.6],
          [[A, M, [616, Y]], 3.0, 0.8],
        ],
        0.6,
        3.85,
        {
          col: [[2.88, "red"]],
          lean: [3.0],
          tags: [
            ["a", 0.65, 1.0],
            ["b never came", 3.2, 3.8],
          ],
        }
      )
    );
    rings = [[A, 1.2, 3.0, "red"]];
    note(s, 0.6, "0 of 2", "dim");
    note(s, 1.2, "1 of 2 · waiting", "amber");
    note(s, 3.0, "timed out · 1 of 2", "red");
  }
  return {
    name: kind,
    still: kind === "one fails · fail fast" ? 2.75 : 1.9,
    timeline: seal(s),
    extra: { rings },
  };
}

export const joinerMachine: MachinePartDef<JoinerExtra> = {
  part: {
    name: "joiner",
    job: "waits for all, then goes",
    aka: "barrier · Promise.all · zip",
  },
  family: "compute",
  footprint: "M",
  bb: [200, 105, 220, 190],
  status: { x: 310, y: 328 },
  scenarios: [
    joinerStory("joined"),
    joinerStory("timed out"),
    joinerStory("one fails · fail fast"),
  ],
  draw: (t, { rings }) => (
    <>
      <Rail
        points={[
          [24, 150],
          [200, 150],
        ]}
      />
      <Rail
        points={[
          [24, 250],
          [200, 250],
        ]}
      />
      <Rail
        points={[
          [420, Y],
          [616, Y],
        ]}
      />
      <PartBox x={200} y={105} w={220} h={190} />
      <Hole x={A[0]} y={A[1]} />
      <Hole x={B[0]} y={B[1]} />
      <Strokes
        lines={[
          [
            [290, 165],
            [330, Y],
            [290, 235],
          ],
        ]}
      />
      {rings.map(([[x, y], from, to, result], i) => (
        <Ring key={i} x={x} y={y} t={t} from={from} to={to} result={result} />
      ))}
    </>
  ),
};
