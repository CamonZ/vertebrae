/**
 * timeout · stops waiting at a deadline (catalogue "timeout"): a fuse that
 * burns down to the deadline and a callee box for cancel. Ported from the
 * gallery artifact (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a)
 * line for line.
 */
import { Hole, Lamp, PartBox, Ring, Spinner } from "../fixtures";
import { pop, smoothstep } from "../motion";
import { roleColor, type CardRole } from "../palette";
import { RAIL_Y as Y } from "../MachinePart";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { Slab } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface TimeoutExtra {
  /** Fuse burns from `dl[0]` to `dl[1]`. */
  readonly dl: readonly [number, number];
  /** Deadline ring `[from, to, result]`. */
  readonly ring: readonly [number, number, CardRole];
  /** The fuse stops burning here (answer or deadline). */
  readonly stop: number;
  /** Callee spinner `[from, to]` while it works on a cancelled request. */
  readonly svc: readonly [number, number] | null;
  readonly fail: boolean;
  readonly period: number;
}

function timeoutStory(
  kind: "in time" | "timed out" | "cancel propagates"
): PartScenario<TimeoutExtra> {
  const s = story(5.2);
  const dl = [1.2, 3.4] as const;
  s.gates.push(gateV(200, Y), gateV(440, Y));
  const waitReply = (
    back: number,
    tags: [string, number, number][],
    role?: CardRole
  ) =>
    card(
      28,
      "ink",
      [
        [
          [
            [24, Y],
            [300, Y],
          ],
          0.6,
          0.6,
        ],
        [
          [
            [300, Y],
            [24, Y],
          ],
          back,
          0.6,
        ],
      ],
      0.6,
      back + 0.65,
      {
        col: role ? [[back - 0.12, role]] : [],
        lean: [back],
        tags: [["wait reply", 0.65, 1.0], ...tags],
      }
    );
  if (kind === "cancel propagates") {
    s.cards.push(waitReply(3.5, [["timed out", 3.65, 4.1]], "red"));
    s.cards.push(
      card(
        18,
        "ink",
        [
          [
            [
              [452, Y],
              [560, Y],
            ],
            3.5,
            0.5,
          ],
        ],
        3.45,
        4.05,
        { tags: [["cancel", 3.55, 4.0]] }
      )
    );
    note(s, 0.6, "waiting · 2 s budget", "amber");
    note(s, 3.4, "timed out · 2 s", "red");
    note(s, 4.0, "callee stopped · no leak", "green");
    return {
      name: kind,
      still: 4.3,
      timeline: seal(s),
      extra: {
        dl,
        ring: [1.2, 3.4, "red"],
        stop: 3.4,
        svc: [1.3, 4.0],
        fail: true,
        period: 5.2,
      },
    };
  }
  if (kind === "in time") {
    s.cards.push(waitReply(2.6, [["in 1.3 s", 2.75, 3.2]], "green"));
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [616, Y],
              [312, Y],
            ],
            1.9,
            0.6,
          ],
        ],
        1.9,
        2.55,
        { tags: [["reply", 1.95, 2.3]] }
      )
    );
    note(s, 0.6, "waiting · 2 s budget", "amber");
    note(s, 2.5, "answered in time", "green");
    return {
      name: kind,
      still: 1.8,
      timeline: seal(s),
      extra: {
        dl,
        ring: [1.2, 2.5, "green"],
        stop: 2.5,
        svc: null,
        fail: false,
        period: 5.2,
      },
    };
  }
  s.cards.push(waitReply(3.5, [["timed out", 3.65, 4.1]], "red"));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [616, Y],
            [452, Y],
          ],
          3.8,
          0.5,
        ],
      ],
      3.8,
      4.4,
      { col: [[4.25, "edge"]], tags: [["late", 3.85, 4.35]] }
    )
  );
  note(s, 0.6, "waiting · 2 s budget", "amber");
  note(s, 3.4, "timed out · 2 s", "red");
  note(s, 4.3, "late reply dropped", "dim");
  return {
    name: kind,
    still: 1.8,
    timeline: seal(s),
    extra: {
      dl,
      ring: [1.2, 3.4, "red"],
      stop: 3.4,
      svc: null,
      fail: true,
      period: 5.2,
    },
  };
}

export const timeoutMachine: MachinePartDef<TimeoutExtra> = {
  part: {
    name: "timeout",
    job: "stops waiting at a deadline",
    aka: "deadline · watchdog · TTL",
  },
  family: "messaging and flow control",
  footprint: "M",
  bb: [200, 125, 240, 150],
  status: { x: 320, y: 306 },
  scenarios: [
    timeoutStory("in time"),
    timeoutStory("timed out"),
    timeoutStory("cancel propagates"),
  ],
  draw: (t, { dl, ring, stop, svc, fail, period }) => {
    const k =
      t < dl[0]
        ? 1
        : 1 - Math.min(1, (Math.min(t, stop) - dl[0]) / (dl[1] - dl[0]));
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
            [440, Y],
            [616, Y],
          ]}
        />
        <PartBox x={200} y={125} w={240} h={150} />
        <Hole x={300} y={Y} />
        <Ring
          x={300}
          y={Y}
          t={t}
          from={ring[0]}
          to={ring[1]}
          result={ring[2]}
        />
        <Slab x={350} y={160} w={8} h={80} r={4} role="rail" />
        {t < period - 0.5 && (
          <Slab
            x={350}
            y={240 - 80 * k}
            w={8}
            h={80 * k}
            r={4}
            role={t >= stop && fail ? "red" : "plate"}
          />
        )}
        <rect x={343} y={159} width={22} height={3} fill={roleColor("amber")} />
        <SvgText x={372} y={Y} runs={[["fuse", 400, "dim"]]} size={18} />
        {svc && (
          <>
            <PartBox x={540} y={160} w={76} h={80} r={12} />
            <SvgText
              x={578}
              y={258}
              runs={[["callee", 400, "dim"]]}
              size={18}
              align="center"
            />
            <Spinner x={578} y={Y} t={t} from={svc[0]} to={svc[1]} r={16} />
            <Lamp
              x={578}
              y={Y}
              r={6}
              role={t >= svc[1] ? "green" : null}
              k={
                pop(t - svc[1]) *
                (1 - smoothstep(svc[1] + 0.8, svc[1] + 1.1, t))
              }
            />
          </>
        )}
      </>
    );
  },
};
