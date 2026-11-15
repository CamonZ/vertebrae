import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useEntityPanelStore } from "../../../stores/entityPanelStore";
import { MachineDiagramViewport } from "../../MachineDiagram/MachineDiagramViewport";
import * as compiler from "../../MachineDiagram/flow/compile";
import { FlowScene } from "../../MachineDiagram/flow/FlowDiagram";
import { route, routePath } from "../../MachineDiagram/route";
import { AtlasMachineScene } from "./AtlasMachineScene";
import { buildMachineFlow, machineId } from "./buildMachineFlow";
import { fixture } from "./machineFlow.fixture";
import { useAtlasMachineFlow } from "./useAtlasMachineFlow";

// Instrument postMessage at the actual client boundary. Execute the real layout
// engine for replies rather than replacing compiler/router output with a stub.
const worker = vi.hoisted(() => {
  const requests: unknown[] = [];
  class Worker {
    onmessage: ((event: unknown) => void) | null = null;
    onerror = null;
    terminate() {}
    async postMessage(request: { id: number; flow: unknown }) {
      requests.push(request);
      const { layoutFlow } = await import("../../MachineDiagram/flow/layout");
      const layout = await layoutFlow(
        request.flow as Parameters<typeof layoutFlow>[0]
      );
      this.onmessage?.({ data: { id: request.id, layout } });
    }
  }
  vi.stubGlobal("Worker", Worker);
  return { requests };
});

afterEach(() => {
  cleanup();
  useEntityPanelStore.getState().reset();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
});

it("real scene activates exact entities, traces neighbours and individual parallel rails without compile/worker/camera changes", async () => {
  const input = fixture();
  input.summary.workflows[0].name = "A workflow with a very long name ".repeat(
    8
  );
  let latest: ReturnType<typeof useAtlasMachineFlow> | undefined;
  function Host({ data }: { data: typeof input }) {
    const model = useAtlasMachineFlow(data.summary, data.configs, "scene-test");
    latest = model;
    const diagram =
      model.layout.status === "done" && model.layout.result.ok
        ? model.layout.result.flow.arrangements[0]
        : undefined;
    return (
      <MachineDiagramViewport
        width={diagram?.width ?? 0}
        height={diagram?.height ?? 0}
        ready={!!diagram}
        fitOnMount
        mode="full-page"
      >
        {diagram && (
          <AtlasMachineScene
            model={model}
            diagram={diagram}
            t={0}
            reducedMotion
          />
        )}
      </MachineDiagramViewport>
    );
  }
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  const compile = vi.spyOn(compiler, "compileFlow");
  const view = render(<Host data={input} />);
  await waitFor(
    () =>
      expect(
        view.container.querySelector("[data-region-header]")
      ).not.toBeNull(),
    { timeout: 20000 }
  );
  const model = latest!;
  if (model.layout.status !== "done" || !model.layout.result.ok)
    throw new Error("layout failed");
  const diagram = model.layout.result.flow.arrangements[0];
  const geometry = JSON.stringify(diagram);
  const spec = model.spec;
  const compileCalls = compile.mock.calls.length;
  const requests = worker.requests.length;
  const camera = () =>
    view.container.querySelector<HTMLElement>(".md-stage")!.style.transform;
  fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
  const cameraBefore = camera();
  const header = view.container.querySelector(
    `[data-region-header="${machineId("region", "a")}"]`
  )!;
  const part = (id: string) =>
    view.container.querySelector(
      `[data-part-id="${machineId("step", "a", id)}"]`
    )!;
  const emphasized = () =>
    [...view.container.querySelectorAll("[data-rail-id][data-emphasis]")].map(
      (el) => el.getAttribute("data-rail-id")
    );
  for (const key of ["click", "Enter", " "]) {
    if (key === "click") fireEvent.click(header);
    else fireEvent.keyDown(header, { key });
    expect(useEntityPanelStore.getState().selection).toEqual({
      type: "workflow",
      workflowId: "a",
    });
    if (key === "click") fireEvent.click(part("choose"));
    else fireEvent.keyDown(part("choose"), { key });
    expect(useEntityPanelStore.getState().selection).toEqual({
      type: "step",
      workflowId: "a",
      stepId: "choose",
    });
  }
  act(() => useEntityPanelStore.getState().close());
  const members = new Set(
    diagram.regions.find((g) => g.id === machineId("region", "a"))!.parts
  );
  const expectedWorkflow = diagram.rails
    .filter((r) => members.has(r.from.part) || members.has(r.to.part))
    .map((r) => r.id)
    .sort();
  fireEvent.mouseEnter(header);
  expect(emphasized().sort()).toEqual(expectedWorkflow);
  fireEvent.mouseLeave(header);
  expect(emphasized()).toEqual([]);
  fireEvent.focus(header);
  expect(emphasized().sort()).toEqual(expectedWorkflow);
  fireEvent.blur(header);
  expect(emphasized()).toEqual([]);
  fireEvent.mouseEnter(part("script"));
  const expectedScript = diagram.rails
    .filter(
      (r) =>
        r.from.part === machineId("step", "a", "script") ||
        r.to.part === machineId("step", "a", "script")
    )
    .map((r) => r.id);
  expect(emphasized().sort()).toEqual(expectedScript.sort());
  // A browser click focuses the part. Subsequent pointer entry must still trace.
  const user = userEvent.setup();
  await user.click(part("choose"));
  await user.hover(part("script"));
  expect(emphasized().sort()).toEqual(expectedScript.sort());
  fireEvent.focus(part("choose"));
  fireEvent.mouseLeave(part("script"));
  expect(emphasized().length).toBeGreaterThan(0); // focus survives pointer leave
  act(() => useEntityPanelStore.getState().close());
  fireEvent.blur(part("choose"));
  expect(emphasized()).toEqual([]);
  for (const rail of diagram.rails) {
    act(() => useEntityPanelStore.getState().setHoveredEdge(rail.id));
    expect(emphasized()).toEqual([rail.id]);
    const path = view.container.querySelector(
      `[data-rail-id="${rail.id}"] path`
    )!;
    expect(path.getAttribute("d")).toBe(
      routePath(route(rail.points, undefined, rail))
    );
  }
  act(() => useEntityPanelStore.getState().setHoveredEdge("X_explicit"));
  expect(emphasized()).toEqual([machineId("handoff", "explicit")]);
  act(() => useEntityPanelStore.getState().setHoveredEdge(null));
  expect(emphasized()).toEqual([]);
  // Exercise the actual live boundary, with multiple arbitrary count magnitudes.
  for (const n of [1, 9, 100, 9999]) {
    const next = structuredClone(input);
    next.summary.workflows[0].workflow_steps[0].pipeline_counts = {
      epic: n,
      ticket: n,
      task: n,
      active: n,
    };
    view.rerender(<Host data={next} />);
    expect(part("llm")).toHaveAccessibleName(
      new RegExp(`${3 * n} parked, ${n} active`)
    );
    expect(header).toHaveAccessibleName(
      `${input.summary.workflows[0].name.trim()}. ${3 * n} parked, ${n} active`
    );
    expect(latest!.spec).toBe(spec);
    expect(camera()).toBe(cameraBefore);
    expect(worker.requests).toHaveLength(requests);
    expect(compile).toHaveBeenCalledTimes(compileCalls);
    expect(JSON.stringify(diagram)).toBe(geometry);
  }
  expect(view.container.querySelectorAll(".md-rail")).toHaveLength(0);
  // Long header fits the geometry reserved by the labelled logical endpoint.
  const region = diagram.regions[0];
  expect(region.width).toBeGreaterThan(
    input.summary.workflows[0].name.length * 18 * 0.6 + 40
  );
  // Clearing/removing entities cannot leave stale presentation traces behind.
  fireEvent.mouseEnter(part("choose"));
  act(() => useEntityPanelStore.getState().openStep("choose", "a"));
  const removed = fixture();
  removed.summary.workflows = [];
  view.rerender(<Host data={removed} />);
  await waitFor(() =>
    expect(
      view.container.querySelectorAll(
        "[data-selected], [data-traced], [data-emphasis]"
      )
    ).toHaveLength(0)
  );
}, 30000);

it("omitting presentation preserves embedded scene defaults", () => {
  const input = fixture();
  const model = buildMachineFlow(input.summary, input.configs);
  const compiled = compiler.compileFlowOrThrow(model.spec);
  const diagram = compiled.arrangements[0];
  const view = render(<FlowScene diagram={diagram} t={0} reducedMotion />);
  expect(view.container.querySelector("[data-region-header]")).toBeNull();
  expect(view.container.querySelector("[role=button]")).toBeNull();
  expect(view.container.querySelector(".md-live-count")).toBeNull();
  expect(view.container.querySelector(".md-wire [marker-end]")).toBeNull();
  expect(view.container.querySelector("[data-emphasis]")).toBeNull();
});
