import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonValue, PipelineSummary } from "../../../bindings";
import { createFlowRegistry } from "../../MachineDiagram/flow/defaults";
import * as client from "../../MachineDiagram/flow/layoutClient";
import type { FlowRegistry } from "../../MachineDiagram/flow/registry";
import { buildMachineFlow, machineId } from "./buildMachineFlow";
import { step, workflow } from "./machineFlow.fixture";
import { useAtlasMachineFlow } from "./useAtlasMachineFlow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Input {
  summary: PipelineSummary;
  configs: Map<string, JsonValue | null>;
  scope: string;
  registry?: FlowRegistry;
  hover?: string;
  selection?: string;
}
const initial = (): Input => ({
  summary: {
    workflows: [
      workflow("a", [step("choose", "route", 0), step("target", "execute", 1)]),
    ],
  },
  configs: new Map([
    [
      "choose",
      {
        rules: [
          {
            id: "one",
            transition: { type: "intra_workflow", step_id: "target" },
          },
          {
            id: "two",
            transition: { type: "intra_workflow", step_id: "choose" },
          },
        ],
      },
    ],
  ]),
  scope: "project/factory",
});

it("keeps structural identity and worker request count stable during count/hover/selection updates, including while pending", async () => {
  // Observe the real shared client; the compiler, layout and cache are not mocked.
  const requests = vi.spyOn(client, "layoutFlowOffThread");
  const input = initial();
  const hook = renderHook(
    (props: Input) =>
      useAtlasMachineFlow(
        props.summary,
        props.configs,
        props.scope,
        props.registry
      ),
    { initialProps: input }
  );
  const originalSpec = hook.result.current.spec;
  const key = hook.result.current.structuralKey;
  expect(requests).toHaveBeenCalledTimes(1);
  for (let n = 1; n <= 12; n++) {
    const changed = structuredClone(input);
    changed.summary.workflows[0].workflow_steps[0].pipeline_counts = {
      epic: n,
      ticket: 2 * n,
      task: 3 * n,
      active: n,
    };
    changed.summary.workflows[0].workflow_steps[0].task_counts.task = n;
    changed.summary.workflows[0].workflow_steps[0].active_count = n;
    changed.hover = `hover-${n}`;
    changed.selection = `selection-${n}`;
    hook.rerender(changed);
    expect(hook.result.current.spec).toBe(originalSpec);
    expect(hook.result.current.structuralKey).toBe(key);
    expect(
      hook.result.current.counts.get(machineId("step", "a", "choose"))
    ).toEqual({ total: 6 * n, running: n });
  }
  await waitFor(() => expect(hook.result.current.layout.status).toBe("done"), {
    timeout: 15000,
  });
  hook.rerender({ ...input, selection: "after layout" });
  expect(hook.result.current.spec).toBe(originalSpec);
  expect(requests).toHaveBeenCalledTimes(1);
});

it("invalidates compile/layout for names, sessions, decisions, targets, port order, scope and registry geometry", async () => {
  const requests = vi.spyOn(client, "layoutFlowOffThread");
  let input = initial();
  const hook = renderHook(
    (props: Input) =>
      useAtlasMachineFlow(
        props.summary,
        props.configs,
        props.scope,
        props.registry
      ),
    { initialProps: input }
  );
  const settled = () =>
    waitFor(() => expect(hook.result.current.layout.status).toBe("done"), {
      timeout: 15000,
    });
  await settled();
  const change = async (edit: (next: Input) => void, geometry = false) => {
    const oldSpec = hook.result.current.spec;
    const calls = requests.mock.calls.length;
    // Registry contains functions, so clone only the backend data.
    input = {
      ...input,
      summary: structuredClone(input.summary),
      configs: structuredClone(input.configs),
    };
    edit(input);
    hook.rerender(input);
    if (!geometry) expect(hook.result.current.spec).not.toBe(oldSpec);
    expect(requests.mock.calls.length).toBe(calls + 1);
    await settled();
  };
  await change((next) => {
    next.summary.workflows[0].name = "Renamed workflow";
  });
  await change((next) => {
    next.summary.workflows[0].workflow_steps[1].name = "Longer target name";
  });
  await change((next) => {
    next.configs = new Map([
      [
        "choose",
        {
          rules: [
            {
              id: "one",
              transition: { type: "intra_workflow", step_id: "target" },
              session: { mode: "resume", step_id: "target" },
            },
            {
              id: "two",
              transition: { type: "intra_workflow", step_id: "choose" },
            },
          ],
        },
      ],
    ]);
  });
  await change((next) => {
    next.configs = new Map([
      [
        "choose",
        {
          rules: [
            {
              id: "two",
              transition: { type: "intra_workflow", step_id: "choose" },
            },
            {
              id: "one",
              transition: { type: "intra_workflow", step_id: "target" },
              session: { mode: "resume", step_id: "target" },
            },
          ],
        },
      ],
    ]);
  });
  await change((next) => {
    next.configs = new Map([
      [
        "choose",
        {
          rules: [
            {
              id: "two",
              transition: { type: "intra_workflow", step_id: "target" },
            },
            {
              id: "renamed decision",
              transition: { type: "intra_workflow", step_id: "target" },
            },
          ],
        },
      ],
    ]);
  });
  await change((next) => {
    next.summary.workflows[0].workflow_steps.push(step("new", "finish", 2));
  });
  await change((next) => {
    next.scope = "other-project/factory";
  });
  await change((next) => {
    const source = createFlowRegistry();
    const registry = createFlowRegistry({ builtins: false });
    for (const kind of source.parts.kinds()) {
      const def = source.parts.get(kind)!;
      registry.parts.register(
        kind === "execute step" ? { ...def, bb: [180, 120, 350, 180] } : def
      );
    }
    next.registry = registry;
  }, true);
  const diagram = hook.result.current.layout;
  expect(diagram.status).toBe("done");
  if (diagram.status === "done" && diagram.result.ok)
    expect(
      diagram.result.flow.arrangements[0].parts.find(
        (part) => part.kind === "execute step"
      )?.bb
    ).toEqual([180, 120, 350, 180]);
});

it("keeps decision rail IDs/ports under reordered, inserted and removed rules; order still invalidates geometry", () => {
  const input = initial();
  const rules = ["a.b", "a b", "default", "漢字", "constructor"].map((id) => ({
    id,
    transition: { type: "intra_workflow", step_id: "target" },
  }));
  const build = (entries: typeof rules) =>
    buildMachineFlow(input.summary, new Map([["choose", { rules: entries }]]));
  const original = build(rules);
  const expected = new Map(
    original.spec.rails!.map((r) => [r.label, [r.id, r.from, r.to]])
  );
  for (let n = 1; n < rules.length; n++) {
    const entries = [
      ...rules.slice(n),
      {
        id: "inserted",
        transition: { type: "intra_workflow", step_id: "target" },
      },
      ...rules.slice(0, n - 1),
    ];
    const edited = build(entries);
    expect(edited.structuralKey).not.toBe(original.structuralKey);
    for (const rail of edited.spec.rails!)
      if (expected.has(rail.label))
        expect([rail.id, rail.from, rail.to]).toEqual(expected.get(rail.label));
  }
});

it("uses injective valid IDs across adversarial tuples and backend punctuation", () => {
  const names = [
    "",
    ".",
    "_",
    "a.b",
    "a",
    "b",
    "漢字",
    "😀",
    "\ud800",
    "constructor",
    "__proto__",
  ];
  const ids = new Set<string>();
  for (const a of names)
    for (const b of names) {
      const id = machineId("step", a, b);
      expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
});
