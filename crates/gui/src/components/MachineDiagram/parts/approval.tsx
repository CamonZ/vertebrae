/**
 * approval · waits for a person (catalogue "approval"): a gate held by a
 * person rail from above. Ported from the gallery artifact
 * (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { Hole, PartBox, Ring, Spinner } from "../fixtures";
import { held } from "../motion";
import type { CardRole } from "../palette";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { card, gateH, gateV, note, seal, story } from "../timeline";
import { Caret, Slab } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

const Y = 210;
const SLOT: Point = [300, Y];

interface ApprovalExtra {
  /** Waiting spinner `[from, to]`. */
  readonly wait: readonly [number, number];
  /** The gate lifts `[from, to]`. */
  readonly lift: readonly [number, number];
  /** Deadline ring `[from, to, result]` (expiry only). */
  readonly ring: readonly [number, number, CardRole] | null;
  readonly fail: boolean;
}

function approvalStory(
  kind: "approved" | "rejected" | "expires"
): PartScenario<ApprovalExtra> {
  const s = story(5.6);
  s.gates.push(gateV(200, Y), gateV(420, Y), gateH(310, 150));
  if (kind === "expires") {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [[[24, Y], SLOT], 0.6, 0.6],
          [[SLOT, [24, Y]], 3.7, 0.6],
        ],
        0.6,
        4.35,
        {
          col: [[3.58, "red"]],
          lean: [3.7],
          tags: [
            ["deploy", 0.65, 1.0],
            ["expired", 3.85, 4.3],
          ],
        }
      )
    );
    note(s, 0.6, "deploy arrives", "ink");
    note(s, 1.2, "waiting for a person", "amber");
    note(s, 3.6, "no answer · expired", "red");
    return {
      name: kind,
      still: 4.1,
      timeline: seal(s),
      extra: {
        wait: [1.2, 3.6],
        lift: [9, 9],
        ring: [1.2, 3.6, "red"],
        fail: true,
      },
    };
  }
  const f = kind === "rejected";
  s.cards.push(
    card(
      28,
      "ink",
      f
        ? [
            [[[24, Y], SLOT], 0.6, 0.6],
            [[SLOT, [24, Y]], 3.6, 0.6],
          ]
        : [
            [[[24, Y], SLOT], 0.6, 0.6],
            [[SLOT, [616, Y]], 3.6, 0.6],
          ],
      0.6,
      4.25,
      {
        col: [[3.48, f ? "red" : "green"]],
        lean: [3.6],
        tags: [
          ["deploy", 0.65, 1.0],
          [f ? "rejected" : "approved", 3.75, 4.2],
        ],
      }
    )
  );
  s.cards.push(
    card(
      18,
      "ink",
      [
        [
          [
            [520, 96],
            [310, 96],
            [310, 200],
          ],
          2.6,
          0.8,
        ],
      ],
      2.6,
      3.45,
      { tags: [[f ? "no" : "yes", 2.65, 3.1]] }
    )
  );
  note(s, 0.6, "deploy arrives", "ink");
  note(s, 1.2, "waiting for a person", "amber");
  note(s, 3.45, f ? "rejected" : "approved", f ? "red" : "green");
  return {
    name: kind,
    still: 2.4,
    timeline: seal(s),
    extra: { wait: [1.2, 3.45], lift: [3.5, 9], ring: null, fail: f },
  };
}

export const approvalMachine: MachinePartDef<ApprovalExtra> = {
  part: {
    name: "approval",
    job: "waits for a person",
    aka: "human gate · review · confirm dialog",
  },
  family: "policy",
  footprint: "M",
  bb: [200, 150, 220, 120],
  status: { x: 310, y: 302 },
  scenarios: [
    approvalStory("approved"),
    approvalStory("rejected"),
    approvalStory("expires"),
  ],
  draw: (t, { wait, lift, ring, fail }) => {
    const k = fail ? 0 : held(t, lift[0], lift[1]);
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [200, Y],
          ]}
        />
        <Rail
          points={[
            [420, Y],
            [616, Y],
          ]}
        />
        <Rail
          points={[
            [520, 96],
            [310, 96],
            [310, 150],
          ]}
        />
        <PartBox x={520} y={70} w={76} h={52} r={12} />
        <Caret x={538} y={96} t={t} />
        <PartBox x={200} y={150} w={220} h={120} />
        <Hole x={300} y={Y} />
        <Spinner x={300} y={Y} t={t} from={wait[0]} to={wait[1]} />
        {ring && (
          <Ring
            x={300}
            y={Y}
            t={t}
            from={ring[0]}
            to={ring[1]}
            result={ring[2]}
            r={34}
          />
        )}
        <Slab x={384} y={166} w={20} h={8} r={3} role="edge" />
        <Slab x={389} y={190 - 60 * k} w={10} h={40} role="plate" />
      </>
    );
  },
};
