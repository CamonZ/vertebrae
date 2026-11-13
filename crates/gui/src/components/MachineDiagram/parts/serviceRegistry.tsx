import { Burst, PartBox, Ring } from "../fixtures";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { card, dot, note, seal, story, type StoryDraft } from "../timeline";
import { NodeLamp, Tiles, tileSpec as TL } from "./distributedFixtures";
import { FadedText } from "./draw";
import {
  serviceRegistrySpec,
  type ServiceRegistryExtra,
} from "./serviceRegistrySpec";
import type { MachinePartDef, PartScenario } from "./types";

export type { ServiceRegistryExtra } from "./serviceRegistrySpec";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
const NAMES = [
  "resolves",
  "stale entry · dead address",
  "deregistered on shutdown",
] as const;
const STILLS = [3.0, 3.45, 1.8];
function serviceRegistryStory(
  index: number
): PartScenario<ServiceRegistryExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & ServiceRegistryExtra = Object.assign(story(4.8), {
      lamps: [],
      rings: [],
      crash: null,
      tl: [],
    } as ServiceRegistryExtra),
    dereg = s === "deregistered on shutdown",
    reg = !f && !dereg;
  const done = (): PartScenario<ServiceRegistryExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push();
  S.lamps = [[[0, "green"]], [[0, reg ? "off" : "green"]]];
  S.rings = [];
  S.crash = null;
  const RG: Point[] = [
      [590, 301],
      [610, 301],
      [610, 130],
      [440, 130],
    ],
    LU: Point[] = [
      [150, 245],
      [260, 245],
      [260, 170],
    ],
    CALL = (y: number): Point[] => [
      [150, 270],
      [300, 270],
      [300, y],
      [450, y],
    ];
  S.tl = [
    TL(290, 130, "s1", -1, [], { w: 44 }),
    TL(
      340,
      130,
      "s2",
      reg ? 1.25 : -1,
      reg
        ? [
            [1.25, "ink"],
            [1.8, "edge"],
          ]
        : [],
      { w: 44 }
    ),
  ];
  const look = (a: number, ans: string) => {
    S.cards.push(
      dot(LU, a, 0.5),
      card(
        14,
        "ink",
        [[LU.slice().reverse(), a + 0.6, 0.5]],
        a + 0.6,
        a + 1.15,
        { dot: true, tags: [[ans, a + 0.6, a + 1.15, -22]] }
      )
    );
  };
  if (reg) {
    S.cards.push(dot(RG, 0.6, 0.65));
    S.lamps[1].push([0.6, "green"]);
    look(1.6, "s1 s2");
    S.cards.push(
      card(28, "ink", [[CALL(301), 2.8, 0.6]], 2.8, 3.5, {
        tags: [["call", 2.85, 3.3]],
      })
    );
    S.rings.push([301, 3.35, 3.75, "green"]);
    note(S, 0.6, "s2 starts · registers", "ink");
    note(S, 1.6, "client looks up", "dim");
    note(S, 2.25, "gets s1, s2", "ink");
    note(S, 3.75, "call s2 · ok", "green");
    return done();
  }
  if (f) {
    S.crash = 0.6;
    S.lamps[1].push([0.6, "red"]);
    look(1.4, "s1 s2");
    S.cards.push(
      card(
        28,
        "ink",
        [
          [CALL(301), 2.6, 0.6],
          [CALL(301).reverse(), 3.35, 0.6],
        ],
        2.6,
        4.1,
        {
          col: [[3.2, "red"]],
          lean: [3.35],
          tags: [
            ["call", 2.65, 3.1],
            ["refused", 3.4, 4.0],
          ],
        }
      )
    );
    note(S, 0.6, "s2 crashes · entry stays", "red");
    note(S, 1.4, "client looks up", "dim");
    note(S, 2.05, "gets s1, s2", "ink");
    note(S, 3.2, "call s2 · connection refused", "red");
    return done();
  }
  S.lamps[1].push([0.6, "amber"], [1.6, "off"]);
  S.cards.push(dot(RG, 0.7, 0.65, "amber"));
  S.tl[1].gone = 1.35;
  look(1.9, "s1");
  S.cards.push(
    card(28, "ink", [[CALL(226), 3.0, 0.6]], 3.0, 3.7, {
      tags: [["call", 3.05, 3.5]],
    })
  );
  S.rings.push([226, 3.55, 3.95, "green"]);
  note(S, 0.6, "s2 stops · deregisters", "amber");
  note(S, 1.35, "entry removed", "dim");
  note(S, 2.55, "lookup → s1 only", "ink");
  note(S, 3.95, "call s1 · ok", "green");
  return done();
}

export const serviceRegistryMachine: MachinePartDef<ServiceRegistryExtra> = {
  part: {
    name: "service registry",
    job: serviceRegistrySpec.job,
    aka: "service discovery \u00b7 DNS \u00b7 Consul \u00b7 etcd",
  },
  family: "distributed systems",
  footprint: "L",
  bb: serviceRegistrySpec.bb,
  status: serviceRegistrySpec.status,
  scenarios: [
    serviceRegistryStory(0),
    serviceRegistryStory(1),
    serviceRegistryStory(2),
  ],
  draw: (t, S) => (
    <>
      <Rail
        points={[
          [440, 130],
          [610, 130],
          [610, 301],
          [590, 301],
        ]}
      />
      <Rail
        points={[
          [610, 226],
          [590, 226],
        ]}
      />
      <Rail
        points={[
          [150, 245],
          [260, 245],
          [260, 170],
        ]}
      />
      <Rail
        points={[
          [150, 270],
          [300, 270],
          [300, 226],
          [450, 226],
        ]}
      />
      <Rail
        points={[
          [300, 270],
          [300, 301],
          [450, 301],
        ]}
      />
      <FadedText
        x={320}
        y={72}
        runs={[["registry", 400, "dim"]]}
        size={18}
        align="center"
      />
      <PartBox x={200} y={90} w={240} h={80} r={14} />
      <Tiles list={S.tl} t={t} />
      <PartBox x={40} y={230} w={110} h={60} r={12} />
      <FadedText
        x={95}
        y={260}
        runs={[["client", 400, "dim"]]}
        size={18}
        align="center"
      />
      {[226, 301].map((y, i) => (
        <g key={y}>
          <PartBox x={450} y={y - 26} w={140} h={52} r={12} />
          <NodeLamp x={472} y={y} r={9} steps={S.lamps[i]} t={t} />
          <FadedText
            x={492}
            y={y}
            runs={[[`s${i + 1}`, 400, "dim"]]}
            size={18}
          />
        </g>
      ))}
      {S.crash != null && (
        <Burst x={472} y={301} t={t} at={S.crash} role="red" r0={9} r1={60} />
      )}
      {S.rings.map(([y, a, b, c], i) => (
        <Ring key={i} x={472} y={y} from={a} to={b} result={c} t={t} r={16} />
      ))}
    </>
  ),
};
