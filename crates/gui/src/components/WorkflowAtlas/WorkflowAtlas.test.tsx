import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "../../test/test-utils";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineStep,
  PipelineSummary,
  PipelineWorkflow,
} from "../../bindings";
import { buildAtlasModel } from "./adapter/buildAtlasModel";
import { layoutFull } from "./layout/layoutFull";
import type { AtlasModel, FullLayout } from "./layout/types";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { GlobalEntityPanelHost } from "../GlobalEntityPanelHost";
import { WorkflowAtlas, layoutKey } from "./WorkflowAtlas";

/* ── mocks ─────────────────────────────────────────────────────────
   `layoutFull` wraps elkjs, which spawns a Web Worker that jsdom can't host.
   Replace it with a deterministic stub that places each workflow + its steps on
   a simple grid so the component has real geometry to render. `usePipelineSummary`
   is mocked per-test to drive loading / empty / error / ready states. */

vi.mock("./layout/layoutFull", () => ({ layoutFull: vi.fn() }));

// The Run Console owns its own task feed (listReady + realtime events) and is
// covered by RunConsole.test.tsx. Stub it here so the atlas-canvas tests don't
// have to stand up the Tauri command/event plumbing it needs.
vi.mock("./RunConsole", () => ({ RunConsole: () => null }));

const mockSummary = vi.fn();
vi.mock("../../hooks/usePipelineSummary", () => ({
  usePipelineSummary: () => mockSummary(),
}));

const layoutFullMock = vi.mocked(layoutFull);

beforeEach(() => {
  usePanelLayoutStore.getState().reset();
  useEntityPanelStore.getState().reset();
  vi.mocked(invoke).mockResolvedValue(null);
});

/* ── fixtures ──────────────────────────────────────────────────── */

function makeStep(
  id: string,
  workflowId: string,
  order: number,
  overrides: Partial<PipelineStep> = {}
): PipelineStep {
  return {
    id,
    name: id,
    workflow_id: workflowId,
    goal: null,
    step_order: order,
    step_type: "execute",
    transitions_to: [],
    task_counts: { epic: 0, ticket: 0, task: 0 },
    pipeline_counts: { epic: 0, ticket: 0, task: 0, active: 0 },
    active_count: 0,
    ...overrides,
  };
}

function makeWorkflow(
  id: string,
  steps: PipelineStep[],
  overrides: Partial<PipelineWorkflow> = {}
): PipelineWorkflow {
  return {
    id,
    name: id,
    description: null,
    initial_step_id: steps[0]?.id ?? null,
    kanban_column: null,
    is_default: false,
    display_order: 0,
    workflow_steps: steps,
    transitions: [],
    ...overrides,
    factory_name: overrides.factory_name ?? null,
  };
}

const FIXTURE: PipelineSummary = {
  workflows: [
    makeWorkflow(
      "wf-build",
      [
        makeStep("s1", "wf-build", 0, { name: "Plan" }),
        makeStep("s2", "wf-build", 1, {
          name: "Execute",
          transitions_to: ["s1"], // backward → loop edge
        }),
        makeStep("s3", "wf-build", 2, { name: "Ship", step_type: "finish" }),
      ],
      {
        name: "Build",
        description: "Build pipeline",
        kanban_column: "Dev",
        factory_name: "Factory A",
      }
    ),
    makeWorkflow(
      "wf-review",
      [makeStep("r1", "wf-review", 0, { name: "Approve" })],
      {
        name: "Review",
        kanban_column: "QA",
        factory_name: "Factory B",
        // active runs → running pill
        workflow_steps: [
          makeStep("r1", "wf-review", 0, {
            name: "Approve",
            pipeline_counts: { epic: 0, ticket: 0, task: 0, active: 2 },
          }),
        ],
      }
    ),
  ],
};

/** Deterministic grid stub matching the real layoutFull output shape. */
function stubLayout(model: AtlasModel): FullLayout {
  const workflows = model.workflows.map((w, wi) => {
    const steps = model.steps
      .filter((s) => s.workflowId === w.id)
      .map((s, si) => ({
        id: s.id,
        stepId: s.stepId,
        workflowId: s.workflowId,
        name: s.name,
        kind: s.kind,
        role: s.role,
        idx: si + 1,
        x: 40 + si * 160,
        y: 60 + wi * 240,
        w: 150,
        h: 90,
      }));
    return {
      id: w.id,
      workflow: w,
      x: 20,
      y: 20 + wi * 240,
      w: 600,
      h: 200,
      steps,
      intra: [] as FullLayout["cross"],
    };
  });
  return {
    width: 700,
    height: 20 + model.workflows.length * 240,
    workflows,
    cross: [],
    hubIds: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
  useEntityPanelStore.getState().reset();
});

function renderAtlasWithEntityHost() {
  return render(
    <>
      <WorkflowAtlas />
      <GlobalEntityPanelHost />
    </>
  );
}

/* ── tests ─────────────────────────────────────────────────────── */

describe("layoutKey", () => {
  it("is stable across pipeline_counts churn", () => {
    const a = buildAtlasModel(FIXTURE);
    const bumped: PipelineSummary = {
      workflows: FIXTURE.workflows.map((w) => ({
        ...w,
        workflow_steps: w.workflow_steps.map((s) => ({
          ...s,
          pipeline_counts: {
            ...s.pipeline_counts,
            active: s.pipeline_counts.active + 5,
          },
        })),
      })),
    };
    const b = buildAtlasModel(bumped);
    expect(layoutKey(a)).toBe(layoutKey(b));
  });

  it("changes when a step kind changes", () => {
    const a = buildAtlasModel(FIXTURE);
    const retyped: PipelineSummary = {
      workflows: FIXTURE.workflows.map((w, i) =>
        i === 0
          ? {
              ...w,
              workflow_steps: w.workflow_steps.map((s) =>
                s.id === "s2" ? { ...s, step_type: "route" } : s
              ),
            }
          : w
      ),
    };
    const b = buildAtlasModel(retyped);
    expect(layoutKey(a)).not.toBe(layoutKey(b));
  });
});

describe("WorkflowAtlas", () => {
  it("shows the loading state before the layout resolves", () => {
    mockSummary.mockReturnValue({
      summary: null,
      isLoading: true,
      error: null,
    });
    layoutFullMock.mockReturnValue(new Promise(() => {}));
    renderAtlasWithEntityHost();
    expect(screen.getByText(/laying out workflow graph/i)).toBeInTheDocument();
  });

  it("renders the empty state when there are no workflows", async () => {
    mockSummary.mockReturnValue({
      summary: { workflows: [] },
      isLoading: false,
      error: null,
    });
    render(<WorkflowAtlas />);
    expect(
      await screen.findByText(/no workflows to graph/i)
    ).toBeInTheDocument();
  });

  it("renders the graph from a fixture summary", async () => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);

    // workflow boxes — query the graph face (both faces are mounted for the
    // P6 morph; the map face is just hidden in graph view)
    await waitFor(() =>
      expect(document.querySelector(".ag-wf-name")).toBeInTheDocument()
    );
    const graphNames = Array.from(document.querySelectorAll(".ag-wf-name")).map(
      (n) => n.textContent
    );
    expect(graphNames).toContain("Build");
    expect(graphNames).toContain("Review");

    // step nodes (rendered from the placed geometry)
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Ship")).toBeInTheDocument();

    // step count meta + running pill (wf-review has an active TaskRun)
    expect(screen.getAllByText(/3 steps/).length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".uv-running").length).toBeGreaterThan(0);

    // zoom widget + search (the toolbar carries it in graph view too)
    expect(screen.getByLabelText(/fit to view/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/find a workflow/i)).toBeInTheDocument();
  });

  it("keeps workflow and step inspectors to the left of normal chat", async () => {
    usePanelLayoutStore.getState().setChatLayout({
      isPresent: true,
      renderedWidth: 432,
      isMaximized: false,
    });
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    renderAtlasWithEntityHost();
    await waitFor(() =>
      expect(screen.getByTestId("workflow-node-Build")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId("workflow-node-Build"));
    expect(await screen.findByText(/Workflow Details/)).toBeInTheDocument();
    const inspector = screen.getByTestId("global-entity-panel");
    expect(inspector).toHaveAttribute("data-chat-adjacent", "true");
    expect(inspector.style.getPropertyValue("--detail-panel-chat-offset")).toBe(
      "calc(432px + var(--s-3))"
    );

    fireEvent.click(screen.getByRole("button", { name: "Step Execute" }));
    expect(await screen.findByText("Step Configuration")).toBeInTheDocument();
    expect(inspector).toHaveAttribute("data-chat-adjacent", "true");
    expect(screen.getAllByTestId("global-entity-panel")).toHaveLength(1);
  });

  it("does not re-run the ELK layout when only pipeline_counts change", async () => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    const { rerender } = render(<WorkflowAtlas />);
    await waitFor(() =>
      expect(document.querySelector(".ag-wf-name")).toBeInTheDocument()
    );
    expect(layoutFullMock).toHaveBeenCalledTimes(1);

    // bump counts only — same structural key → no new layout
    mockSummary.mockReturnValue({
      summary: {
        workflows: FIXTURE.workflows.map((w) => ({
          ...w,
          workflow_steps: w.workflow_steps.map((s) => ({
            ...s,
            pipeline_counts: { ...s.pipeline_counts, active: 9 },
          })),
        })),
      },
      isLoading: false,
      error: null,
    });
    rerender(<WorkflowAtlas />);

    await waitFor(() => expect(layoutFullMock).toHaveBeenCalledTimes(1));
  });

  it("scopes Graph and Map to the selected exact factory", async () => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);
    await waitFor(() =>
      expect(document.querySelectorAll(".uv-wf")).toHaveLength(2)
    );

    fireEvent.change(screen.getByLabelText("Filter by factory"), {
      target: { value: "Factory A" },
    });

    await waitFor(() => {
      expect(document.querySelectorAll(".uv-wf")).toHaveLength(1);
      expect(document.querySelector(".ag-wf-name")).toHaveTextContent("Build");
      expect(document.querySelector(".ag-wf-name")).not.toHaveTextContent(
        "Review"
      );
    });

    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    await waitFor(() => {
      expect(document.querySelector(".al-name")).toHaveTextContent("Build");
      expect(document.querySelector(".al-name")).not.toHaveTextContent(
        "Review"
      );
      const headers = Array.from(document.querySelectorAll(".al-stagehd"));
      expect(
        headers.some((header) => header.textContent?.includes("Dev"))
      ).toBe(true);
      expect(headers.some((header) => header.textContent?.includes("QA"))).toBe(
        false
      );
    });
  });
});

describe("WorkflowAtlas — MAP view", () => {
  /** Render the atlas and switch to the Map view (condensed layout is real). */
  async function renderMap() {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    // graph layout never resolves here — the map view doesn't need it
    layoutFullMock.mockReturnValue(new Promise(() => {}));
    const utils = render(<WorkflowAtlas />);
    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    // condensed cards render synchronously once the map is active
    await waitFor(() =>
      expect(document.querySelector(".al-name")).toBeInTheDocument()
    );
    return utils;
  }

  /** The travelling card wrapper for a workflow, found via its map-face name. */
  function mapCard(name: string): HTMLElement {
    const names = Array.from(
      document.querySelectorAll<HTMLElement>(".al-name")
    );
    const el = names.find((n) => n.textContent === name);
    if (!el) throw new Error(`no map card for "${name}"`);
    return el.closest(".uv-wf") as HTMLElement;
  }

  it("renders condensed phase columns + workflow cards", async () => {
    await renderMap();
    expect(mapCard("Build")).toBeInTheDocument();
    expect(mapCard("Review")).toBeInTheDocument();
    // phase-column headers from kanban_column
    const headers = Array.from(document.querySelectorAll(".al-stagehd")).map(
      (h) => h.textContent ?? ""
    );
    expect(headers.some((t) => t.includes("Dev"))).toBe(true);
    expect(headers.some((t) => t.includes("QA"))).toBe(true);
  });

  it("renders step strips as ribbons", async () => {
    await renderMap();
    expect(screen.getAllByTestId("step-strip-ribbon").length).toBeGreaterThan(
      0
    );
  });

  it("dims non-matching cards when searching", async () => {
    await renderMap();

    // no query → nothing dimmed
    expect(mapCard("Build").className).not.toContain("dim");
    expect(mapCard("Review").className).not.toContain("dim");

    const search = screen.getByPlaceholderText(/find a workflow/i);
    fireEvent.change(search, { target: { value: "build" } });

    await waitFor(() => {
      expect(mapCard("Build").className).toContain("lit");
      expect(mapCard("Review").className).toContain("dim");
    });
  });

  it("shows the real step-type legend (no synthetic entry/final/done)", async () => {
    await renderMap();
    const legend = document.querySelector(".uv-legend") as HTMLElement;
    expect(within(legend).getByText("execute")).toBeInTheDocument();
    expect(within(legend).queryByText("entry")).not.toBeInTheDocument();
    expect(within(legend).queryByText("final")).not.toBeInTheDocument();
    expect(within(legend).queryByText("done")).not.toBeInTheDocument();
  });
});

/* ── P6 morph ──────────────────────────────────────────────────────
   Toggling the view should arm the shared-element morph (`morphing` on the
   scaler) and then clear it once the box transition has landed. The boxes are
   ONE persistent element across the toggle (same DOM node, new rect). */
describe("WorkflowAtlas — morph (P6)", () => {
  function scaler(): HTMLElement {
    return document.querySelector(".uv-scaler") as HTMLElement;
  }

  it("sets then clears `morphing` when the view toggles", async () => {
    vi.useFakeTimers();
    try {
      mockSummary.mockReturnValue({
        summary: FIXTURE,
        isLoading: false,
        error: null,
      });
      // both layouts resolve so a real box exists in either view
      layoutFullMock.mockImplementation(async (model) => stubLayout(model));

      render(<WorkflowAtlas />);
      // let the async ELK stub settle
      await act(async () => {
        await Promise.resolve();
      });
      expect(scaler()).toBeInTheDocument();
      expect(scaler().className).not.toContain("morphing");

      // toggle graph → map
      act(() => {
        fireEvent.click(screen.getByRole("radio", { name: "Map" }));
      });
      // morph is armed immediately (layout effect)
      expect(scaler().className).toContain("morphing");

      // …and clears once the box transition has landed
      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(scaler().className).not.toContain("morphing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one persistent box element across the toggle", async () => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);
    await waitFor(() =>
      expect(document.querySelector(".ag-wf-name")).toBeInTheDocument()
    );
    const before = Array.from(
      document.querySelectorAll<HTMLElement>(".uv-wf")
    ).find((el) => el.querySelector(".ag-wf-name")?.textContent === "Build")!;

    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    // the SAME node now carries the map face (graph face is hidden, not removed)
    expect(before.querySelector(".al-name")?.textContent).toBe("Build");
    expect(document.querySelectorAll(".uv-wf")).toContain(before);
  });
});

/* ── P7 hover-trace ────────────────────────────────────────────────
   Hovering a workflow lights its connected set and dims the rest, per view. */
describe("WorkflowAtlas — hover-trace (P7)", () => {
  /** The travelling box wrapper for a workflow, found via its graph-face name. */
  function graphBox(name: string): HTMLElement {
    const el = Array.from(
      document.querySelectorAll<HTMLElement>(".ag-wf-name")
    ).find((n) => n.textContent === name)!;
    return el.closest(".uv-wf") as HTMLElement;
  }

  it("applies lit/dim classes on hover (graph view)", async () => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);
    await waitFor(() =>
      expect(document.querySelector(".ag-wf-name")).toBeInTheDocument()
    );

    const build = graphBox("Build");
    const review = graphBox("Review");

    // nothing hovered → no trace state
    expect(build.className).not.toContain("lit");
    expect(build.className).not.toContain("dim");
    expect(review.className).not.toContain("dim");

    // hover Build → Build lit, the unconnected Review dimmed (no cross-edge in
    // the stub layout, so Review is outside Build's connected set)
    fireEvent.mouseEnter(build);
    expect(build.className).toContain("lit");
    expect(review.className).toContain("dim");

    // leave → trace clears
    fireEvent.mouseLeave(build);
    expect(build.className).not.toContain("lit");
    expect(review.className).not.toContain("dim");
  });

  it("keeps the workflow traced and emphasises the node when a step is hovered", async () => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);
    await waitFor(() =>
      expect(document.querySelector(".ag-step")).toBeInTheDocument()
    );

    const build = graphBox("Build");
    const review = graphBox("Review");
    // The "Execute" step node of wf-build (paints in the layer above the box).
    const stepName = Array.from(
      document.querySelectorAll<HTMLElement>(".ag-step-name")
    ).find((n) => n.textContent === "Execute")!;
    const stepNode = stepName.closest(".ag-step") as HTMLElement;

    // Hovering the step keeps its workflow traced (lit, NOT dropped) — the box
    // does not lose hover just because the cursor crossed onto a node above it.
    fireEvent.mouseEnter(stepNode);
    expect(build.className).toContain("lit");
    expect(review.className).toContain("dim");
    // …and the exact node under the cursor is emphasised over its lit siblings.
    expect(stepNode.className).toContain("s-hover");

    // leaving the node clears both the trace and the node emphasis
    fireEvent.mouseLeave(stepNode);
    expect(build.className).not.toContain("lit");
    expect(document.querySelector(".ag-step.s-hover")).not.toBeInTheDocument();
  });

  it("lights the matching canvas edge while an inspector transition row is hovered", async () => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
    // Enrich the stub so wf-build's loop-back (s2 → s1) actually renders on the
    // canvas — the base stub carries no intra edges.
    const model = buildAtlasModel(FIXTURE);
    const loop = model.edges.find((e) => e.kind === "loop")!;
    layoutFullMock.mockImplementation(async (m) => {
      const base = stubLayout(m);
      const wfBuild = base.workflows.find((w) => w.id === "wf-build")!;
      wfBuild.intra = [
        {
          id: loop.id,
          kind: "loop",
          from: loop.from,
          to: loop.to,
          fromWorkflow: loop.fromWorkflow,
          toWorkflow: loop.toWorkflow,
          label: loop.label,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          labelPos: null,
        },
      ];
      return base;
    });

    renderAtlasWithEntityHost();
    await waitFor(() =>
      expect(document.querySelector(".gedge.k-loop")).toBeInTheDocument()
    );
    const loopEdge = document.querySelector(".gedge.k-loop")!;
    expect(loopEdge.getAttribute("class")).not.toContain("lit");

    // open the wf-build inspector, then hover its loop-back row
    fireEvent.click(graphBox("Build"));
    const row = await waitFor(() => {
      const el = document.querySelector(".wfd-tr.loop");
      if (!el) throw new Error("loop-back row not rendered yet");
      return el as HTMLElement;
    });

    fireEvent.mouseEnter(row);
    expect(loopEdge.getAttribute("class")).toContain("lit");

    fireEvent.mouseLeave(row);
    expect(loopEdge.getAttribute("class")).not.toContain("lit");
  });

  it("colours a row-hovered edge by route direction: a route IN lights white (back), not by geometry", async () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow("wf-a", [makeStep("a1", "wf-a", 0, { name: "Aye" })], {
          name: "Aye",
        }),
        makeWorkflow("wf-b", [makeStep("b1", "wf-b", 0, { name: "Bee" })], {
          name: "Bee",
        }),
      ],
    };
    // wf-a → wf-b handoff. In the stub, wf-a sits ABOVE wf-b, so geometric
    // detection would call this "forward" (orange). But hovering wf-b's Routes-IN
    // row must light it white, because relative to wf-b it's an incoming route.
    summary.workflows[0].transitions = [
      {
        id: "x1",
        from_workflow_id: "wf-a",
        to_workflow_id: "wf-b",
        target_step_id: "b1",
        label: "go",
      },
    ];
    mockSummary.mockReturnValue({ summary, isLoading: false, error: null });

    const cross = buildAtlasModel(summary).edges.find(
      (e) => e.kind === "cross"
    )!;
    layoutFullMock.mockImplementation(async (m) => {
      const base = stubLayout(m);
      base.cross = [
        {
          id: cross.id,
          kind: "cross",
          from: cross.from,
          to: cross.to,
          fromWorkflow: cross.fromWorkflow,
          toWorkflow: cross.toWorkflow,
          label: cross.label,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          labelPos: null,
        },
      ];
      return base;
    });

    renderAtlasWithEntityHost();
    // scope to the GRAPH cross-edge layer (the map layer also renders a hidden
    // handoff path for the same workflow pair).
    await waitFor(() =>
      expect(
        document.querySelector(".ag-edges .gedge.k-handoff")
      ).toBeInTheDocument()
    );
    const edge = document.querySelector(".ag-edges .gedge.k-handoff")!;

    // open wf-b's inspector → the handoff is a ROUTE IN there
    fireEvent.click(graphBox("Bee"));
    const inRow = await waitFor(() => {
      const el = document.querySelector(".wfd-tr.in");
      if (!el) throw new Error("routes-in row not rendered yet");
      return el as HTMLElement;
    });

    fireEvent.mouseEnter(inRow);
    const cls = edge.getAttribute("class") ?? "";
    expect(cls).toContain("lit");
    expect(cls).toContain("back"); // white by direction, NOT geometric forward
  });

  it("colours box-hover edges by direction relative to the hovered workflow", async () => {
    const summary: PipelineSummary = {
      workflows: [
        makeWorkflow("wf-a", [makeStep("a1", "wf-a", 0, { name: "Aye" })], {
          name: "Aye",
        }),
        makeWorkflow("wf-b", [makeStep("b1", "wf-b", 0, { name: "Bee" })], {
          name: "Bee",
        }),
      ],
    };
    // wf-a → wf-b handoff. wf-a sits ABOVE wf-b in the stub (geometric = forward).
    summary.workflows[0].transitions = [
      {
        id: "x1",
        from_workflow_id: "wf-a",
        to_workflow_id: "wf-b",
        target_step_id: "b1",
        label: "go",
      },
    ];
    mockSummary.mockReturnValue({ summary, isLoading: false, error: null });

    const cross = buildAtlasModel(summary).edges.find(
      (e) => e.kind === "cross"
    )!;
    layoutFullMock.mockImplementation(async (m) => {
      const base = stubLayout(m);
      base.cross = [
        {
          id: cross.id,
          kind: "cross",
          from: cross.from,
          to: cross.to,
          fromWorkflow: cross.fromWorkflow,
          toWorkflow: cross.toWorkflow,
          label: cross.label,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          labelPos: null,
        },
      ];
      return base;
    });

    render(<WorkflowAtlas />);
    await waitFor(() =>
      expect(
        document.querySelector(".ag-edges .gedge.k-handoff")
      ).toBeInTheDocument()
    );
    const edge = document.querySelector(".ag-edges .gedge.k-handoff")!;

    // Hover wf-b → the handoff is an INCOMING route → white (back).
    fireEvent.mouseEnter(graphBox("Bee"));
    let cls = edge.getAttribute("class") ?? "";
    expect(cls).toContain("lit");
    expect(cls).toContain("back");
    fireEvent.mouseLeave(graphBox("Bee"));

    // Hover wf-a → the SAME handoff is an OUTGOING route → accent (not back).
    fireEvent.mouseEnter(graphBox("Aye"));
    cls = edge.getAttribute("class") ?? "";
    expect(cls).toContain("lit");
    expect(cls).not.toContain("back");
  });
});
