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
          const expectedRails = diagram.rails
            .filter((r) =>
              edge
                ? r.id === edge
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
