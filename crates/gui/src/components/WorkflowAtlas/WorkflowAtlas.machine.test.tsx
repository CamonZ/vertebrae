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
  const v = render(<WorkflowAtlas internalMachineGraph />);
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
    v.rerender(<WorkflowAtlas internalMachineGraph />);
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
  v.rerender(<WorkflowAtlas internalMachineGraph />);
  expect(scene(v)).toBeNull();
  expect(transport.requests).toHaveLength(2);
  await reply(1);
  await waitFor(() => expect(scene(v)).not.toBeNull());
  expect(compile).toHaveBeenCalledTimes(calls + 2);
  expect(elkCalls).toHaveBeenCalledTimes(2);
});

it("retires old factory/project replies and unmounts, shows worker-error fallback and recovers on retry", async () => {
  const v = render(<WorkflowAtlas internalMachineGraph />);
  input.summary.workflows.push({
    ...workflow("other", [step("other-step", "execute", 0)]),
    factory_name: "other",
  });
  act(() => useFactoryFilterStore.getState().setFactoryName("other"));
  v.rerender(<WorkflowAtlas internalMachineGraph />);
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
  v.rerender(<WorkflowAtlas internalMachineGraph />);
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
  const v = render(<WorkflowAtlas internalMachineGraph />);
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
  const v = render(<WorkflowAtlas internalMachineGraph />);
  input = structuredClone(input);
  input.summary.workflows[0].name = "intermediate topology";
  v.rerender(<WorkflowAtlas internalMachineGraph />);
  input = structuredClone(input);
  input.summary.workflows[0].name = "current topology";
  v.rerender(<WorkflowAtlas internalMachineGraph />);
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
  v.rerender(<WorkflowAtlas internalMachineGraph />);
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
  const v = render(<WorkflowAtlas internalMachineGraph />);
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
  const v = render(<WorkflowAtlas internalMachineGraph />);
  expect(v.getByRole("alert")).toHaveTextContent(
    "Unable to compile workflow graph"
  );
  expect(v.queryByRole("button", { name: "Retry layout" })).toBeNull();
  expect(transport.requests).toHaveLength(0);
  expect(scene(v)).toBeNull();
});
