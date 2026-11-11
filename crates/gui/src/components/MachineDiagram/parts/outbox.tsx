/**
 * outbox · saves and publishes together (catalogue "outbox"): one transaction
 * frame holding the state and an outbox row, a relay and a broker. A relay that
 * crashes before marking the row publishes the message twice. Ported from the
 * gallery line for line.
 */
import { Bar, Burst, Hole, PartBox, Ring } from "../fixtures";
import { held, pop } from "../motion";
import type { StateRole } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { Outline } from "./draw";
import { TL, Tiles, type TileSpec } from "./eventTiles";
import type { MachinePartDef, PartScenario } from "./types";

interface OutboxExtra {
  readonly tl: readonly TileSpec[];
  readonly rings: readonly (readonly [number, number, StateRole])[];
  /** Messages the broker received: `[time, role]`. */
  readonly pub: readonly (readonly [number, "ink" | "amber"])[];
  /** The transaction frame commits at this time. */
  readonly commit: number;
  /** The broker frame is dashed (down). */
  readonly down: boolean;
  /** The relay crashes at this time. */
  readonly crash: number | null;
}

const TB = [262, 225] as const;
const R = [440, 225] as const;

function outboxStory(
  kind: "relayed" | "broker down" | "relay crash · published twice"
): PartScenario<OutboxExtra> {
  const s = story(5.6);
  const twice = kind === "relay crash · published twice";
  const f = kind === "broker down";
  s.gates.push(gateV(130, 165), gateV(380, 225), gateV(520, 225));
  const rings: [number, number, StateRole][] = [];
  const pub: [number, "ink" | "amber"][] = [];
  let crash: number | null = null;
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, 165],
            [230, 165],
          ],
          0.6,
          0.55,
        ],
      ],
      0.6,
      1.3,
      { tags: [["pay", 0.65, 1.0]] }
    )
  );
  const tl = [TL(262, 225, "m1", 1.3, [[1.3, "amber"]], { w: 44 })];
  const send = (a: number, ok: boolean) => {
    s.cards.push(
      card(
        28,
        "amber",
        [
          [[[...TB], [...R]], a, 0.55],
          ok
            ? [[[...R], [560, 225]], a + 1.05, 0.45]
            : [[[...R], [...TB]], a + 1.05, 0.55],
        ],
        a,
        ok ? a + 1.55 : a + 1.65,
        {
          col: ok ? [] : [[a + 0.88, "red"]],
          lean: [a + 1.05],
          tags: [["m1", a + 0.05, a + 0.45]],
        }
      )
    );
    rings.push([a + 0.6, a + 1.0, ok ? "green" : "red"]);
    if (ok) pub.push([a + 1.55, "ink"]);
  };
  note(s, 0.6, "command", "ink");
  note(s, 1.3, "commit · state + outbox row", "green");
  note(s, 2.0, "relay picks up m1", "dim");
  let still = 3.2;
  if (f) {
    s.period = 5.0;
    send(2.0, false);
    note(s, 3.0, "broker down", "red");
    note(s, 3.7, "m1 kept · will retry", "amber");
  } else if (twice) {
    s.period = 7.0;
    send(2.0, true);
    crash = 3.75;
    send(4.3, true);
    pub[1][1] = "amber";
    tl[0].col.push([5.85, "green"]);
    note(s, 3.55, "published", "ink");
    note(s, 3.75, "relay crashed before marking", "red");
    note(s, 4.3, "restart · m1 still pending", "amber");
    note(s, 5.85, "m1 published twice", "amber");
    still = 6.15;
  } else {
    send(2.0, true);
    tl[0].col.push([3.6, "green"]);
    tl[0].gone = 4.0;
    note(s, 3.55, "published · row marked", "green");
  }
  return {
    name: kind,
    still,
    timeline: seal(s),
    extra: { tl, rings, pub, commit: 1.25, down: f, crash },
  };
}

export const outboxMachine: MachinePartDef<OutboxExtra> = {
  part: {
    name: "outbox",
    job: "saves and publishes together",
    aka: "transactional outbox · relay · change feed",
  },
  family: "event sourcing",
  footprint: "M",
  bb: [130, 105, 250, 190],
  status: { x: 365, y: 332 },
  scenarios: [
    outboxStory("relayed"),
    outboxStory("broker down"),
    outboxStory("relay crash · published twice"),
  ],
  draw: (t, { tl, rings, pub, commit, down, crash }) => {
    const k = held(t, commit - 0.1, commit + 0.5);
    return (
      <>
        <Rail
          points={[
            [24, 165],
            [130, 165],
          ]}
        />
        <Rail
          points={[
            [380, 225],
            [520, 225],
          ]}
        />
        <PartBox x={130} y={105} w={250} h={190} />
        <PartBox x={520} y={180} w={80} h={90} r={12} dashed={down} />
        <SvgText
          x={560}
          y={290}
          runs={[["broker", 400, "dim"]]}
          size={18}
          align="center"
        />
        <Hole x={440} y={225} r={22} />
        <SvgText
          x={440}
          y={268}
          runs={[["relay", 400, "dim"]]}
          size={18}
          align="center"
        />
        {rings.map(([from, to, result], i) => (
          <Ring
            key={i}
            x={440}
            y={225}
            t={t}
            from={from}
            to={to}
            result={result}
            r={22}
          />
        ))}
        {crash != null && (
          <Burst x={440} y={225} t={t} at={crash} role="red" r0={22} r1={70} />
        )}
        <Outline
          x={150}
          y={128}
          w={210}
          h={124}
          r={10}
          role={k > 0.3 ? "green" : "edge"}
          dash={k > 0.3 ? undefined : "5 5"}
        />
        <SvgText x={166} y={163} runs={[["state", 400, "dim"]]} size={18} />
        <Bar x={240} y={152} w={100} role="ink" still />
        {t >= commit + 0.05 && (
          <Bar x={240} y={168} w={70} role="ink" k={pop(t - commit - 0.05)} />
        )}
        <SvgText x={166} y={225} runs={[["outbox", 400, "dim"]]} size={18} />
        <Tiles list={tl} t={t} />
        {pub.map(([a, role], i) =>
          t >= a ? (
            <Bar
              key={i}
              x={534}
              y={198 + 16 * i}
              w={52}
              role={role}
              k={pop(t - a)}
            />
          ) : null
        )}
      </>
    );
  },
};
