import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PartContext } from "../partContext";
import { compileFlow, compileFlowOrThrow } from "./compile";
import { FlowDiagram } from "./FlowDiagram";
import { FLOW_DRAWINGS } from "./drawings";
import { compileFlowLaidOut } from "./layout";
import { decisionPort, routeTopology } from "./parts/topology";
import type { FlowSpec } from "./spec";

function routeSpec(names: readonly string[], defaultDecision = true): FlowSpec {
  const { rows } = routeTopology({ decisions: names, defaultDecision });
  return {
    version: 1,
    parts: [
      {
        id: "route",
        kind: "route step",
        props: { topology: true, decisions: names, defaultDecision },
      },
      { id: "target", kind: "execute step", props: { topology: true } },
    ],
    rails: rows.map(({ id }, i) => ({
      id: `r${i}`,
      from: `route.${id}`,
      to: i === 0 ? "route.in" : "target.in",
    })),
  };
}

function drawing(
  part: ReturnType<
    typeof compileFlowOrThrow
  >["arrangements"][number]["parts"][number]
) {
  return renderToStaticMarkup(
    <svg>
      <PartContext.Provider
        value={{
          fade: 1,
          removed: false,
          labels: true,
          hatchId: "h",
          inFlow: true,
        }}
      >
        {FLOW_DRAWINGS[part.kind as keyof typeof FLOW_DRAWINGS](0, part)}
      </PartContext.Provider>
    </svg>
  );
}

describe("workflow topology contracts", () => {
  it.each([0, 1, 3, 5, 8])(
    "routes all %i ordered decisions and a default using the shared router",
    async (count) => {
      const names = Array.from({ length: count }, (_, i) =>
        i === 2
          ? "a very long decision label with punctuation / and Unicode 漢字"
          : `named rule ${i}`
      );
      const result = await compileFlowLaidOut(routeSpec(names));
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      const diagram = result.flow.arrangements[0];
      const route = diagram.parts.find((p) => p.id === "route")!;
      const { rows } = routeTopology({
        decisions: names,
        defaultDecision: true,
      });
      expect(Object.keys(route.ports)).toEqual([
        "in",
        ...rows.map((r) => r.id),
      ]);
      for (const [i, rail] of diagram.rails.entries()) {
        const from = route.ports[rows[i].id];
        const target = diagram.parts.find((p) => p.id === rail.to.part)!;
        expect(rail.points[0]).toEqual([from.x, from.y]);
        expect(rail.points.at(-1)).toEqual([
          target.ports[rail.to.port].x,
          target.ports[rail.to.port].y,
        ]);
        expect(from.local).toEqual([rows[i].x, rows[i].y]);
        expect(rail.id).toBe(`r${i}`);
        if (rail.cornerRadii)
          expect(rail.cornerRadii).toHaveLength(rail.points.length);
      }
      const markup = drawing(route);
      const scene = renderToStaticMarkup(
        <FlowDiagram diagram={diagram} t={0} reducedMotion />
      );
      for (const name of names) expect(scene).toContain(name);
      expect(route.scale).toBe(1);
      expect(diagram.width).toBeGreaterThanOrEqual(
        route.position.x + (route.bb[0] + route.bb[2]) * route.scale
      );
      for (const row of rows) expect(markup).toContain(`data-port="${row.id}"`);
      for (const name of names) expect(markup).toContain(name);
      expect(markup).not.toMatch(/r1 yes|evaluating|review|docs|plan|NaN/);
    }
  );

  it("preserves rule/default identities through reordering, insertion and removal", () => {
    const names = ["default", "a.b", "a b", "漢字", "constructor", "__proto__"];
    const model = new Map(names.map((n) => [n, decisionPort(n)]));
    for (let shift = 0; shift < names.length; shift++) {
      const edited = [
        ...names.slice(shift),
        "inserted",
        ...names.slice(0, shift),
      ].filter((_, i) => i !== shift);
      const { rows } = routeTopology({
        decisions: edited,
        defaultDecision: true,
      });
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      expect(rows.at(-1)!.id).toBe("default");
      for (const row of rows.slice(0, -1))
        expect(row.id).toBe(model.get(row.label) ?? decisionPort("inserted"));
      expect(rows.map((r) => r.label)).toEqual([...edited, "default"]);
    }
  });

  it("supports an empty route with no default and rejects duplicate/malformed decisions", () => {
    expect(
      Object.keys(
        compileFlowOrThrow(routeSpec([], false)).arrangements[0].parts[0].ports
      )
    ).toEqual(["in"]);
    expect(compileFlow(routeSpec(["same", "same"])).ok).toBe(false);
    const malformed = routeSpec([]);
    const result = compileFlow({
      ...malformed,
      parts: [
        {
          id: "route",
          kind: "route step",
          props: { topology: true, decisions: null },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("uses complete labels in separate rows within the resolved frame", () => {
    const { bb, rows } = routeTopology({
      decisions: ["x".repeat(150), "y".repeat(150)],
      defaultDecision: true,
    });
    for (const row of rows) {
      expect(240 + row.label.length * 18).toBeLessThan(row.x - 32);
      expect(row.y).toBeGreaterThan(bb[1]);
      expect(row.y).toBeLessThan(bb[1] + bb[3]);
    }
    expect(rows[1].y - rows[0].y).toBeGreaterThan(18);
  });

  it("compiles real adjacent workflow types with topology transition tokens", async () => {
    for (const [fromKind, toKind, form] of [
      ["inference step", "route step"],
      ["inference step", "execute step"],
      ["execute step", "inference step"],
      ["inference step", "run end", "stop"],
      ["execute step", "run end", "finish"],
    ]) {
      const result = await compileFlowLaidOut({
        version: 1,
        parts: [
          { id: "a", kind: fromKind, props: { topology: true } },
          {
            id: "b",
            kind: toKind,
            props: { topology: true, ...(form ? { form } : {}) },
          },
        ],
        rails: [{ id: "transition", from: "a.out", to: "b.in" }],
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    expect(
      compileFlow({
        version: 1,
        parts: [
          { id: "a", kind: "inference step" },
          { id: "b", kind: "route step" },
        ],
        rails: [{ id: "r", from: "a.out", to: "b.in" }],
      }).ok
    ).toBe(false);
  });

  it.each([
    ["inference step", {}],
    ["structured step", {}],
    ["execute step", {}],
    ["route step", {}],
    ["wait children", {}],
    ["human gate", {}],
    ["run end", { form: "stop" }],
    ["run end", { form: "finish" }],
  ])(
    "renders neutral %s %j without invented runtime evidence",
    (kind, props) => {
      const part = compileFlowOrThrow({
        version: 1,
        parts: [{ id: "p", kind, props: { topology: true, ...props } }],
      }).arrangements[0].parts[0];
      const markup = drawing(part);
      expect(part.neutral).toBe(true);
      const full = renderToStaticMarkup(
        <FlowDiagram
          diagram={
            compileFlowOrThrow({
              version: 1,
              parts: [{ id: "p", kind, props: { topology: true, ...props } }],
            }).arrangements[0]
          }
          t={0}
        />
      );
      expect(full).not.toMatch(/idle|Now: idle|NaN/);
      expect(part.timeline.cards).toEqual([]);
      expect(markup).not.toMatch(
        /claude|typesafe|reviewer|approve the plan|tools|artifacts|cmd|c1|done|NaN/
      );
      if ("form" in props && props.form === "stop") {
        expect(markup).toContain('aria-label="Stop step"');
        expect(markup).not.toContain("md-terminal");
      }
      if ("form" in props && props.form === "finish") {
        expect(markup).toContain('aria-label="Finish step"');
        expect(markup).not.toContain(">stop<");
        expect(Object.keys(part.ports)).toEqual(["in"]);
      }
    }
  );
});

it("preserves resolved geometry and route metadata through the worker data boundary", async () => {
  const { layoutFlow, layoutFrom } = await import("./layout");
  const { createLayoutClient } = await import("./layoutClient");
  const spec = routeSpec(["one", "two", "three", "four", "five"]);
  const compiled = compileFlowOrThrow(spec);
  // A real worker receives only structured-cloneable compiler data. Run the
  // same shipped layout function after cloning, without replacing the router.
  const cloned = structuredClone(compiled);
  const viaClient = await createLayoutClient(undefined)(cloned);
  const direct = await layoutFlow(compiled, { cache: false });
  expect(viaClient).toEqual(direct);
  const a = compileFlowOrThrow(spec, { layout: layoutFrom(viaClient) });
  const b = compileFlowOrThrow(spec, { layout: layoutFrom(direct) });
  expect(a).toEqual(b);
});

it("reports incompatible overridden ports before compilation rather than crashing", () => {
  const source = routeSpec(["keep", "removed"]);
  const result = compileFlow({
    ...source,
    parts: source.parts.map((p) =>
      p.id === "route"
        ? {
            ...p,
            change: "changed",
            after: { props: { decisions: ["keep"] } },
          }
        : p
    ),
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(
      result.errors.some((e) =>
        e.message.includes("not compatible in every arrangement")
      )
    ).toBe(true);
});

it("resolves each arrangement from the original contract when topology mode changes", () => {
  const flow = compileFlowOrThrow({
    version: 1,
    parts: [
      {
        id: "p",
        kind: "route step",
        change: "changed",
        props: {
          topology: true,
          decisions: ["actual rule"],
          defaultDecision: true,
        },
        after: { props: { topology: false } },
      },
    ],
  });
  expect(Object.keys(flow.arrangements[0].parts[0].ports)).toEqual([
    "in",
    decisionPort("actual rule"),
    "default",
  ]);
  expect(Object.keys(flow.arrangements[1].parts[0].ports)).toEqual([
    "in",
    "out1",
    "out2",
    "out3",
  ]);
});

it.each([0, 1, 3, 4, 8])(
  "keeps the legacy three-port drawing unchanged with %i targets",
  (count) => {
    const targets = Array.from(
      { length: count },
      (_, i) => `legacy_target_${i}`
    );
    const part = (labels: string[]) =>
      compileFlowOrThrow({
        version: 1,
        parts: [
          {
            id: "route",
            kind: "route step",
            props: { targets: labels },
          },
        ],
      }).arrangements[0].parts[0];
    expect(drawing(part(targets))).toBe(drawing(part(targets.slice(0, 3))));
    expect(Object.keys(part(targets).ports)).toEqual([
      "in",
      "out1",
      "out2",
      "out3",
    ]);
  }
);

it("accepts only forms that the selected end mode actually renders", () => {
  for (const topology of [false, true])
    for (const form of [undefined, "combined", "stop", "finish"]) {
      const valid = topology
        ? form === "stop" || form === "finish"
        : form === undefined || form === "combined";
      const result = compileFlow({
        version: 1,
        parts: [
          {
            id: "end",
            kind: "run end",
            props: {
              topology,
              ...(form ? { form } : {}),
            },
          },
        ],
      });
      expect(result.ok, `${topology}/${form}`).toBe(valid);
      if (!result.ok) {
        expect(
          result.errors.some((error) => error.path.endsWith("props.form"))
        ).toBe(true);
        continue;
      }
      const part = result.flow.arrangements[0].parts[0];
      const markup = drawing(part);
      if (topology) {
        expect(markup).toContain(
          `aria-label="${form === "stop" ? "Stop" : "Finish"} step"`
        );
        expect(Object.keys(part.ports)).toEqual(
          form === "stop" ? ["in", "out"] : ["in"]
        );
      } else {
        expect(markup).toContain(">stop<");
        expect(markup).toContain(">finish<");
      }
    }
});

it("keeps the documented shared scale across mode toggles and honours explicit scale in mixed flows", () => {
  for (const topology of [false, true])
    for (const scale of [undefined, 0.75, 1.25]) {
      const flow = compileFlowOrThrow({
        version: 1,
        parts: [
          {
            id: "mixed",
            kind: "route step",
            change: "changed",
            props: { topology, decisions: ["actual"] },
            ...(scale === undefined ? {} : { scale }),
            after: { props: { topology: !topology } },
          },
          { id: "legacy", kind: "execute step" },
          { id: "static", kind: "execute step", props: { topology: true } },
        ],
      });
      for (const d of flow.arrangements) {
        expect(d.parts[0].scale).toBe(scale ?? 1);
        expect(d.parts[1].scale).toBe(0.75);
        expect(d.parts[2].scale).toBe(1);
      }
    }
});

it("hides neutral status in rendering, accessibility and layout even with nonempty timeline notes", async () => {
  const { partLabelsLocal } = await import("./extent");
  const flow = compileFlowOrThrow({
    version: 1,
    parts: [{ id: "route", kind: "route step", props: { topology: true } }],
  });
  const d = flow.arrangements[0];
  const part = d.parts[0];
  // Retain real timeline notes, then poison them to prove suppression is an
  // explicit renderer rule rather than reliance on a blank note's formatting.
  expect(part.timeline.notes.some((note) => note[1] === "idle")).toBe(true);
  const poisoned = {
    ...part,
    timeline: {
      ...part.timeline,
      notes: [[0, "INVENTED_SUCCESS", "green"] as const],
    },
  };
  const markup = renderToStaticMarkup(
    <FlowDiagram
      diagram={{ ...d, parts: [poisoned] }}
      t={0}
      interaction={{ onActivatePart: () => {} }}
    />
  );
  expect(markup).not.toMatch(/INVENTED_SUCCESS|md-status|Now:/);
  expect(markup).toContain('role="button"');
  expect(
    partLabelsLocal(poisoned).some((label) => label.kind === "status")
  ).toBe(false);
  const legacy = renderToStaticMarkup(
    <FlowDiagram
      diagram={{ ...d, parts: [{ ...poisoned, neutral: false }] }}
      t={0}
      interaction={{ onActivatePart: () => {} }}
    />
  );
  expect(legacy).toContain("INVENTED_SUCCESS");
  expect(legacy).toContain("md-status");
});
