/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * document · edited in place (catalogue "document"): a folded page whose line
 * 5 is replaced by a patch, or refuses the patch when the line moved. Ported
 * from the gallery line for line.
 */
import { Bar } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { clamp, pop, windowed } from "../motion";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface DocumentExtra {
  /** When the edit lands on line 5. */
  readonly ed: number;
  /** The patch does not apply: line 5 flashes red and stays. */
  readonly fail: boolean;
}

const WIDTHS = [110, 70, 120, 90, 100, 60, 115, 80, 95, 50] as const;

function documentStory(
  kind: "patch applies" | "conflict"
): PartScenario<DocumentExtra> {
  const f = kind === "conflict";
  const s = story(4.2);
  s.gates.push(gateV(230, Y));
  if (!f)
    s.cards.push(
      card(
        28,
        "amber",
        [
          [
            [
              [24, Y],
              [290, Y],
            ],
            0.6,
            0.6,
          ],
        ],
        0.6,
        1.3,
        { tags: [["patch", 0.65, 1.0]] }
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
              [24, Y],
              [256, Y],
            ],
            0.6,
            0.5,
          ],
          [
            [
              [256, Y],
              [24, Y],
            ],
            1.35,
            0.6,
          ],
        ],
        0.6,
        2.0,
        {
          col: [[1.23, "red"]],
          lean: [1.35],
          tags: [
            ["patch", 0.65, 1.0],
            ["does not apply", 1.5, 1.95],
          ],
        }
      )
    );
  note(s, 0.6, "patch line 5", "ink");
  note(
    s,
    1.3,
    f ? "conflict · line moved" : "line 5 replaced",
    f ? "red" : "green"
  );
  return {
    name: kind,
    still: 1.6,
    timeline: seal(s),
    extra: { ed: 1.25, fail: f },
  };
}

/** The folded page: a frame with a dog-eared top-right corner. */
function Page() {
  const { removed } = usePart();
  const d =
    "M248 82 L380 82 L410 112 L410 304 A18 18 0 0 1 392 322 L248 322 A18 18 0 0 1 230 304 L230 100 A18 18 0 0 1 248 82 Z";
  return (
    <g className="md-box">
      <path
        d={d}
        fill={roleColor("fill")}
        stroke={roleColor("edge")}
        strokeWidth={2}
        strokeDasharray={removed ? "6 6" : undefined}
      />
      <path
        d="M380 82 L380 112 L410 112"
        fill="none"
        stroke={roleColor("edge")}
        strokeWidth={2}
        strokeDasharray={removed ? "6 6" : undefined}
      />
    </g>
  );
}

export const documentMachine: MachinePartDef<DocumentExtra> = {
  part: {
    name: "document",
    job: "edited in place",
    aka: "file · config · markdown · editor buffer",
  },
  family: "data and state",
  footprint: "M",
  bb: [230, 82, 180, 240],
  status: { x: 320, y: 350 },
  scenarios: [documentStory("patch applies"), documentStory("conflict")],
  draw: (t, { ed, fail }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [230, Y],
        ]}
      />
      <Page />
      {WIDTHS.map((w, i) => {
        const y = 110 + i * 20;
        const gutter = (
          <circle cx={252} cy={y + 3.5} r={2.5} fill={roleColor("rail")} />
        );
        if (i !== 4)
          return (
            <g key={i}>
              {gutter}
              <Bar
                x={266}
                y={y}
                w={w}
                role={i % 3 === 1 ? "edge" : "ink"}
                still
              />
            </g>
          );
        if (fail) {
          const k = windowed(t, ed, ed + 0.4);
          return (
            <g key={i}>
              {gutter}
              <Bar x={266} y={y} w={w} role="edge" still />
              {k > 0 && (
                <g opacity={k}>
                  <Bar x={266} y={y} w={w} role="red" still />
                </g>
              )}
            </g>
          );
        }
        const out = 1 - clamp(t - ed);
        return (
          <g key={i}>
            {gutter}
            {t < ed + 0.2 && (
              <Bar x={266} y={y} w={w * Math.max(0, out)} role="edge" still />
            )}
            <Bar x={266} y={y} w={124} role="ink" k={pop(t - ed - 0.2)} />
            {t > ed + 0.2 && (
              <circle
                cx={252}
                cy={y + 3.5}
                r={4 * pop(t - ed - 0.2)}
                fill={roleColor("amber")}
              />
            )}
          </g>
        );
      })}
    </>
  ),
};
