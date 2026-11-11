/**
 * transaction · all of it or none (catalogue "transaction"): a staged zone
 * and a committed zone; a commit moves every staged write across, a rollback
 * empties the staged zone and writes nothing. Ported from the gallery line
 * for line.
 */
import { Bar, PartBox } from "../fixtures";
import { held, pop } from "../motion";
import type { CardRole } from "../palette";
import { roleColor } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface TransactionExtra {
  /** Commit attempts `[at, outcome]`; the commit zone frame closes around each. */
  readonly commits: readonly (readonly [number, CardRole])[];
  /** When the rows land in the committed zone; null when nothing is written. */
  readonly landed: number | null;
}

const XS = [270, 320, 370] as const;
const STAGED = [
  [90, "ink"],
  [140, "edge"],
  [110, "ink"],
] as const;
const COMMITTED = [120, 90, 150] as const;

function transactionStory(
  kind: "commit" | "rollback" | "conflict · retry"
): PartScenario<TransactionExtra> {
  const retry = kind === "conflict · retry";
  const f = kind === "rollback";
  const s = story(retry ? 6.0 : 5.0);
  s.gates.push(gateV(200, 145));
  const commit = retry ? 3.5 : 2.3;
  const commits: [number, CardRole][] = retry
    ? [
        [2.3, "red"],
        [3.5, "green"],
      ]
    : [[2.3, f ? "red" : "green"]];
  XS.forEach((x, i) => {
    const a = 0.6 + 0.3 * i;
    const tag: [string, number, number] = [`write ${i + 1}`, a + 0.05, a + 0.4];
    if (!f)
      s.cards.push(
        card(
          28,
          "amber",
          [
            [
              [
                [24, 145],
                [x, 145],
              ],
              a,
              0.6,
            ],
            [
              [
                [x, 145],
                [x, 250],
              ],
              commit + 0.05 * i,
              0.35,
            ],
          ],
          a,
          commit + 0.35 + 0.05 * i,
          {
            col: retry
              ? [
                  [2.2, "red"],
                  [2.75, "amber"],
                ]
              : [],
            tags: [tag],
          }
        )
      );
    else
      s.cards.push(
        card(
          28,
          "amber",
          [
            [
              [
                [24, 145],
                [x, 145],
              ],
              a,
              0.6,
            ],
            [
              [
                [x, 145],
                [24, 145],
              ],
              commit + 0.1 * i,
              0.7,
            ],
          ],
          a,
          commit + 0.75 + 0.1 * i,
          {
            col: [[commit - 0.1, "red"]],
            lean: [commit + 0.1 * i],
            tags: [tag],
          }
        )
      );
  });
  note(s, 0.6, "begin", "ink");
  note(s, 1.6, "3 writes staged", "amber");
  if (retry) {
    note(s, 2.3, "conflict · another writer", "red");
    note(s, 2.9, "retrying commit", "amber");
  }
  note(
    s,
    commit,
    f ? "rollback · nothing written" : "commit · 3 rows",
    f ? "red" : "green"
  );
  return {
    name: kind,
    still: retry ? 2.55 : 2.0,
    timeline: seal(s),
    extra: { commits, landed: f ? null : commit },
  };
}

export const transactionMachine: MachinePartDef<TransactionExtra> = {
  part: {
    name: "transaction",
    job: "all of it or none",
    aka: "DB transaction · batch write · saga step",
  },
  family: "data and state",
  footprint: "M",
  bb: [200, 92, 240, 226],
  status: { x: 320, y: 350 },
  scenarios: [
    transactionStory("commit"),
    transactionStory("rollback"),
    transactionStory("conflict · retry"),
  ],
  draw: (t, { commits, landed }) => {
    // The commit frame closes (solid, outcome colour) around each attempt.
    let k = 0;
    let role: CardRole = "edge";
    for (const [a, c] of commits) {
      const kk = held(t, a - 0.25, a + 0.35);
      if (kk > k) {
        k = kk;
        role = c;
      }
    }
    const closed = k > 0.3;
    return (
      <>
        <Rail
          points={[
            [24, 145],
            [200, 145],
          ]}
        />
        <PartBox x={200} y={92} w={240} h={226} />
        <rect
          x={228}
          y={118}
          width={184}
          height={54}
          rx={10}
          fill="none"
          stroke={roleColor(closed ? role : "edge")}
          strokeWidth={2}
          strokeDasharray={closed ? undefined : "5 5"}
        />
        <SvgText x={232} y={104} runs={[["staged", 400, "dim"]]} size={18} />
        {STAGED.map(([w, c], i) => (
          <Bar key={i} x={236} y={214 + i * 15} w={w} role={c} still />
        ))}
        {landed != null &&
          COMMITTED.map((w, i) => (
            <Bar
              key={i}
              x={236}
              y={259 + i * 15}
              w={w}
              role="ink"
              k={pop(t - landed - 0.35 - 0.05 * i)}
            />
          ))}
      </>
    );
  },
};
