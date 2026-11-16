import { drawnLeads } from "../MachineDiagram/flow/railTestHelpers";
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

/** The Graph inside one workflow (its steps), once laid out. */
const stepScene = (v: ReturnType<typeof render>) =>
  v.container.querySelector('[aria-label="Workflow step graph"]');
const factoryScene = (v: ReturnType<typeof render>) =>
  v.container.querySelector('[aria-label="Factory graph"]');
/** The interactive part of a part id, once drawn. */
const partEl = (v: ReturnType<typeof render>, id: string) =>
  v.container.querySelector(`[data-part-id="${id}"]`);

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

/**
 * Membership oracle for a search at the steps level: only the parts in
 * `matches` (and rails entirely between them) stay lit; the workflow region
 * dims unless it matches.
 */
function expectSearch(
  v: ReturnType<typeof render>,
  d: compiler.DiagramTimeline,
  matches: ReadonlySet<string>
) {
  for (const region of d.regions) {
    const el = v.container.querySelector(`[data-region-id="${region.id}"]`)!;
    expect(el.hasAttribute("data-search-dim")).toBe(!matches.has(region.id));
  }
  for (const part of d.parts) {
    const el = v.container.querySelector(`[data-scene-part="${part.id}"]`)!;
    expect(el.hasAttribute("data-search-dim")).toBe(!matches.has(part.id));
  }
  for (const rail of d.rails) {
    const el = v.container.querySelector(
      `[data-rail-id="${rail.id}"]`
    )!.parentElement!;
    expect(el.hasAttribute("data-search-dim")).toBe(
      !matches.has(rail.from.part) || !matches.has(rail.to.part)
    );
  }
}

/**
 * From the factory's workflows Graph (request 0), open workflow `id` by a
 * double-click. Its steps request becomes request 0; `clear` resets spies
 * just before the steps level mounts.
 */
async function openSteps(
  v: ReturnType<typeof render>,
  id = "a",
  clear: readonly { mockClear(): unknown }[] = []
) {
  await reply(0);
  const station = await waitFor(() => {
    const el = partEl(v, machineId("station", id));
    if (!el) throw new Error(`station ${id} not drawn yet`);
    return el;
  });
  for (const spy of clear) spy.mockClear();
  fireEvent.doubleClick(station);
  transport.requests.splice(0, 1);
}

it("integrates the real steps graph and preserves routes/camera/compile counts under live interaction", async () => {
  const compile = vi.spyOn(compiler, "compileFlow");
  const elkCalls = vi.spyOn(elk, "layout");
  const v = render(<WorkflowAtlas />);
  await openSteps(v, "a", [compile, elkCalls]);
  expect(transport.requests).toHaveLength(1);
  expect(stepScene(v)).toBeNull();
  await reply(0);
  await waitFor(() => expect(stepScene(v)).not.toBeNull());
  const result = compile.mock.results.at(-1)!.value as compiler.CompileResult;
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const d = result.flow.arrangements[0];
  expect(compile).toHaveBeenCalledTimes(2);
  expect(elkCalls).toHaveBeenCalledTimes(1);
  // Only workflow a is drawn; its handoffs end at stubs naming b and empty.
  expect(d.regions).toHaveLength(1);
  const a = input.summary.workflows[0];
  expect(d.regions[0].parts).toHaveLength(a.workflow_steps.length + 1);
  const toB = machineId("stub", "out", "a", "b");
  const toEmpty = machineId("stub", "out", "a", "empty");
  expect(d.parts.map((p) => p.id).sort()).toEqual(
    [...d.regions[0].parts, toB, toEmpty].sort()
  );
  expect(paths(v)).toEqual(
    d.rails.map((r) => routePath(route(r.points, undefined, r)))
  );
  // Station mechanisms keep their own tracks; no gallery lead is drawn.
  expect(drawnLeads(v.container)).toEqual([]);
  const handoff = d.rails.find(
    (r) => r.id === machineId("handoff", "explicit")
  )!;
  expect(handoff.from.part).toBe(machineId("workflow", "a"));
  expect(handoff.to.part).toBe(toB);
  // The route decision leaving for workflow empty ends at its stub too.
  expect(d.rails.some((r) => r.to.part === toEmpty)).toBe(true);
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
    const part = partEl(v, machineId("step", "a", "llm"))!;
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
    // Keep the inspector open: selection must not suppress the search. Only
    // the stub naming b matches.
    fireEvent.change(v.getByPlaceholderText("Find a workflow…"), {
      target: { value: "b" },
    });
    expectSearch(v, d, new Set([toB]));
    fireEvent.mouseEnter(header);
    expect(v.container.querySelectorAll("[data-search-dim]")).toHaveLength(0);
    fireEvent.mouseLeave(header);
    expectSearch(v, d, new Set([toB]));
    fireEvent.click(part);
    expect(useEntityPanelStore.getState().selection).toMatchObject({
      type: "step",
      stepId: "llm",
    });
    expectSearch(v, d, new Set([toB]));
    act(() =>
      useEntityPanelStore
        .getState()
        .setHoveredEdge(machineId("handoff", "explicit"))
    );
    expect(v.container.querySelectorAll("[data-search-dim]")).toHaveLength(0);
    act(() => useEntityPanelStore.getState().setHoveredEdge(null));
    expectSearch(v, d, new Set([toB]));
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
  expect(stepScene(v)).toBeNull();
  expect(transport.requests).toHaveLength(2);
  await reply(1);
  await waitFor(() => expect(stepScene(v)).not.toBeNull());
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

it("aggregates handoffs into one rail per workflow pair in a dense nonplanar factory", async () => {
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
  // a-0 and a-3 both go a → x: one rail carrying both transitions.
  expect(d.rails).toHaveLength(9);
  expect(new Set(d.rails.map((r) => JSON.stringify(r.points))).size).toBe(9);
  for (const rail of d.rails) {
    expect(rail.points).toEqual(layout.routes![rail.id].points);
    expect(rail.jumps).toEqual(layout.routes![rail.id].jumps);
    expect(rail.cornerRadii).toEqual(layout.routes![rail.id].cornerRadii);
  }
  expect(paths(v)).toEqual(
    d.rails.map((r) => routePath(route(r.points, undefined, r)))
  );
  const original = paths(v);
  // The inspector's handoff row names one backend transition; its rail lights.
  act(() => useEntityPanelStore.getState().setHoveredEdge("a-3"));
  expect(paths(v)).toEqual(original);
  expect(v.container.querySelectorAll("[data-emphasis]")).toHaveLength(1);
});

it("ignores retired topology success/failure after a newer layout and recovers from a crashed worker", async () => {
  const v = render(<WorkflowAtlas />);
  const station = (name: string) => v.queryByTestId(`workflow-station-${name}`);
  input = structuredClone(input);
  input.summary.workflows[0].name = "intermediate topology";
  v.rerender(<WorkflowAtlas />);
  input = structuredClone(input);
  input.summary.workflows[0].name = "current topology";
  v.rerender(<WorkflowAtlas />);
  expect(transport.requests).toHaveLength(3);
  await reply(2);
  expect(station("current topology")).toBeInTheDocument();
  await reply(0);
  const stale = transport.requests[1];
  await act(async () =>
    stale.worker.onmessage?.({
      data: { id: stale.request.id, error: "retired failure" },
    })
  );
  expect(v.queryByRole("alert")).toBeNull();
  expect(station("current topology")).toBeInTheDocument();
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
  expect(station("after crash")).toBeInTheDocument();
});

it("keeps geometry and camera on an equivalent reconnect refetch and refreshes changed topology", async () => {
  // Use the production summary and WebSocket hooks. Only Tauri's command/event
  // boundary is controlled; reconnection must actually refetch through React Query.
  const actual = await vi.importActual<
    typeof import("../../hooks/usePipelineSummary")
  >("../../hooks/usePipelineSummary");
  // The app mounts the summary's event sync globally, beside the Atlas query.
  data.summary.mockImplementation(() => {
    actual.usePipelineSummarySync();
    return actual.usePipelineSummary();
  });
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
  // Two more steps widen b's station (its frame fits four lamps), a change of
  // geometry; a third lamp alone would fit the same frame and layout.
  input.summary.workflows[1].workflow_steps.push(
    { ...step("reconnected-step", "execute", 2), workflow_id: "b" },
    { ...step("reconnected-step-2", "execute", 3), workflow_id: "b" }
  );
  await reconnect(4);
  await waitFor(() => expect(transport.requests).toHaveLength(2));
  expect(scene(v)).toBeNull();
  await reply(1);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  expect(compile).toHaveBeenCalledTimes(4);
  expect(elkCalls).toHaveBeenCalledTimes(2);
  expect(v.getByTestId("workflow-station-b")).toBeInTheDocument();
});

it("reports deterministic compile errors without offering a layout retry", async () => {
  input.summary.workflows[0].workflow_steps.push(
    input.summary.workflows[0].workflow_steps[0]
  );
  const v = render(<WorkflowAtlas />);
  // The workflow station draws step types only; the steps level cannot compile.
  await openSteps(v, "a");
  expect(v.getByRole("alert")).toHaveTextContent(
    "Unable to compile step graph"
  );
  expect(v.queryByRole("button", { name: "Retry layout" })).toBeNull();
  expect(transport.requests).toHaveLength(0);
  expect(stepScene(v)).toBeNull();
});

it("drills factories → factory → workflow and returns up the breadcrumb with each level's camera, across Map and Board", async () => {
  act(() => useFactoryFilterStore.getState().reset());
  input.summary.workflows.push({
    ...workflow("other-wf", [step("other-step", "execute", 0)]),
    factory_name: "other",
    transitions: [
      {
        id: "to-a",
        from_workflow_id: "other-wf",
        to_workflow_id: "a",
        target_step_id: null,
        label: "hand over",
      },
    ],
  });
  const v = render(<WorkflowAtlas />);
  const camera = () =>
    v.container.querySelector<HTMLElement>(".uv-machine-scene")!.style
      .transform;
  const crumb = () =>
    v.getByRole("navigation", { name: "Breadcrumb" }).textContent;
  // Between factories: one station per factory, one rail per factory route.
  await reply(0);
  await waitFor(() => expect(factoryScene(v)).not.toBeNull());
  expect(v.getByTestId("factory-station-factory")).toBeInTheDocument();
  expect(v.getByTestId("factory-station-other")).toBeInTheDocument();
  expect(
    v.container.querySelector(
      `[data-rail-id="${machineId("factory-route", "other", "factory")}"]`
    )
  ).not.toBeNull();
  fireEvent.click(v.getByRole("button", { name: "Zoom in" }));
  const factoriesCamera = camera();

  // Enter on a factory station opens its workflows, framed fresh.
  fireEvent.keyDown(partEl(v, machineId("factory", "factory"))!, {
    key: "Enter",
  });
  expect(useFactoryFilterStore.getState().factoryName).toBe("factory");
  await reply(transport.requests.length - 1);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  expect(crumb()).toBe("Factories/factory");
  // The handoff from the other factory arrives from a stub naming it.
  expect(v.getByTestId("handoff-stub-other")).toBeInTheDocument();
  fireEvent.click(v.getByRole("button", { name: "Zoom out" }));
  const workflowsCamera = camera();

  // Double-click a workflow station: only its steps.
  fireEvent.doubleClick(partEl(v, machineId("station", "a"))!);
  await reply(transport.requests.length - 1);
  await waitFor(() => expect(stepScene(v)).not.toBeNull());
  expect(crumb()).toBe("Factories/factory/a");
  expect(partEl(v, machineId("step", "b", "start"))).toBeNull();
  fireEvent.click(v.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(v.getByRole("button", { name: "Zoom in" }));
  const stepsCamera = camera();

  // Level and camera survive Map and Board.
  for (const view of ["Map", "Board"]) {
    fireEvent.click(v.getByRole("radio", { name: view }));
    expect(stepScene(v)).toBeNull();
    fireEvent.click(v.getByRole("radio", { name: "Graph" }));
    await reply(transport.requests.length - 1);
    await waitFor(() => expect(stepScene(v)).not.toBeNull());
    expect(camera()).toBe(stepsCamera);
    expect(crumb()).toBe("Factories/factory/a");
  }

  // The breadcrumb goes back up with each level's previous camera.
  fireEvent.click(v.getByRole("button", { name: "factory" }));
  await reply(transport.requests.length - 1);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  expect(camera()).toBe(workflowsCamera);
  fireEvent.click(v.getByRole("button", { name: "Factories" }));
  await reply(transport.requests.length - 1);
  await waitFor(() => expect(factoryScene(v)).not.toBeNull());
  expect(camera()).toBe(factoriesCamera);

  // A stub opens the level it names: other's handoff into a goes to factory.
  fireEvent.click(partEl(v, machineId("factory", "other"))!);
  await reply(transport.requests.length - 1);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  fireEvent.doubleClick(
    partEl(v, machineId("stub", "out", "other-wf", "factory"))!
  );
  expect(useFactoryFilterStore.getState().factoryName).toBe("factory");
}, 30_000);

it("searches between factories without layout requests and retires replies across project changes", async () => {
  input.summary.workflows.push({
    ...workflow("outside"),
    factory_name: "other",
  });
  act(() => useFactoryFilterStore.getState().reset());
  const v = render(<WorkflowAtlas />);
  const search = v.getByPlaceholderText("Find a factory…");
  search.focus();
  await reply(0);
  await waitFor(() => expect(factoryScene(v)).not.toBeNull());
  // Search decorates the scene; it is never a layout input.
  fireEvent.change(search, { target: { value: "other" } });
  expect(transport.requests).toHaveLength(1);
  expect(
    v.getByTestId("factory-station-factory").hasAttribute("data-search-dim")
  ).toBe(true);
  expect(
    v.getByTestId("factory-station-other").hasAttribute("data-search-dim")
  ).toBe(false);
  expect(document.activeElement).toBe(search);
  fireEvent.click(v.getByRole("radio", { name: "Map" }));
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
  fireEvent.click(v.getByRole("radio", { name: "Graph" }));
  act(() => resetProjectScopedStores());
  const retired = transport.requests.length - 2;
  await reply(retired);
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
  await reply(transport.requests.length - 1);
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
  await waitFor(() =>
    expect(partEl(v, machineId("station", "b"))).not.toBeNull()
  );
  fireEvent.keyDown(partEl(v, machineId("station", "b"))!, { key: "Enter" });
  await reply(transport.requests.length - 1);
  await waitFor(() => expect(stepScene(v)).not.toBeNull());
  // Enter on a step (nothing below it) inspects it.
  fireEvent.keyDown(partEl(v, machineId("step", "b", "start"))!, {
    key: "Enter",
  });
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
  "preserves empty workflow stations in scope %s and retires removed factories",
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
        `[data-scene-part="${machineId("station", "unconfigured")}"]`
      )
    ).not.toBeNull();
    expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(1);
    input = structuredClone(input);
    input.summary.workflows = input.summary.workflows.filter(
      (w) => w.id !== "unconfigured"
    );
    v.rerender(<WorkflowAtlas />);
    expect(useFactoryFilterStore.getState().factoryName).toBeNull();
    expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
    await reply(transport.requests.length - 1);
    await waitFor(() => expect(factoryScene(v)).not.toBeNull());
    expect(
      v.container.querySelector(
        `[data-scene-part="${machineId("station", "unconfigured")}"]`
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

it("starts no worker in the factories Map, even during search", async () => {
  const select = vi.fn();
  const props = { summary: input.summary, onSelect: select };
  const v = render(<FactoryOverview {...props} query="" />);
  for (const query of ["f", "fa", "factory", "missing", ""]) {
    v.rerender(<FactoryOverview {...props} query={query} />);
    expect(transport.requests).toHaveLength(0);
  }
  expect(v.container.querySelectorAll("[data-scene-part]")).toHaveLength(0);
  fireEvent.wheel(v.getByTestId("factory-overview-stage"), { deltaY: -400 });
  expect(
    v.container.querySelectorAll(".factory-overview-workflows .al-cond").length
  ).toBeGreaterThan(0);
});

it("lists each Graph level's elements beside it, traced both ways, and drills down from the list", async () => {
  act(() => useFactoryFilterStore.getState().reset());
  input.summary.workflows.push({
    ...workflow("other-wf", [step("other-step", "execute", 0)]),
    factory_name: "other",
  });
  const v = render(<WorkflowAtlas />);
  const index = () => v.getByTestId("atlas-level-index");
  const rows = () =>
    [...index().querySelectorAll(".factory-index-name")].map(
      (el) => el.textContent
    );
  const traced = (id: string) =>
    v.container
      .querySelector(`[data-scene-part="${id}"]`)!
      .hasAttribute("data-traced");

  // Between factories: one row per factory station.
  await reply(0);
  await waitFor(() => expect(factoryScene(v)).not.toBeNull());
  expect(index()).toHaveAttribute("data-level", "factories");
  expect(rows()).toEqual(expect.arrayContaining(["factory", "other"]));
  expect(rows()).toHaveLength(2);

  // Pointing at a row traces its station and shows its hover labels.
  const otherStation = machineId("factory", "other");
  fireEvent.mouseEnter(v.getByTestId("atlas-level-row-other"));
  expect(traced(otherStation)).toBe(true);
  expect(partEl(v, otherStation)).toHaveAttribute("data-pointed", "true");
  fireEvent.mouseLeave(v.getByTestId("atlas-level-row-other"));
  expect(traced(otherStation)).toBe(false);

  // Pointing at a station lights its row.
  fireEvent.focus(partEl(v, otherStation)!);
  await waitFor(() =>
    expect(v.getByTestId("atlas-level-row-other")).toHaveClass("is-hot")
  );
  fireEvent.blur(partEl(v, otherStation)!);

  // A factory row opens its workflows; stubs are not listed.
  fireEvent.click(v.getByTestId("atlas-level-row-factory"));
  expect(useFactoryFilterStore.getState().factoryName).toBe("factory");
  await reply(transport.requests.length - 1);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  expect(index()).toHaveAttribute("data-level", "workflows");
  expect(rows()).toEqual(["a", "empty", "b"]);

  // A workflow row opens its steps, listed once each in step order.
  fireEvent.click(v.getByTestId("atlas-level-row-a"));
  await reply(transport.requests.length - 1);
  await waitFor(() => expect(stepScene(v)).not.toBeNull());
  expect(index()).toHaveAttribute("data-level", "steps");
  expect(rows()).toEqual([
    "llm",
    "typed",
    "script",
    "choose",
    "approve",
    "join",
    "pause",
    "done",
  ]);
  fireEvent.mouseEnter(v.getByTestId("atlas-level-row-choose"));
  expect(traced(machineId("step", "a", "choose"))).toBe(true);

  // A step row inspects the step.
  fireEvent.click(v.getByTestId("atlas-level-row-choose"));
  expect(useEntityPanelStore.getState().selection).toMatchObject({
    type: "step",
    stepId: "choose",
    workflowId: "a",
  });
}, 30_000);
