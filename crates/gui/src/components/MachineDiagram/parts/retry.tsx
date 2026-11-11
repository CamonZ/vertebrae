/**
 * retry · tries again, then gives up (catalogue "retry"): a caller box and a
 * service box with an attempt counter between. Ported from the gallery
 * artifact (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { Hole, Lamp, PartBox, Ring } from "../fixtures";
import { pop } from "../motion";
import type { CardRole } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface RetryExtra {
  /** One lamp per attempt: `[t, role]`. */
  readonly lamps: readonly (readonly [number, CardRole])[];
  /** Back-off wait rings `[from, to]` on the attempt counter. */
  readonly rings: readonly (readonly [number, number])[];
}

function retryStory(
  kind: "ok on 2nd" | "gives up" | "not retryable"
): PartScenario<RetryExtra> {
  const f = kind === "gives up";
  const s = story(f ? 9.6 : 6.4);
  s.gates.push(
    gateV(320, 170),
    gateV(320, 235),
    gateV(500, 170),
    gateV(500, 235)
  );
  const lamps: [number, CardRole][] = [];
  const rings: [number, number][] = [];
  let a = 0.6;
  const attempt = (i: number, ok: boolean) => {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [280, 170],
              [548, 170],
            ],
            a,
            0.6,
          ],
        ],
        a,
        a + 0.65,
        { tags: [[`try ${i + 1}`, a + 0.1, a + 0.5]] }
      )
    );
    const r = a + 1.0;
    s.cards.push(
      card(
        28,
        ok ? "green" : "red",
        [
          [
            [
              [548, 235],
              [280, 235],
            ],
            r,
            0.6,
          ],
        ],
        r,
        r + 0.7,
        { tags: [[ok ? "200" : "503", r + 0.05, r + 0.45, 28]] }
      )
    );
    lamps.push([r + 0.6, ok ? "green" : "red"]);
    note(s, a, `attempt ${i + 1}`, "ink");
    note(
      s,
      r + 0.6,
      ok ? `ok on attempt ${i + 1}` : "failed · backing off",
      ok ? "green" : "amber"
    );
    if (!ok) {
      rings.push([r + 0.7, r + 0.7 + (i + 1) * 0.8]);
      a = r + 0.8 + (i + 1) * 0.8;
    }
  };
  if (kind === "not retryable") {
    s.period = 4.4;
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [280, 170],
              [548, 170],
            ],
            a,
            0.6,
          ],
        ],
        a,
        a + 0.65,
        { tags: [["try 1", a + 0.1, a + 0.5]] }
      )
    );
    s.cards.push(
      card(
        28,
        "red",
        [
          [
            [
              [548, 235],
              [280, 235],
            ],
            1.6,
            0.6,
          ],
        ],
        1.6,
        2.3,
        { tags: [["400", 1.65, 2.05, 28]] }
      )
    );
    lamps.push([2.2, "red"]);
    note(s, 0.6, "attempt 1", "ink");
    note(s, 2.2, "400 · not retryable · stop", "red");
    return {
      name: kind,
      still: 2.7,
      timeline: seal(s),
      extra: { lamps, rings },
    };
  }
  attempt(0, false);
  if (f) {
    attempt(1, false);
    attempt(2, false);
    note(s, lamps[2][0], "gave up after 3", "red");
    rings.pop();
  } else attempt(1, true);
  return { name: kind, still: 2.6, timeline: seal(s), extra: { lamps, rings } };
}

export const retryMachine: MachinePartDef<RetryExtra> = {
  part: {
    name: "retry",
    job: "tries again, then gives up",
    aka: "backoff · redelivery · reconnect",
  },
  family: "messaging and flow control",
  footprint: "S",
  bb: [150, 130, 170, 140],
  status: { x: 235, y: 300 },
  scenarios: [
    retryStory("ok on 2nd"),
    retryStory("gives up"),
    retryStory("not retryable"),
  ],
  draw: (t, { lamps, rings }) => (
    <>
      <Rail
        points={[
          [320, 170],
          [500, 170],
        ]}
      />
      <Rail
        points={[
          [320, 235],
          [500, 235],
        ]}
      />
      <PartBox x={500} y={130} w={96} h={140} r={12} />
      <SvgText
        x={548}
        y={290}
        runs={[["service", 400, "dim"]]}
        size={18}
        align="center"
      />
      <PartBox x={150} y={130} w={170} h={140} r={12} />
      {[0, 1, 2].map((i) => {
        const l = lamps[i];
        return (
          <Lamp
            key={i}
            x={190 + 38 * i}
            y={165}
            r={8}
            role={l && t >= l[0] ? l[1] : null}
            k={l ? pop(t - l[0]) : 0}
          />
        );
      })}
      <Hole x={232} y={228} r={22} />
      {rings.map(([a, b], i) => (
        <Ring
          key={i}
          x={232}
          y={228}
          t={t}
          from={a}
          to={b}
          result="ink"
          r={22}
        />
      ))}
    </>
  ),
};
