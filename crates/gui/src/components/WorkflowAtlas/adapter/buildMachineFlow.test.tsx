import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileFlowOrThrow } from "../../MachineDiagram/flow/compile";
import { createFlowRegistry } from "../../MachineDiagram/flow/defaults";
import { FlowDiagram } from "../../MachineDiagram/flow/FlowDiagram";
import { layoutFlow, layoutFrom } from "../../MachineDiagram/flow/layout";
import { layoutFlowOffThread } from "../../MachineDiagram/flow/layoutClient";
import { decisionPort } from "../../MachineDiagram/flow/parts/topology";
import { buildMachineFlow, machineId } from "./buildMachineFlow";
import { fixture, step, workflow } from "./machineFlow.fixture";

const p = (wf: string, id: string) => machineId("step", wf, id);
const w = (wf: string) => machineId("workflow", wf);

// Independent semantic inventory: no traversal of the adapter's graph to derive expectations.
const expected = [
  ["inferred", "a", "llm", "a", "typed", "", ""],
  ["inferred", "a", "typed", "a", "script", "", ""],
  ["explicit", "a", "script", "a", "choose", "", ""],
  ["explicit", "a", "script", "a", "llm", "", "resume · typed"],
  ["decision", "a", "choose", "a", "llm", "retry", "retry · resume · typed"],
  ["decision", "a", "choose", "a", "choose", "self", "self · new"],
  ["decision", "a", "choose", "a", "done", "yes", "yes · new"],
  ["decision", "a", "choose", "a", "done", "also", "also · fork · llm"],
  ["decision", "a", "choose", "empty", "", "elsewhere", "elsewhere · new"],
  ["decision", "a", "choose", "a", "approve", "default", "default · new"],
  ["inferred", "a", "approve", "a", "join", "", ""],
  ["inferred", "a", "join", "a", "pause", "", ""],
  ["inferred", "a", "pause", "a", "done", "", ""],
  ["inferred", "b", "start", "b", "end", "", ""],
  ["handoff", "a", "", "b", "end", "", "deliver"],
  ["handoff", "a", "", "b", "start", "", "restart"],
  ["handoff", "a", "", "empty", "", "", "empty handoff"],
  ["handoff", "empty", "", "b", "start", "", "empty origin"],
].sort();

it("preserves an independent entity/port/label inventory through the real compiler and shared layout client", async () => {
  const { summary, configs } = fixture();
  const adapted = buildMachineFlow(summary, configs);
  expect(adapted.diagnostics).toEqual([]);
  const registry = createFlowRegistry();
  const compiled = compileFlowOrThrow(adapted.spec, { registry });
  // A worker must receive resolved ports and data, never a registry or React drawing.
  const cloned = structuredClone(compiled);
  expect(cloned).toEqual(compiled);
  const layout = await layoutFlowOffThread(cloned);
  expect(layout).toEqual(await layoutFlow(compiled, { cache: false }));
  const diagram = compileFlowOrThrow(adapted.spec, {
    registry,
    layout: layoutFrom(layout),
  }).arrangements[0];
  expect(diagram.parts.map((part) => [part.id, part.kind]).sort()).toEqual(
    [
      [w("a"), "topology endpoint"],
      [w("b"), "topology endpoint"],
      [w("empty"), "topology endpoint"],
      ...[
        ["llm", "inference step"],
        ["typed", "structured step"],
        ["script", "execute step"],
        ["choose", "route step"],
        ["approve", "human gate"],
        ["join", "wait children"],
        ["pause", "run end"],
        ["done", "run end"],
      ].map(([id, kind]) => [p("a", id), kind]),
      [p("b", "start"), "execute step"],
      [p("b", "end"), "run end"],
    ].sort()
  );
  for (const wf of summary.workflows) {
    const region = diagram.regions.find(
      (r) => r.id === machineId("region", wf.id)
    )!;
    expect(region.parts).toEqual([
      w(wf.id),
      ...wf.workflow_steps.map((s) => p(wf.id, s.id)),
    ]);
    expect(adapted.selections.get(region.id)).toEqual({
      type: "workflow",
      workflowId: wf.id,
    });
    for (const s of wf.workflow_steps) {
      expect(adapted.selections.get(p(wf.id, s.id))).toEqual({
        type: "step",
        workflowId: wf.id,
        stepId: s.id,
      });
    }
  }
  expect(
    diagram.parts.find((part) => part.id === p("a", "pause"))?.props.form
  ).toBe("stop");
  expect(
    diagram.parts.find((part) => part.id === p("a", "done"))?.props.form
  ).toBe("finish");
  expect(
    Object.keys(
      diagram.parts.find((part) => part.id === p("a", "choose"))!.ports
    )
  ).toEqual([
    "in",
    ...["retry", "self", "yes", "also", "elsewhere"].map(decisionPort),
    "default",
  ]);
  const inventory = (
    rails: typeof diagram.rails | NonNullable<typeof adapted.spec.rails>
  ) =>
    rails
      .map((r) => {
        const m = adapted.transitions.get(r.id)!;
        return [
          m.kind,
          m.workflowId,
          m.stepId ?? "",
          m.targetWorkflowId,
          m.targetStepId ?? "",
          m.decisionId ?? "",
          r.label ?? "",
        ];
      })
      .sort();
  expect(inventory(adapted.spec.rails!)).toEqual(expected);
  expect(inventory(diagram.rails)).toEqual(expected);
  for (const r of diagram.rails) {
    const m = adapted.transitions.get(r.id)!;
    const from = diagram.parts.find((part) => part.id === r.from.part)!;
    const to = diagram.parts.find((part) => part.id === r.to.part)!;
    expect(r.from.part).toBe(
      m.stepId ? p(m.workflowId, m.stepId) : w(m.workflowId)
    );
    expect(r.to).toEqual({
      part: m.targetStepId
        ? p(m.targetWorkflowId, m.targetStepId)
        : w(m.targetWorkflowId),
      port: "in",
    });
    expect(r.from.port).toBe(
      m.kind === "decision"
        ? m.decisionId === "default"
          ? "default"
          : decisionPort(m.decisionId!)
        : "out"
    );
    expect(r.points[0]).toEqual([
      from.ports[r.from.port].x,
      from.ports[r.from.port].y,
    ]);
    expect(r.points.at(-1)).toEqual([to.ports.in.x, to.ports.in.y]);
    const route = layout.routes![r.id];
    expect(r.points).toHaveLength(route.points.length);
    // Compilation snaps route ends to resolved ports; arithmetic order may
    // differ by floating point roundoff without changing the geometry.
    r.points.forEach((point, i) =>
      point.forEach((coordinate, axis) =>
        expect(coordinate).toBeCloseTo(route.points[i][axis], 8)
      )
    );
    expect(r.jumps).toEqual(route.jumps);
    expect(r.cornerRadii).toEqual(route.cornerRadii);
    expect(r.labelAt).toEqual(route.labelAt);
  }
  expect(new Set(diagram.rails.map((r) => r.id)).size).toBe(expected.length);
  const markup = renderToStaticMarkup(
    <FlowDiagram diagram={diagram} t={0} reducedMotion />
  );
  // Workflow endpoints are small handles named by what leaves through them.
  expect(markup).toContain(">handoffs<");
  expect(markup).not.toContain("workflow endpoint");
  expect(markup).toContain("retry · resume · typed");
  expect(markup).not.toMatch(/NaN|evaluating rules|3 children forked/);
}, 15000);

describe("fallbacks", () => {
  it("retains unknown steps, empty workflows and malformed/dangling diagnostics without invalid specs", async () => {
    const a = workflow("a", [
      step("unknown", null, 0),
      step("choose", "route", 1),
      step("done", "finish", 2),
      step("after", "execute", 3),
    ]);
    a.workflow_steps[0].transitions_to = ["missing"];
    a.transitions = [
      {
        id: "missing",
        from_workflow_id: "a",
        to_workflow_id: "absent",
        target_step_id: null,
        label: "",
      },
      {
        id: "fallback",
        from_workflow_id: "a",
        to_workflow_id: "a",
        target_step_id: "missing",
        label: "",
      },
    ];
    a.initial_step_id = "also-missing";
    const adapted = buildMachineFlow(
      { workflows: [a, workflow("empty")] },
      new Map([
        [
          "choose",
          {
            rules: [
              {
                id: "dangling",
                transition: { type: "intra_workflow", step_id: "missing" },
              },
              {
                id: "bad",
                transition: { type: "inter_workflow", workflow_id: "absent" },
              },
            ],
          },
        ],
      ])
    );
    const flow = compileFlowOrThrow(adapted.spec);
    const laid = await layoutFlowOffThread(structuredClone(flow));
    expect(
      compileFlowOrThrow(adapted.spec, { layout: layoutFrom(laid) })
        .arrangements[0].parts
    ).toHaveLength(7);
    expect(adapted.diagnostics.join("\n")).toMatch(/unknown type null/);
    expect(adapted.diagnostics.join("\n")).toMatch(
      /dangling transition missing/
    );
    expect(adapted.diagnostics.join("\n")).toMatch(/dangling step missing/);
    expect(adapted.diagnostics.join("\n")).toMatch(/unresolved destination/);
    expect(adapted.diagnostics.join("\n")).toMatch(/outside scope or missing/);
    expect(adapted.diagnostics.join("\n")).toMatch(/missing initial step/);
    expect(adapted.diagnostics.join("\n")).toMatch(/logical ordering endpoint/);
    expect(
      adapted.transitions.get(machineId("handoff", "fallback"))?.targetStepId
    ).toBe("unknown");
    expect(
      flow.arrangements[0].parts.find((part) => part.id === p("a", "unknown"))
        ?.neutral
    ).toBe(true);
    expect(
      flow.arrangements[0].parts.find((part) => part.id === p("a", "done"))
        ?.ports.out
    ).toBeUndefined();
  });

  it.each([null, {}, { rules: [null, 1, {}], default: {} }])(
    "unknown config %j remains neutral",
    (config) => {
      const summary = {
        workflows: [
          workflow("a", [
            step("choose", "route", 0),
            step("next", "execute", 1),
          ]),
        ],
      };
      const adapted = buildMachineFlow(summary, new Map([["choose", config]]));
      expect(
        compileFlowOrThrow(adapted.spec).arrangements[0].parts.find(
          (part) => part.id === p("a", "choose")
        )?.neutral
      ).toBe(true);
      expect(adapted.spec.rails).toHaveLength(1);
    }
  );

  it("disambiguates duplicate/default/punctuation rule IDs without collapsing ports", () => {
    const rules = ["same", "same", "same [rule-0]", "default", "漢字.a"].map(
      (id) => ({
        id,
        transition: { type: "intra_workflow", step_id: "choose" },
      })
    );
    const adapted = buildMachineFlow(
      { workflows: [workflow("a", [step("choose", "route", 0)])] },
      new Map([
        [
          "choose",
          {
            rules,
            default: {
              transition: { type: "intra_workflow", step_id: "choose" },
            },
          },
        ],
      ])
    );
    const diagram = compileFlowOrThrow(adapted.spec).arrangements[0];
    expect(diagram.rails).toHaveLength(6);
    expect(new Set(diagram.rails.map((r) => r.from.port)).size).toBe(6);
    expect(adapted.diagnostics.join()).toContain("duplicate decision IDs");
    expect(
      [...adapted.transitions.values()]
        .filter((m) => m.decisionId === "default")
        .map((m) => m.decisionKey)
    ).toEqual(["rule-3", "default"]);
  });
});

it("uses a valid initial step for invalid explicit handoff targets, then first step when no initial is declared", () => {
  const from = workflow("source");
  const to = workflow("destination", [
    step("first", "execute", 0),
    step("initial", "finish", 1),
  ]);
  to.initial_step_id = "initial";
  from.transitions = [
    {
      id: "fallback",
      from_workflow_id: from.id,
      to_workflow_id: to.id,
      target_step_id: "missing",
      label: "",
    },
  ];
  const build = () => buildMachineFlow({ workflows: [from, to] });
  expect(
    build().transitions.get(machineId("handoff", "fallback"))?.targetStepId
  ).toBe("initial");
  to.initial_step_id = null;
  const result = build();
  expect(
    result.transitions.get(machineId("handoff", "fallback"))?.targetStepId
  ).toBe("first");
  expect(() => compileFlowOrThrow(result.spec)).not.toThrow();
});

it("preserves session labels on non-route explicit jumps as well as inferred adjacency", () => {
  const wf = workflow("a", [
    step("source", "execute", 0),
    step("middle", "human_input", 1),
    step("last", "finish", 2),
  ]);
  wf.workflow_steps[0].transitions_to = ["last"];
  wf.workflow_steps[0].transition_sessions = {
    last: { mode: "fork", step_id: "middle" },
  };
  const adapted = buildMachineFlow({ workflows: [wf] });
  expect(
    adapted.spec.rails?.find(
      (r) => r.id === machineId("transition", "a", "source", "last")
    )?.label
  ).toBe("fork · middle");
  expect(() => compileFlowOrThrow(adapted.spec)).not.toThrow();
});

it("uses short destination names for synthetic rows while preserving UUID-based rail identities", () => {
  const ids = [
    "70d733b1-ae09-457a-b7fe-9b062e7ef233",
    "91fc4222-77ea-44da-841f-a4a5219a9721",
    "b326a177-327b-46da-96bc-a6bfb99e6ec3",
  ];
  const targets = ids.map((id, i) => ({
    ...step(id, "execute", i + 1),
    name: "Next",
  }));
  const wf = workflow("a", [step("route", "route", 0), ...targets]);
  wf.workflow_steps[0].transitions_to = ids.slice(1);
  const adapted = buildMachineFlow({ workflows: [wf] });
  const flow = compileFlowOrThrow(adapted.spec);
  const route = flow.arrangements[0].parts.find(
    (part) => part.id === p("a", "route")
  )!;
  expect(route.props.decisions).toEqual([
    "Transition → Next",
    "Transition → Next (inferred)",
    "Inferred next → Next",
  ]);
  expect(route.bb[2]).toBeLessThan(1032);
  const markup = renderToStaticMarkup(
    <FlowDiagram diagram={flow.arrangements[0]} t={0} reducedMotion />
  );
  for (const id of ids) expect(markup).not.toContain(id);
  const originalRails = ids.map((id) =>
    machineId("transition", "a", "route", id)
  );
  expect(
    adapted.spec
      .rails!.filter((rail) => originalRails.includes(rail.id))
      .map((rail) => rail.id)
      .sort()
  ).toEqual([...originalRails].sort());
  wf.workflow_steps[1].name = "Renamed";
  const renamed = buildMachineFlow({ workflows: [wf] });
  expect(renamed.structuralKey).not.toBe(adapted.structuralKey);
  expect(renamed.spec.rails!.map((rail) => rail.id)).toEqual(
    adapted.spec.rails!.map((rail) => rail.id)
  );
  expect(
    renamed.spec.parts.find((part) => part.id === p("a", "route"))?.props
      ?.decisions
  ).toContain("Inferred next → Renamed");
});

it.each([
  { missing: [] },
  { missing: ["missing"] },
  { missing: ["missing", "also-missing"] },
])(
  "does not create a finish ordering endpoint for invalid targets $missing",
  ({ missing }) => {
    const finish = step("finish", "finish", 0);
    finish.transitions_to = missing;
    const adapted = buildMachineFlow({ workflows: [workflow("a", [finish])] });
    expect(adapted.spec.parts.map((part) => part.id)).toEqual([
      w("a"),
      p("a", "finish"),
    ]);
    expect(adapted.spec.regions![0].parts).toEqual([w("a"), p("a", "finish")]);
    expect(adapted.spec.rails).toEqual([]);
    expect(adapted.diagnostics).toEqual(
      missing.map((id) => `Step finish: dangling transition ${id}`)
    );
    expect(
      compileFlowOrThrow(adapted.spec).arrangements[0].parts.every(
        (part) => part.neutral
      )
    ).toBe(true);
  }
);

it("creates exactly one neutral finish ordering endpoint for valid links mixed with dangling targets", () => {
  const before = step("before", "execute", 0);
  const finish = step("finish", "finish", 1);
  finish.transitions_to = ["missing", "before", "before"];
  const adapted = buildMachineFlow({
    workflows: [workflow("a", [before, finish])],
  });
  const ordering = machineId("ordering", "a", "finish");
  const diagram = compileFlowOrThrow(adapted.spec).arrangements[0];
  expect(diagram.parts.find((part) => part.id === ordering)).toMatchObject({
    kind: "topology endpoint",
    neutral: true,
  });
  expect(
    diagram.rails.filter((rail) => rail.from.part === ordering)
  ).toHaveLength(1);
  expect(adapted.selections.get(ordering)).toEqual({
    type: "step",
    workflowId: "a",
    stepId: "finish",
  });
});

it.each(["new", "resume", "fork"] as const)(
  "omits a redundant destination step from %s decision labels",
  (mode) => {
    const summary = {
      workflows: [
        workflow("a", [step("route", "route", 0), step("dest", "execute", 1)]),
      ],
    };
    const rules = [
      {
        id: "same",
        transition: { type: "intra_workflow", step_id: "dest" },
        session: { mode, step_id: "dest" },
      },
      {
        id: "different",
        transition: { type: "intra_workflow", step_id: "dest" },
        session: { mode, step_id: "route" },
      },
    ];
    const adapted = buildMachineFlow(summary, new Map([["route", { rules }]]));
    expect(adapted.spec.rails!.map((rail) => rail.label)).toEqual([
      `same · ${mode}`,
      `different · ${mode} · route`,
    ]);
  }
);
