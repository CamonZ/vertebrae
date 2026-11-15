import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Wire } from "../Rail";
import { pointAt, route, routePath } from "../route";
import { compileFlowLaidOut } from "./layout";
import { railCrossings } from "./crossings";
import { ROUTING_EXAMPLES } from "./routingExamples";

for (const example of ROUTING_EXAMPLES)
  test(example.name, async () => {
    const result = await compileFlowLaidOut(example.spec);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const d = result.flow.arrangements[0];
    if (example.name === "Parallel bus tracks")
      expect(
        d.rails.every((r) => r.cornerRadii !== undefined),
        JSON.stringify(d.rails)
      ).toBe(true);
    let crossings = 0;
    for (const [i, a] of d.rails.entries())
      for (const b of d.rails.slice(i + 1)) {
        const hits = railCrossings(a.points, b.points);
        crossings += hits.length;
        for (const hit of hits) {
          const jumps = [
            ...(a.jumps ?? []).filter((j) => j.segment === hit.a),
            ...(b.jumps ?? []).filter((j) => j.segment === hit.b),
          ].filter(
            (j) => Math.hypot(j.at[0] - hit.at[0], j.at[1] - hit.at[1]) < 0.01
          );
          expect(jumps).toHaveLength(1);
        }
      }
    if (example.name !== "Fixed-port K3,3") expect(crossings).toBe(0);
    else expect(crossings).toBeGreaterThan(0);
    for (const rail of d.rails) {
      const path = route(rail.points, undefined, rail);
      const markup = renderToStaticMarkup(
        <Wire
          points={rail.points}
          jumps={rail.jumps}
          cornerRadii={rail.cornerRadii}
        />
      );
      expect(markup).toContain(routePath(path));
      expect(pointAt(path, 0)).toEqual(rail.points[0]);
      expect(pointAt(path, 1)).toEqual(rail.points.at(-1));
      for (let i = 1; i <= 100; i++) {
        const a = pointAt(path, (i - 1) / 100);
        const b = pointAt(path, i / 100);
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(
          path.length / 100 + 0.01
        );
      }
    }
  });

test("forward and return buses replay with distinct pitched tracks", async () => {
  const original = ROUTING_EXAMPLES.find(
    (e) => e.name === "Parallel bus tracks"
  )!.spec;
  for (const parts of [original.parts, [...original.parts].reverse()]) {
    const result = await compileFlowLaidOut({ ...original, parts });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const [a, b] = result.flow.arrangements[0].rails;
    expect(a.cornerRadii).toBeDefined();
    expect(b.cornerRadii).toBeDefined();
    const horizontal = (r: typeof a) =>
      r.points.slice(1).flatMap((p, i) =>
        Math.abs(p[1] - r.points[i][1]) < 0.01
          ? [
              {
                x0: Math.min(p[0], r.points[i][0]),
                x1: Math.max(p[0], r.points[i][0]),
                y: p[1],
              },
            ]
          : []
      );
    expect(
      horizontal(a).some((x) =>
        horizontal(b).some(
          (y) =>
            Math.abs(Math.abs(x.y - y.y) - 20) < 0.5 &&
            Math.min(x.x1, y.x1) - Math.max(x.x0, y.x0) >= 80
        )
      )
    ).toBe(true);
  }
});

test("compiled cards traverse the rendered hops on a real non-planar flow", async () => {
  const spec = ROUTING_EXAMPLES.find((e) => e.name === "Fixed-port K3,3")!.spec;
  const result = await compileFlowLaidOut({
    ...spec,
    cards: spec.rails!.map((r) => ({
      id: `card-${r.id}`,
      token: "data",
      origin: r.from.split(".")[0],
    })),
    story: spec.rails!.map((r) => ({
      steps: [
        {
          part: r.to.split(".")[0],
          verb: "record",
          card: `card-${r.id}`,
          via: r.id,
        },
      ],
    })),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const d = result.flow.arrangements[0];
  const hopped = d.rails.filter((r) => r.jumps?.length);
  expect(hopped.length).toBeGreaterThan(0);
  for (const rail of hopped) {
    const card = d.travel.cards.find((c) => c.id === `card-${rail.id}`)!;
    expect(card).toBeDefined();
    const expected = route(rail.points, undefined, rail);
    expect(card.legs[0].route).toEqual(expected);
    expect(
      renderToStaticMarkup(<Wire points={rail.points} jumps={rail.jumps} />)
    ).toContain(routePath(expected));
    for (let i = 0; i <= 100; i++)
      expect(pointAt(card.legs[0].route, i / 100)).toEqual(
        pointAt(expected, i / 100)
      );
  }
});

test("same-side buses offset tracks with reversed geometric order at the destination", async () => {
  const result = await compileFlowLaidOut({
    version: 1,
    parts: [
      { id: "a", kind: "quorum" },
      { id: "b", kind: "quorum" },
    ],
    rails: [
      { id: "top", from: "a.r1", to: "b.r3", label: "first" },
      { id: "bottom", from: "a.r2", to: "b.r2", label: "second" },
    ],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const [a, b] = result.flow.arrangements[0].rails;
  expect(a.cornerRadii).toBeDefined();
  expect(b.cornerRadii).toBeDefined();
  expect(railCrossings(a.points, b.points)).toEqual([]);
});

test("bus routing supports north/south and west-facing port groups", async () => {
  const { createFlowRegistry } = await import("./defaults");
  const registry = createFlowRegistry({ builtins: false });
  const port = (side: "N" | "E" | "S" | "W", x: number, y: number) => ({
    side,
    x,
    y,
    direction: "both" as const,
    tokens: ["data" as const],
  });
  registry.parts.register({
    kind: "bus fixture",
    job: "routes synthetic buses",
    footprint: "M",
    bb: [200, 80, 240, 240],
    status: { x: 320, y: 360 },
    ports: {
      N0: port("N", 260, 80),
      N1: port("N", 380, 80),
      E0: port("E", 440, 140),
      E1: port("E", 440, 260),
      S0: port("S", 260, 320),
      S1: port("S", 380, 320),
      W0: port("W", 200, 140),
      W1: port("W", 200, 260),
    },
    verbs: { idle: { duration: 1, card: "none", compile() {} } },
  });
  for (const [from, to] of [
    ["N0", "S0"],
    ["S1", "N1"],
    ["W1", "E1"],
  ]) {
    const fromOther = from.endsWith("0") ? from[0] + "1" : from[0] + "0";
    const toOther = to.endsWith("0") ? to[0] + "1" : to[0] + "0";
    const result = await compileFlowLaidOut(
      {
        version: 1,
        parts: [
          { id: "a", kind: "bus fixture" },
          { id: "b", kind: "bus fixture" },
        ],
        rails: [
          {
            id: "first",
            from: `a.${from}`,
            to: `b.${to}`,
            label: "first bus track",
            conditional: true,
          },
          {
            id: "second",
            from: `a.${fromOther}`,
            to: `b.${toOther}`,
            label: "second bus track",
            conditional: true,
          },
        ],
      },
      { registry }
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const [a, b] = result.flow.arrangements[0].rails;
    expect(
      a.cornerRadii,
      `${from}/${to}: ${JSON.stringify([a.points, b.points])}`
    ).toBeDefined();
    expect(b.cornerRadii).toBeDefined();
    expect(railCrossings(a.points, b.points)).toEqual([]);
  }
});

test("a canonical embedding retry removes a crossing left by the preferred realization", async () => {
  const result = await compileFlowLaidOut({
    version: 1,
    parts: [
      { id: "p0", kind: "splitter" },
      { id: "p1", kind: "timeout" },
      { id: "p2", kind: "retry" },
      { id: "p3", kind: "human gate" },
      { id: "p4", kind: "session" },
    ],
    rails: [
      { id: "r0", from: "p0.b1", to: "p1.in" },
      { id: "r1", from: "p0.b2", to: "p4.turn" },
      { id: "r2", from: "p2.out", to: "p0.in" },
      { id: "r3", from: "p3.out", to: "p0.in" },
      { id: "r4", from: "p0.b1", to: "p0.in" },
      { id: "r5", from: "p2.out", to: "p3.in" },
    ],
    regions: [{ id: "g0", parts: ["p0", "p3", "p4"] }],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  for (const d of result.flow.arrangements) {
    expect(d.rails).toHaveLength(6);
    for (const [i, rail] of d.rails.entries()) {
      for (const other of d.rails.slice(i + 1))
        expect(railCrossings(rail.points, other.points)).toEqual([]);
      expect(rail.jumps ?? []).toEqual([]);
      const path = route(rail.points, undefined, rail);
      expect(
        renderToStaticMarkup(
          <Wire
            points={rail.points}
            jumps={rail.jumps}
            cornerRadii={rail.cornerRadii}
          />
        )
      ).toContain(routePath(path));
    }
  }
});
