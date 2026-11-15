import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "../../test/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type Step } from "../../bindings";
import { listen } from "@tauri-apps/api/event";
import type { WebSocketStatus } from "../../hooks/useWebSocketStatus";
import { NO_FACTORY_SCOPE } from "../../utils/workflowFactory";
import { useFactoryFilterStore } from "../../stores/factoryFilterStore";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../../stores/projectScopedStores";
import { queryClient, queryKeys } from "../../query";
import * as compiler from "../MachineDiagram/flow/compile";
import type {
  LayoutRequest,
  LayoutResponse,
} from "../MachineDiagram/flow/layoutClient";
import { elk } from "../../hooks/useElkLayout";
import { layoutFlow, resetLayoutCache } from "../MachineDiagram/flow/layout";
import { route, routePath } from "../MachineDiagram/route";
import { WorkflowAtlas } from "./WorkflowAtlas";
import { fixture, step, workflow } from "./adapter/machineFlow.fixture";
import { machineId } from "./adapter/buildMachineFlow";
import { FactoryOverview } from "./FactoryOverview";

// Only the worker transport is simulated. Replies execute real ELK, bus routing
// and cache; the production hook recompiles with layoutFrom before rendering.
const transport = vi.hoisted(() => {
  const requests: { request: LayoutRequest; worker: Worker }[] = [];
  class Worker {
    onmessage: ((event: { data: LayoutResponse }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    terminate() {}
    postMessage(request: LayoutRequest) {
      requests.push({ request, worker: this });
    }
  }
  vi.stubGlobal("Worker", Worker);
  return { requests };
});
const data = vi.hoisted(() => ({ summary: vi.fn(), steps: vi.fn() }));
vi.mock("../../hooks/usePipelineSummary", () => ({
  usePipelineSummary: () => data.summary(),
}));
vi.mock("../../hooks/useStep", () => ({ useSteps: () => data.steps() }));
// The background warm-up compiles and lays out every scope on its own
// timer; it has its own tests, and here it would add to the Graph's counts.
vi.mock("./adapter/useAtlasLayoutWarmup", () => ({
  useAtlasLayoutWarmup: () => undefined,
}));
vi.mock("./hooks/useRunConsoleTasks", () => ({
  useRunConsoleTasks: () => ({ tasks: [], isLoading: false, error: null }),
}));
let input = fixture();
beforeEach(() => {
  resetLayoutCache();
  input = fixture();
  transport.requests.length = 0;
  data.summary.mockImplementation(() => ({
    summary: input.summary,
    isLoading: false,
    error: null,
  }));
  data.steps.mockImplementation(() =>
    [...input.configs.values()].map(
      (config) =>
        ({ step_type: "route", config: { route_config: config } }) as Step
    )
  );
  useFactoryFilterStore.getState().setFactoryName("factory");
  useEntityPanelStore.getState().reset();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function reply(index: number) {
  const { request, worker } = transport.requests[index];
  const layout = await layoutFlow(request.flow);
  await act(async () => {
    worker.onmessage?.({ data: { id: request.id, layout } });
  });
  return layout;
}
const scene = (v: ReturnType<typeof render>) =>
  v.container.querySelector('[aria-label="Factory workflow graph"]');
const paths = (v: ReturnType<typeof render>) =>
  [...v.container.querySelectorAll(".md-wire path")].map((p) =>
    p.getAttribute("d")
  );

/** Membership oracle: only workflow b and rails entirely inside it match. */
function expectSearchForB(
  v: ReturnType<typeof render>,
  d: compiler.DiagramTimeline
) {
  const b = d.regions.find((r) => r.id === machineId("region", "b"))!;
  const members = new Set(b.parts);
  for (const region of d.regions) {
    const el = v.container.querySelector(`[data-region-id="${region.id}"]`)!;
    expect(el.hasAttribute("data-search-dim")).toBe(region.id !== b.id);
  }
  for (const part of d.parts) {
    const el = v.container.querySelector(`[data-scene-part="${part.id}"]`)!;
    expect(el.hasAttribute("data-search-dim")).toBe(!members.has(part.id));
  }
  for (const rail of d.rails) {
    const el = v.container.querySelector(
      `[data-rail-id="${rail.id}"]`
    )!.parentElement!;
    expect(el.hasAttribute("data-search-dim")).toBe(
      !members.has(rail.from.part) || !members.has(rail.to.part)
    );
  }
}

it("integrates the real scoped graph and preserves routes/camera/compile counts under live interaction", async () => {
  const compile = vi.spyOn(compiler, "compileFlow");
  const elkCalls = vi.spyOn(elk, "layout");
  const v = render(<WorkflowAtlas />);
  expect(transport.requests).toHaveLength(1);
  expect(scene(v)).toBeNull();
  await reply(0);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  const result = compile.mock.results.at(-1)!.value as compiler.CompileResult;
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const d = result.flow.arrangements[0];
  expect(compile).toHaveBeenCalledTimes(2);
  expect(elkCalls).toHaveBeenCalledTimes(1);
  expect(d.regions).toHaveLength(3);
  expect(d.parts).toHaveLength(
    input.summary.workflows.reduce((n, w) => n + w.workflow_steps.length + 1, 0)
  );
  expect(paths(v)).toEqual(
    d.rails.map((r) => routePath(route(r.points, undefined, r)))
  );
  expect(v.container.querySelectorAll(".md-rail")).toHaveLength(0);
  const handoff = d.rails.find(
    (r) => r.id === machineId("handoff", "explicit")
  )!;
  expect(handoff.from.part).toBe(machineId("workflow", "a"));
  expect(handoff.to.part).toBe(machineId("step", "b", "end"));
  expect(
    d.parts.find((p) => p.id === machineId("step", "a", "typed"))!.position.x
  ).toBeGreaterThan(
    d.parts.find((p) => p.id === machineId("step", "a", "llm"))!.position.x
  );
  fireEvent.click(v.getByRole("button", { name: "Zoom in" }));
  const camera = () =>
    v.container.querySelector<HTMLElement>(".uv-machine-scene")!.style
      .transform;
  const originalCamera = camera(),
    originalPaths = paths(v),
    calls = compile.mock.calls.length;
  for (let n = 1; n <= 8; n++) {
    input = structuredClone(input);
    input.summary.workflows[0].workflow_steps[0].pipeline_counts = {
      epic: n,
      ticket: n,
      task: n,
      active: n,
    };
    v.rerender(<WorkflowAtlas />);
    expect(
      v.getAllByLabelText(new RegExp(`${3 * n} parked, ${n} active`)).length
    ).toBeGreaterThan(0);
    const part = v.container.querySelector(
      `[data-part-id="${machineId("step", "a", "llm")}"]`
    )!;
    fireEvent.keyDown(part, { key: "Enter" });
    expect(useEntityPanelStore.getState().selection).toMatchObject({
      type: "step",
      workflowId: "a",
      stepId: "llm",
    });
    act(() => useEntityPanelStore.getState().close());
    const header = v.container.querySelector(
      `[data-region-header="${machineId("region", "a")}"]`
    )!;
    fireEvent.mouseEnter(header);
    fireEvent.keyDown(header, { key: "Enter" });
    fireEvent.mouseLeave(header);
    expect(useEntityPanelStore.getState().selection).toMatchObject({
      type: "workflow",
      workflowId: "a",
    });
    // Keep the inspector open: selection must not suppress workflow search.
    fireEvent.change(v.getByPlaceholderText("Find a workflow…"), {
      target: { value: "b" },
    });
    expectSearchForB(v, d);
    fireEvent.mouseEnter(header);
    expect(v.container.querySelectorAll("[data-search-dim]")).toHaveLength(0);
    fireEvent.mouseLeave(header);
    expectSearchForB(v, d);
    fireEvent.click(part);
    expect(useEntityPanelStore.getState().selection).toMatchObject({
      type: "step",
      stepId: "llm",
    });
    expectSearchForB(v, d);
    act(() =>
      useEntityPanelStore
        .getState()
        .setHoveredEdge(machineId("handoff", "explicit"))
    );
    expect(v.container.querySelectorAll("[data-search-dim]")).toHaveLength(0);
    act(() => useEntityPanelStore.getState().setHoveredEdge(null));
    expectSearchForB(v, d);
    expect(camera()).toBe(originalCamera);
    expect(paths(v)).toEqual(originalPaths);
    expect(compile).toHaveBeenCalledTimes(calls);
    expect(elkCalls).toHaveBeenCalledTimes(1);
    expect(transport.requests).toHaveLength(1);
  }
  input.configs = new Map([
    [
      "choose",
      {
        rules: [
          { id: "new", transition: { type: "intra_workflow", step_id: "llm" } },
        ],
      },
    ],
  ]);
  v.rerender(<WorkflowAtlas />);
  expect(scene(v)).toBeNull();
  expect(transport.requests).toHaveLength(2);
  await reply(1);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  expect(compile).toHaveBeenCalledTimes(calls + 2);
  expect(elkCalls).toHaveBeenCalledTimes(2);
}, 30_000);

it("retires old factory/project replies and unmounts, shows worker-error fallback and recovers on retry", async () => {
  const v = render(<WorkflowAtlas />);
  input.summary.workflows.push({
    ...workflow("other", [step("other-step", "execute", 0)]),
    factory_name: "other",
  });
  act(() => useFactoryFilterStore.getState().setFactoryName("other"));
  v.rerender(<WorkflowAtlas />);
  expect(transport.requests).toHaveLength(2);
  await reply(1);
  expect(scene(v)).not.toBeNull();
  await reply(0);
  expect(
    v.container.querySelector(
      `[data-scene-part="${machineId("step", "a", "llm")}"]`
    )
  ).toBeNull();
  act(() => {
    resetProjectScopedStores();
    useFactoryFilterStore.getState().setFactoryName("other");
  });
  expect(scene(v)).toBeNull();
  expect(transport.requests).toHaveLength(3);
  const pending = transport.requests[2];
  await act(async () =>
    pending.worker.onmessage?.({
      data: { id: pending.request.id, error: "worker test failure" },
    })
  );
  await waitFor(() =>
    expect(v.getByRole("alert")).toHaveTextContent(
      "Showing a simplified layout"
    )
  );
  expect(scene(v)).not.toBeNull();
  fireEvent.click(v.getByRole("button", { name: "Retry layout" }));
  expect(scene(v)).toBeNull();
  await reply(3);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  expect(v.queryByRole("alert")).toBeNull();
  input = structuredClone(input);
  input.summary.workflows.at(-1)!.name = "changed while pending";
  v.rerender(<WorkflowAtlas />);
  expect(scene(v)).toBeNull();
  v.unmount();
  await reply(4);
  expect(v.container).toBeEmptyDOMElement();
});

it("renders separate parallel tracks and unavoidable jumps in a dense nonplanar factory", async () => {
  input.summary.workflows = ["a", "b", "c", "x", "y", "z"].map((id) =>
    workflow(id)
  );
  for (const source of input.summary.workflows.slice(0, 3)) {
    source.transitions = ["x", "y", "z", "x"].map((target, i) => ({
      id: `${source.id}-${i}`,
      from_workflow_id: source.id,
      to_workflow_id: target,
      target_step_id: null,
      label: `${source.id} to ${target} ${i}`,
    }));
  }
  input.configs.clear();
  const compile = vi.spyOn(compiler, "compileFlow");
  const v = render(<WorkflowAtlas />);
  const layout = await reply(0);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  const result = compile.mock.results.at(-1)!.value as compiler.CompileResult;
  if (!result.ok) throw new Error("compile failed");
  const d = result.flow.arrangements[0];
  expect(d.rails).toHaveLength(12);
  expect(
    d.rails.find((r) => r.id === machineId("handoff", "a-0"))!.points
  ).not.toEqual(
    d.rails.find((r) => r.id === machineId("handoff", "a-3"))!.points
  );
  expect(d.rails.some((r) => r.jumps?.length)).toBe(true);
  for (const rail of d.rails) {
    expect(rail.points).toEqual(layout.routes![rail.id].points);
    expect(rail.jumps).toEqual(layout.routes![rail.id].jumps);
    expect(rail.cornerRadii).toEqual(layout.routes![rail.id].cornerRadii);
  }
  expect(paths(v)).toEqual(
    d.rails.map((r) => routePath(route(r.points, undefined, r)))
  );
  const original = paths(v);
  act(() =>
    useEntityPanelStore.getState().setHoveredEdge(machineId("handoff", "a-3"))
  );
  expect(paths(v)).toEqual(original);
  expect(v.container.querySelectorAll("[data-emphasis]")).toHaveLength(1);
});

it("ignores retired topology success/failure after a newer layout and recovers from a crashed worker", async () => {
  const v = render(<WorkflowAtlas />);
  input = structuredClone(input);
  input.summary.workflows[0].name = "intermediate topology";
  v.rerender(<WorkflowAtlas />);
  input = structuredClone(input);
  input.summary.workflows[0].name = "current topology";
  v.rerender(<WorkflowAtlas />);
  expect(transport.requests).toHaveLength(3);
  await reply(2);
  expect(v.getByLabelText("current topology")).toBeInTheDocument();
  await reply(0);
  const stale = transport.requests[1];
  await act(async () =>
    stale.worker.onmessage?.({
      data: { id: stale.request.id, error: "retired failure" },
    })
  );
  expect(v.queryByRole("alert")).toBeNull();
  expect(v.getByLabelText("current topology")).toBeInTheDocument();
  input = structuredClone(input);
  input.summary.workflows[0].name = "after crash";
  v.rerender(<WorkflowAtlas />);
  await act(async () =>
    transport.requests[3].worker.onerror?.({ message: "worker crashed" })
  );
  await waitFor(() =>
    expect(v.getByRole("alert")).toHaveTextContent("simplified layout")
  );
  fireEvent.click(v.getByRole("button", { name: "Retry layout" }));
  await reply(4);
  await waitFor(() => expect(v.queryByRole("alert")).toBeNull());
  expect(v.getByLabelText("after crash")).toBeInTheDocument();
});

it("keeps geometry and camera on an equivalent reconnect refetch and refreshes changed topology", async () => {
  // Use the production summary and WebSocket hooks. Only Tauri's command/event
  // boundary is controlled; reconnection must actually refetch through React Query.
  const actual = await vi.importActual<
    typeof import("../../hooks/usePipelineSummary")
  >("../../hooks/usePipelineSummary");
  data.summary.mockImplementation(actual.usePipelineSummary);
  const fetchSummary = vi
    .spyOn(commands, "getPipelineSummary")
    .mockImplementation(async () => ({
      status: "ok",
      data: structuredClone(input.summary),
    }));
  vi.spyOn(commands, "getWebsocketStatus").mockResolvedValue({
    status: "ok",
    data: "connected",
  });
  const compile = vi.spyOn(compiler, "compileFlow");
  const elkCalls = vi.spyOn(elk, "layout");
  const v = render(<WorkflowAtlas />);
  await waitFor(() => expect(transport.requests).toHaveLength(1));
  await reply(0);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  fireEvent.click(v.getByRole("button", { name: "Zoom in" }));
  const camera = () =>
    v.container.querySelector<HTMLElement>(".uv-machine-scene")!.style
      .transform;
  const originalCamera = camera(),
    originalPaths = paths(v);
  expect(compile).toHaveBeenCalledTimes(2);
  expect(elkCalls).toHaveBeenCalledTimes(1);
  const reconnect = async (expectedFetches: number) => {
    const listener = vi
      .mocked(listen)
      .mock.calls.find(([name]) => name === "websocket-state-changed")![1];
    const emitStatus = async (payload: WebSocketStatus) =>
      act(async () =>
        listener({ event: "websocket-state-changed", id: 1, payload })
      );
    await emitStatus("reconnecting");
    await emitStatus("connected");
    await waitFor(() =>
      expect(fetchSummary).toHaveBeenCalledTimes(expectedFetches)
    );
    // Wait for the refetch result to enter the real project-scoped query cache.
    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          queryKeys.pipelineSummary(getProjectScopeGeneration())
        )
      ).toEqual(input.summary)
    );
  };
  input = structuredClone(input);
  input.summary.workflows[0].workflow_steps[0].pipeline_counts = {
    epic: 1,
    ticket: 1,
    task: 1,
    active: 1,
  };
  // Initial connection also refetches after the mount query.
  expect(fetchSummary).toHaveBeenCalledTimes(2);
  await reconnect(3);
  await waitFor(() =>
    expect(v.getAllByLabelText(/3 parked, 1 active/).length).toBeGreaterThan(0)
  );
  // The fetch really returned another object; count changes also force a render
  // even when React Query's structural sharing retains equal topology fields.
  expect(camera()).toBe(originalCamera);
  expect(paths(v)).toEqual(originalPaths);
  expect(compile).toHaveBeenCalledTimes(2);
  expect(elkCalls).toHaveBeenCalledTimes(1);
  expect(transport.requests).toHaveLength(1);
  input = structuredClone(input);
  input.summary.workflows[1].workflow_steps.push({
    ...step("reconnected-step", "execute", 2),
    workflow_id: "b",
  });
  await reconnect(4);
  await waitFor(() => expect(transport.requests).toHaveLength(2));
  expect(scene(v)).toBeNull();
  await reply(1);
  await waitFor(() =>
    expect(
      v.container.querySelector(
        `[data-scene-part="${machineId("step", "b", "reconnected-step")}"]`
      )
    ).not.toBeNull()
  );
  expect(compile).toHaveBeenCalledTimes(4);
  expect(elkCalls).toHaveBeenCalledTimes(2);
  expect(paths(v)).not.toEqual(originalPaths);
});

it("reports deterministic compile errors without offering a layout retry", () => {
  input.summary.workflows[0].workflow_steps.push(
    input.summary.workflows[0].workflow_steps[0]
  );
  const v = render(<WorkflowAtlas />);
  expect(v.getByRole("alert")).toHaveTextContent(
    "Unable to compile workflow graph"
  );
  expect(v.queryByRole("button", { name: "Retry layout" })).toBeNull();
  expect(transport.requests).toHaveLength(0);
  expect(scene(v)).toBeNull();
});

it("uses complete shared routes through repeated overview expansion, Map and scoped navigation", async () => {
  input.summary.workflows = ["a", "b", "c", "x", "y", "z"].map((id) =>
    workflow(id)
  );
  for (const source of input.summary.workflows.slice(0, 3)) {
    source.transitions = ["x", "y", "z", "x"].map((target, i) => ({
      id: `${source.id}-${i}`,
      from_workflow_id: source.id,
      to_workflow_id: target,
      target_step_id: null,
      label: `${source.id}-${target}-${i}`,
    }));
  }
  input.configs.clear();
  act(() => useFactoryFilterStore.getState().reset());
  const compile = vi.spyOn(compiler, "compileFlow");
  const v = render(<WorkflowAtlas />);
  const layout = await reply(0);
  const overviewScene = () =>
    v.container.querySelector('[aria-label="Factory overview workflow graph"]');
  await waitFor(() => expect(overviewScene()).not.toBeNull());
  const result = compile.mock.results.at(-1)!.value as compiler.CompileResult;
  if (!result.ok) throw new Error("compile failed");
  const d = result.flow.arrangements[0];
  expect(d.rails.some((r) => r.jumps?.length)).toBe(true);
  for (const rail of d.rails) {
    expect({
      points: rail.points,
      jumps: rail.jumps,
      cornerRadii: rail.cornerRadii,
    }).toEqual({
      points: layout.routes![rail.id].points,
      jumps: layout.routes![rail.id].jumps,
      cornerRadii: layout.routes![rail.id].cornerRadii,
    });
  }
  const expectedPaths = d.rails.map((r) =>
    routePath(route(r.points, undefined, r))
  );
  const layer = () => v.container.querySelector(".factory-overview-workflows")!;
  const stage = () => v.getByTestId("factory-overview-stage");
  const camera = () =>
    v.container.querySelector<HTMLElement>(".factory-overview-scaler")!.style
      .transform;
  // Model oracle: zoom threshold controls which of the two input layers is live.
  let scale = 1;
  for (const delta of [-400, 300, -300, 500, -600, 400, -400]) {
    const previousCamera = camera();
    fireEvent.wheel(stage(), { deltaY: delta, clientX: 600, clientY: 400 });
    scale = Math.min(2.4, Math.max(0.12, scale * Math.exp(-delta * 0.0016)));
    expect(layer().hasAttribute("inert")).toBe(scale < 1.6);
    expect(
      v.container
        .querySelector(".factory-overview-factories")!
        .hasAttribute("inert")
    ).toBe(scale >= 1.6);
    expect(paths(v)).toEqual(expectedPaths);
    expect(camera()).not.toBe(previousCamera);
    expect(transport.requests).toHaveLength(1);
  }
  const beforeMap = camera();
  fireEvent.click(v.getByRole("radio", { name: "Map" }));
  expect(overviewScene()).toBeNull();
  expect(
    v.container.querySelector(".factory-overview-map-columns")
  ).not.toBeNull();
  fireEvent.click(v.getByRole("radio", { name: "Graph" }));
  expect(camera()).toBe(beforeMap);
  expect(overviewScene()).toBeNull();
  expect(transport.requests).toHaveLength(2);
  await reply(1);
  expect(camera()).toBe(beforeMap);
  expect(paths(v)).toEqual(expectedPaths);
  const header = v.container.querySelector(
    `[data-region-header="${machineId("region", "a")}"]`
  )!;
  fireEvent.keyDown(header, { key: "Enter" });
  expect(useEntityPanelStore.getState().selection).toMatchObject({
    type: "workflow",
    workflowId: "a",
  });
  fireEvent.click(v.getByRole("button", { name: "Open factory factory" }));
  expect(transport.requests).toHaveLength(3);
  await reply(2);
  expect(scene(v)).not.toBeNull();
  expect(paths(v)).toEqual(expectedPaths);
  fireEvent.click(v.getByRole("radio", { name: "Board" }));
  expect(scene(v)).toBeNull();
  expect(v.container.querySelector(".uv-kanban")).not.toBeNull();
  fireEvent.click(v.getByRole("button", { name: "Factories" }));
  expect(v.getByTestId("factory-overview")).toBeInTheDocument();
  expect(v.getByRole("radio", { name: "Map" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
});

it("retires overview requests across search, project changes and view toggles without moving focus or camera", async () => {
  input.summary.workflows.push({
    ...workflow("outside"),
    factory_name: "other",
  });
  act(() => useFactoryFilterStore.getState().reset());
  const v = render(<WorkflowAtlas />);
  const search = v.getByPlaceholderText("Find a factory…");
  search.focus();
  fireEvent.change(search, { target: { value: "other" } });
  expect(transport.requests).toHaveLength(2);
  fireEvent.wheel(v.getByTestId("factory-overview-stage"), { deltaY: -400 });
  const camera = () =>
    v.container.querySelector<HTMLElement>(".factory-overview-scaler")!.style
      .transform;
  const pendingCamera = camera();
  fireEvent.click(v.getByRole("radio", { name: "Map" }));
  await reply(0);
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
  await reply(1);
  expect(camera()).toBe(pendingCamera);
  expect(document.activeElement).toBe(search);
  fireEvent.click(v.getByRole("radio", { name: "Graph" }));
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
  expect(transport.requests).toHaveLength(3);
  await reply(2);
  expect(
    v.container.querySelector(
      `[data-scene-part="${machineId("workflow", "outside")}"]`
    )
  ).not.toBeNull();
  expect(
    v.container.querySelector(
      `[data-scene-part="${machineId("workflow", "a")}"]`
    )
  ).toBeNull();
  fireEvent.change(search, { target: { value: "" } });
  expect(transport.requests).toHaveLength(4);
  act(() => resetProjectScopedStores());
  expect(transport.requests).toHaveLength(5);
  await reply(3);
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
  await reply(4);
  expect(
    v.container.querySelectorAll("[data-scene-part]").length
  ).toBeGreaterThan(0);
  input = { ...input, summary: { workflows: [] } };
  v.rerender(<WorkflowAtlas />);
  expect(v.getByText("No factories configured")).toBeInTheDocument();
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
});

it("restores the scoped Graph camera after Map and Board, including pending worker navigation", async () => {
  const v = render(<WorkflowAtlas />);
  await reply(0);
  const camera = () =>
    v.container.querySelector<HTMLElement>(".uv-machine-scene")!.style
      .transform;
  fireEvent.click(v.getByRole("button", { name: "Zoom in" }));
  const saved = camera();
  for (const view of ["Map", "Board", "Map"]) {
    fireEvent.click(v.getByRole("radio", { name: view }));
    expect(scene(v)).toBeNull();
    fireEvent.click(v.getByRole("radio", { name: "Graph" }));
    expect(scene(v)).toBeNull();
    await reply(transport.requests.length - 1);
    expect(camera()).toBe(saved);
    expect(v.container.querySelector(".morphing")).toBeNull();
  }
  input = structuredClone(input);
  input.summary.workflows[0].name = "topology changed";
  v.rerender(<WorkflowAtlas />);
  const stale = transport.requests.length - 1;
  fireEvent.click(v.getByRole("radio", { name: "Map" }));
  fireEvent.click(v.getByRole("radio", { name: "Graph" }));
  await reply(stale);
  expect(scene(v)).toBeNull();
  await reply(transport.requests.length - 1);
  expect(camera()).toBe(saved);
});

it("retains each scope's search, recent factory and selection across the default navigation cycle", async () => {
  act(() => useFactoryFilterStore.getState().reset());
  const v = render(<WorkflowAtlas />);
  fireEvent.change(v.getByPlaceholderText("Find a factory…"), {
    target: { value: "factory" },
  });
  fireEvent.click(v.getByRole("radio", { name: "Map" }));
  fireEvent.click(v.getByTestId("factory-index").querySelector("button")!);
  expect(v.getByPlaceholderText("Find a workflow…")).toHaveValue("");
  fireEvent.change(v.getByPlaceholderText("Find a workflow…"), {
    target: { value: "b" },
  });
  fireEvent.click(v.getByRole("radio", { name: "Graph" }));
  await reply(transport.requests.length - 1);
  const part = v.container.querySelector(
    `[data-part-id="${machineId("step", "b", "start")}"]`
  )!;
  fireEvent.keyDown(part, { key: "Enter" });
  fireEvent.click(v.getByRole("radio", { name: "Board" }));
  fireEvent.click(v.getByRole("button", { name: "Factories" }));
  expect(v.getByPlaceholderText("Find a factory…")).toHaveValue("factory");
  expect(useEntityPanelStore.getState().selection).toMatchObject({
    type: "step",
    workflowId: "b",
    stepId: "start",
  });
  expect(useFactoryFilterStore.getState().lastFactoryName).toBe("factory");
  fireEvent.click(v.getByTestId("factory-index").querySelector("button")!);
  expect(v.getByPlaceholderText("Find a workflow…")).toHaveValue("b");
  act(() => resetProjectScopedStores());
  expect(v.getByPlaceholderText("Find a factory…")).toHaveValue("");
  expect(useEntityPanelStore.getState().selection).toBeNull();
});

it.each([null, "empty-factory"])(
  "preserves empty workflow endpoints in scope %s and retires removed factories",
  async (factory) => {
    input.summary.workflows.push({
      ...workflow("unconfigured"),
      factory_name: factory,
    });
    act(() =>
      useFactoryFilterStore
        .getState()
        .setFactoryName(factory ?? NO_FACTORY_SCOPE)
    );
    const v = render(<WorkflowAtlas />);
    await reply(0);
    expect(
      v.container.querySelector(
        `[data-scene-part="${machineId("workflow", "unconfigured")}"]`
      )
    ).not.toBeNull();
    expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(1);
    input = structuredClone(input);
    input.summary.workflows = input.summary.workflows.filter(
      (w) => w.id !== "unconfigured"
    );
    v.rerender(<WorkflowAtlas />);
    expect(useFactoryFilterStore.getState().factoryName).toBeNull();
    expect(v.getByTestId("factory-overview")).toBeInTheDocument();
    expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
    await reply(transport.requests.length - 1);
    expect(
      v.container.querySelector(
        `[data-scene-part="${machineId("workflow", "unconfigured")}"]`
      )
    ).toBeNull();
  }
);

it.each([false, true])(
  "keeps automatic camera fitting across remounts (exit while pending: %s)",
  async (pendingExit) => {
    let width = 1200;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => width
    );
    const observers = new Map<Element, ResizeObserverCallback>();
    vi.spyOn(globalThis, "ResizeObserver").mockImplementation(function (
      callback: ResizeObserverCallback
    ) {
      return {
        observe(target: Element) {
          observers.set(target, callback);
        },
        unobserve(target: Element) {
          observers.delete(target);
        },
        disconnect() {},
      };
    });
    const v = render(<WorkflowAtlas />);
    const camera = () =>
      v.container.querySelector<HTMLElement>(".uv-machine-scene")!.style
        .transform;
    const expectedFit = () => {
      const diagram = scene(v)!;
      const dw = Number(diagram.getAttribute("width"));
      const dh = Number(diagram.getAttribute("height"));
      const scale = Math.max(
        0.04,
        Math.min(2.4, (width - 96) / dw, (800 - 96) / dh)
      );
      return `translate(${(width - dw * scale) / 2}px,${(800 - dh * scale) / 2}px) scale(${scale})`;
    };
    if (!pendingExit) {
      await reply(0);
      expect(camera()).toBe(expectedFit());
    }
    fireEvent.click(v.getByRole("radio", { name: "Board" }));
    if (pendingExit) await reply(0);
    width = 900;
    fireEvent.click(v.getByRole("radio", { name: "Graph" }));
    await reply(1);
    expect(camera()).toBe(expectedFit());
    for (const nextWidth of [680, 1400, 1000]) {
      width = nextWidth;
      const canvas = v.container.querySelector(".uv-machine-canvas")!;
      act(() => observers.get(canvas)!([], {} as ResizeObserver));
      expect(camera()).toBe(expectedFit());
    }
    // Explicit Fit relinquishes manual ownership; it must not leave a saved
    // manual snapshot that suppresses fitting on the next view mount.
    fireEvent.click(v.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(v.getByRole("button", { name: "Fit to view" }));
    fireEvent.click(v.getByRole("radio", { name: "Map" }));
    width = 780;
    fireEvent.click(v.getByRole("radio", { name: "Graph" }));
    await reply(2);
    expect(camera()).toBe(expectedFit());
  }
);

it.each([null, "factory"])(
  "opens factory %s from an expanded region while retaining workflow inspector actions",
  async (factory) => {
    input.summary.workflows.forEach((w) => {
      w.factory_name = factory;
    });
    act(() => useFactoryFilterStore.getState().reset());
    const v = render(<WorkflowAtlas />);
    await reply(0);
    const region = v.container.querySelector(".factory-overview-regions")!;
    expect(region).toHaveAttribute("inert");
    fireEvent.wheel(v.getByTestId("factory-overview-stage"), { deltaY: -400 });
    expect(region).not.toHaveAttribute("inert");
    const header = v.container.querySelector(
      `[data-region-header="${machineId("region", "a")}"]`
    )!;
    fireEvent.keyDown(header, { key: "Enter" });
    expect(useEntityPanelStore.getState().selection).toMatchObject({
      type: "workflow",
      workflowId: "a",
    });
    const entry = v.getByRole("button", {
      name: `Open factory ${factory ?? "No Factory"}`,
    });
    entry.focus();
    expect(entry).toHaveFocus();
    // Native button activation covers keyboard and pointer without a custom key handler.
    fireEvent.click(entry);
    expect(useFactoryFilterStore.getState().factoryName).toEqual(
      factory ?? NO_FACTORY_SCOPE
    );
    expect(v.queryByTestId("factory-overview")).toBeNull();
    await reply(1);
    expect(scene(v)).not.toBeNull();
  }
);

it("starts no detailed worker in Map even during search and retires pending Graph replies", async () => {
  const select = vi.fn();
  const props = {
    summary: input.summary,
    routeConfigs: input.configs,
    machineGraph: true,
    onSelect: select,
  };
  const v = render(<FactoryOverview {...props} view="map" query="" />);
  for (const query of ["f", "fa", "factory", "missing", ""]) {
    v.rerender(<FactoryOverview {...props} view="map" query={query} />);
    expect(transport.requests).toHaveLength(0);
  }
  v.rerender(<FactoryOverview {...props} view="graph" query="" />);
  expect(transport.requests).toHaveLength(1);
  v.rerender(<FactoryOverview {...props} view="map" query="" />);
  await reply(0);
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
  expect(transport.requests).toHaveLength(1);
  v.rerender(<FactoryOverview {...props} view="graph" query="" />);
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
  expect(transport.requests).toHaveLength(2);
  await reply(1);
  expect(
    v.container.querySelectorAll("[data-scene-part]").length
  ).toBeGreaterThan(0);
});

it.each([false, true])(
  "hides condensed handoff labels in pending/failed shared Graph (compile failure: %s)",
  async (invalid) => {
    if (invalid)
      input.summary.workflows[0].workflow_steps.push(
        input.summary.workflows[0].workflow_steps[0]
      );
    const v = render(
      <FactoryOverview
        summary={input.summary}
        routeConfigs={input.configs}
        machineGraph
        view="graph"
        query=""
        onSelect={vi.fn()}
      />
    );
    fireEvent.wheel(v.getByTestId("factory-overview-stage"), { deltaY: -400 });
    expect(
      v.container.querySelector(".factory-overview-workflows")
    ).toHaveClass("is-expanded");
    expect(
      v.container.querySelectorAll(".factory-overview-workflows .al-cond")
    ).toHaveLength(0);
    expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
    if (invalid)
      expect(v.getByRole("alert")).toHaveTextContent("Unable to compile");
    else {
      expect(v.getByRole("status")).toHaveTextContent("Laying out");
      await reply(0);
      expect(
        v.container.querySelectorAll(".factory-overview-workflows .al-cond")
      ).toHaveLength(0);
      expect(
        v.container.querySelectorAll("[data-scene-part]").length
      ).toBeGreaterThan(0);
    }
    // The same fixture does have aggregated handoff labels in Map; the Graph
    // assertions above must not pass merely because the fixture lacked labels.
    v.rerender(
      <FactoryOverview
        summary={input.summary}
        routeConfigs={input.configs}
        machineGraph
        view="map"
        query=""
        onSelect={vi.fn()}
      />
    );
    expect(
      v.container.querySelectorAll(".factory-overview-workflows .al-cond")
        .length
    ).toBeGreaterThan(0);
  }
);
