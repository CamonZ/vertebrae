import { act, cleanup, renderHook } from "@testing-library/react";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, expect, it } from "vitest";
import { useEntityPanelStore } from "../../../stores/entityPanelStore";
import { compileFlowOrThrow } from "../../MachineDiagram/flow/compile";
import { buildMachineFlow, machineId } from "./buildMachineFlow";
import { fixture } from "./machineFlow.fixture";
import { useAtlasPresentation } from "./useAtlasPresentation";

afterEach(() => {
  cleanup();
  useEntityPanelStore.getState().reset();
});

it("model oracle: pointer/focus/selection/edge precedence and reset across generated event sequences", () => {
  const input = fixture();
  const model = buildMachineFlow(input.summary, input.configs);
  const diagram = compileFlowOrThrow(model.spec).arrangements[0];
  const ids = [...model.selections.keys()];
  return hegel.test(
    (tc) => {
      useEntityPanelStore.getState().reset();
      const hook = renderHook(() => useAtlasPresentation(model, diagram));
      let hover: string | null = null;
      let focus: string | null = null;
      let latestInput = "hover";
      let selected: string | null = null;
      let edge: string | null = null;
      try {
        for (let i = 0; i < 25; i++) {
          const event = tc.draw(gs.integers({ minValue: 0, maxValue: 7 }));
          const id =
            ids[
              tc.draw(gs.integers({ minValue: 0, maxValue: ids.length - 1 }))
            ];
          act(() => {
            const live = hook.result.current;
            switch (event) {
              case 0:
                hover = id;
                latestInput = "hover";
                live.interaction.onHoverPart!(id);
                break;
              case 1:
                hover = null;
                live.interaction.onHoverPart!(null);
                break;
              case 2:
                focus = id;
                latestInput = "focus";
                live.presentation.onFocusRegion!(id);
                break;
              case 3:
                focus = null;
                live.presentation.onFocusRegion!(null);
                break;
              case 4:
                selected = id;
                edge = null;
                live.interaction.onActivatePart!(id);
                break;
              case 5:
                selected = null;
                edge = null;
                useEntityPanelStore.getState().close();
                break;
              case 6:
                edge =
                  diagram.rails[
                    tc.draw(
                      gs.integers({
                        minValue: 0,
                        maxValue: diagram.rails.length - 1,
                      })
                    )
                  ].id;
                useEntityPanelStore.getState().setHoveredEdge(edge);
                break;
              case 7:
                edge = null;
                useEntityPanelStore.getState().setHoveredEdge(null);
                break;
            }
          });
          const root =
            (latestInput === "hover" ? (hover ?? focus) : (focus ?? hover)) ??
            selected;
          const entity = selected ? model.selections.get(selected)! : undefined;
          const selectedIds = ids.filter((id) => {
            const candidate = model.selections.get(id)!;
            return (
              !!entity && JSON.stringify(candidate) === JSON.stringify(entity)
            );
          });
          const roots = new Set(focus || hover ? [root!] : selectedIds);
          for (const region of diagram.regions)
            if (roots.has(region.id))
              for (const id of region.parts) roots.add(id);
          // A traced workflow lights only the rails crossing its edge.
          const regionTrace =
            !!(focus || hover) &&
            diagram.regions.some((region) => region.id === root);
          const expectedRails = diagram.rails
            .filter((r) =>
              edge
                ? r.id === edge
                : regionTrace
                  ? roots.has(r.from.part) !== roots.has(r.to.part)
                  : roots.has(r.from.part) || roots.has(r.to.part)
            )
            .map((r) => r.id);
          expect([...hook.result.current.presentation.rails!].sort()).toEqual(
            expectedRails.sort()
          );
          expect(
            [...hook.result.current.presentation.selected!].sort()
          ).toEqual(selectedIds.sort());
        }
      } finally {
        hook.unmount();
      }
    },
    { testCases: 40 }
  );
});

it("removed hover/focus IDs stay retired on reintroduction; out-of-scope global selection is not destroyed", () => {
  const input = fixture();
  const model = buildMachineFlow(input.summary, input.configs);
  const diagram = compileFlowOrThrow(model.spec).arrangements[0];
  const empty = buildMachineFlow({ workflows: [] });
  const hook = renderHook(
    ({ current }) => useAtlasPresentation(current, diagram),
    { initialProps: { current: model } }
  );
  const id = machineId("step", "a", "choose");
  act(() => {
    hook.result.current.interaction.onHoverPart!(id);
    hook.result.current.interaction.onFocusPart!(id);
    useEntityPanelStore.getState().openStep("elsewhere", "other");
  });
  hook.rerender({ current: empty });
  hook.rerender({ current: model });
  expect([...hook.result.current.presentation.rails!]).toEqual([]);
  expect([...hook.result.current.presentation.selected!]).toEqual([]);
  expect(useEntityPanelStore.getState().selection).toEqual({
    type: "step",
    stepId: "elsewhere",
    workflowId: "other",
  });
});

it("marks cross-workflow rails as handoffs and lights a hovered rail with both ends", () => {
  const input = fixture();
  const model = buildMachineFlow(input.summary, input.configs);
  const diagram = compileFlowOrThrow(model.spec).arrangements[0];
  const hook = renderHook(() => useAtlasPresentation(model, diagram));
  const { handoffs } = hook.result.current.presentation;
  const cross = diagram.rails.filter((r) => {
    const t = model.transitions.get(r.id)!;
    return t.targetWorkflowId !== t.workflowId;
  });
  expect(cross.length).toBeGreaterThan(0);
  expect([...handoffs!].sort()).toEqual(cross.map((r) => r.id).sort());
  const rail = cross[0];
  act(() => hook.result.current.presentation.onHoverRail!(rail.id));
  const lit = hook.result.current.presentation;
  expect([...lit.rails!]).toEqual([rail.id]);
  expect(lit.traced!.has(rail.from.part)).toBe(true);
  expect(lit.traced!.has(rail.to.part)).toBe(true);
  act(() => hook.result.current.presentation.onHoverRail!(null));
  expect(hook.result.current.presentation.rails!.size).toBe(0);
});

it("traces a step's rails by direction and lists their other ends; a workflow lists only what crosses its edge", () => {
  const input = fixture();
  const model = buildMachineFlow(input.summary, input.configs);
  const diagram = compileFlowOrThrow(model.spec).arrangements[0];
  const hook = renderHook(() => useAtlasPresentation(model, diagram));
  const choose = machineId("step", "a", "choose");
  act(() => hook.result.current.interaction.onHoverPart!(choose));
  const { presentation, trace, tracing } = hook.result.current;
  expect(tracing).toBe(true);
  for (const r of diagram.rails) {
    const from = r.from.part === choose;
    const to = r.to.part === choose;
    expect(presentation.flow!.get(r.id)).toBe(
      from === to ? undefined : from ? "out" : "in"
    );
  }
  expect(trace).toMatchObject({ title: "choose", kind: "step" });
  const ends = trace!.connections.map((c) => [
    c.direction,
    c.step ?? c.workflow,
  ]);
  expect(ends).toEqual(
    expect.arrayContaining([
      ["in", "script"],
      ["out", "approve"],
      ["out", "llm"],
      // The inter-workflow decision ends at the empty workflow's endpoint.
      ["out", "empty"],
    ])
  );
  expect(trace!.connections.find((c) => c.step === "llm")?.label).toMatch(
    /^retry/
  );

  act(() => {
    hook.result.current.interaction.onHoverPart!(null);
    hook.result.current.presentation.onHoverRegion!(machineId("region", "a"));
  });
  const workflow = hook.result.current;
  expect(workflow.trace).toMatchObject({ title: "a", kind: "workflow" });
  expect(
    workflow.trace!.connections.every((c) => c.handoff && c.direction === "out")
  ).toBe(true);
  expect(new Set(workflow.trace!.connections.map((c) => c.workflow))).toEqual(
    new Set(["b", "empty"])
  );

  act(() => hook.result.current.presentation.onHoverRegion!(null));
  expect(hook.result.current.tracing).toBe(false);
  expect(hook.result.current.trace).toBeNull();
});
