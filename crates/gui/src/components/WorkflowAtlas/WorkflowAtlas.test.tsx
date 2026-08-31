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
import { useFactoryFilterStore } from "../../stores/factoryFilterStore";
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
  useFactoryFilterStore.getState().setFactoryName("Factory A");
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
    factory_name:
      overrides.factory_name !== undefined
        ? overrides.factory_name
        : "Factory A",
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

const ALL_IN_FACTORY_FIXTURE: PipelineSummary = {
  workflows: FIXTURE.workflows.map((workflow) => ({
    ...workflow,
    factory_name: "Factory A",
  })),
};

const OVERVIEW_FIXTURE: PipelineSummary = {
  workflows: [
    makeWorkflow("wf-build", FIXTURE.workflows[0].workflow_steps, {
      name: "Build",
      description: "Build pipeline",
      kanban_column: "Dev",
      factory_name: "Factory A",
      transitions: [
        {
          id: "transition-build-review",
          from_workflow_id: "wf-build",
          to_workflow_id: "wf-review",
          target_step_id: "r1",
          label: "ready for review",
        },
        {
          id: "transition-build-pack",
          from_workflow_id: "wf-build",
          to_workflow_id: "wf-pack",
          target_step_id: "p1",
          label: "direct pack",
        },
      ],
    }),
    makeWorkflow(
      "wf-unnamed",
      [makeStep("n1", "wf-unnamed", 0, { name: "Intake" })],
      { name: "", factory_name: "Factory A", display_order: 1 }
    ),
    makeWorkflow(
      "wf-review",
      [makeStep("r1", "wf-review", 0, { name: "Approve" })],
      {
        name: "Review",
        kanban_column: "QA",
        factory_name: "Factory B",
        display_order: 2,
        transitions: [
          {
            id: "transition-review-pack",
            from_workflow_id: "wf-review",
            to_workflow_id: "wf-pack",
            target_step_id: "p1",
            label: "approved",
          },
          {
            id: "transition-review-ship",
            from_workflow_id: "wf-review",
            to_workflow_id: "wf-ship",
            target_step_id: "s1",
            label: "ship from B",
          },
        ],
      }
    ),
    makeWorkflow("wf-pack", [makeStep("p1", "wf-pack", 0, { name: "Pack" })], {
      name: "Pack",
      kanban_column: "QA",
      factory_name: "Factory B",
      display_order: 3,
      transitions: [
        {
          id: "transition-pack-ship",
          from_workflow_id: "wf-pack",
          to_workflow_id: "wf-ship",
          target_step_id: "s1",
          label: "packed",
        },
      ],
    }),
    makeWorkflow(
      "wf-ship",
      [makeStep("s1", "wf-ship", 0, { name: "Ship", step_type: "finish" })],
      { name: "Ship", factory_name: "Factory C", display_order: 4 }
    ),
    makeWorkflow(
      "wf-unclassified",
      [makeStep("u1", "wf-unclassified", 0, { name: "Unclassified" })],
      {
        name: "Unclassified",
        factory_name: null,
        display_order: 5,
        transitions: [
          {
            id: "transition-unclassified-build",
            from_workflow_id: "wf-unclassified",
            to_workflow_id: "wf-build",
            target_step_id: "s1",
            label: "classified",
          },
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
  const cross = model.edges
    .filter((edge) => edge.kind === "cross")
    .map((edge, index) => ({
      ...edge,
      points: [
        { x: 620, y: 80 + index * 18 },
        { x: 680, y: 80 + index * 18 },
      ],
      labelPos: null,
    }));
  return {
    width: 700,
    height: 20 + model.workflows.length * 240,
    workflows,
    cross,
    hubIds: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
  useEntityPanelStore.getState().reset();
  useFactoryFilterStore.getState().reset();
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
      await screen.findByText(/no factories configured/i)
    ).toBeInTheDocument();
  });

  it("shows opaque factory nodes and collapsed routes until a factory is selected", async () => {
    useFactoryFilterStore.getState().reset();
    mockSummary.mockReturnValue({
      summary: OVERVIEW_FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);

    expect(await screen.findByTestId("factory-overview")).toBeInTheDocument();
    expect(
      screen.queryByText("design · workflow topology · elk")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Zoom in to inspect the workflows in place")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("factory-node-Factory A")).toBeInTheDocument();
    expect(screen.getByTestId("factory-node-Factory B")).toBeInTheDocument();
    expect(screen.getByTestId("factory-node-Factory C")).toBeInTheDocument();
    expect(screen.getByTestId("factory-node-No Factory")).toBeInTheDocument();
    expect(screen.getAllByTestId(/factory-node-/)).toHaveLength(4);
    expect(
      document.querySelectorAll(".factory-overview-factories .uv-wf")
    ).toHaveLength(4);
    expect(
      screen.getByTestId("workflow-node-Unnamed workflow")
    ).toBeInTheDocument();
    expect(document.querySelector(".factory-overview-workflows")).toHaveClass(
      "is-collapsed"
    );
    expect(
      document.querySelector(".factory-overview-map-columns")
    ).not.toBeInTheDocument();
    const workflowEdges = Array.from(
      document.querySelectorAll(".factory-overview-workflow-edges")
    );
    expect(workflowEdges.length).toBeGreaterThan(0);
    expect(
      workflowEdges.every((edge) => edge.classList.contains("is-hidden"))
    ).toBe(true);
    expect(document.querySelector(".factory-overview-regions")).toHaveClass(
      "is-hidden"
    );
    expect(
      screen.getByTestId("factory-transition-Factory A>Factory B")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("factory-transition-Factory B>Factory C")
    ).toBeInTheDocument();
    expect(screen.getAllByText("2 routes")).toHaveLength(2);
    expect(
      document.querySelectorAll(".factory-overview-factories .ag-step")
    ).toHaveLength(0);
    expect(document.querySelector(".factory-overview-workflows")).toHaveClass(
      "is-collapsed"
    );
    expect(document.querySelector(".uv-legend")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    expect(screen.getByTestId("factory-overview")).toBeInTheDocument();
    expect(
      document.querySelectorAll(".factory-overview-factories .uv-wf")
    ).toHaveLength(4);
    expect(
      document.querySelector(".factory-overview-map-columns")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
    expect(
      document.querySelector(".factory-overview-map-columns")
    ).not.toBeInTheDocument();
  });

  it("pans the factory surface and reveals workflow contents after zooming in", async () => {
    useFactoryFilterStore.getState().reset();
    mockSummary.mockReturnValue({
      summary: OVERVIEW_FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);

    const stage = await screen.findByTestId("factory-overview-stage");
    expect(screen.getByTestId("workflow-node-Build")).toBeInTheDocument();
    expect(document.querySelector(".factory-overview-workflows")).toHaveClass(
      "is-collapsed"
    );

    fireEvent.pointerDown(stage, {
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 130 });
    fireEvent.pointerUp(window);
    expect(stage).not.toHaveClass("is-grabbing");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    await waitFor(() => {
      expect(screen.getByTestId("step-node-Plan")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-node-Build")).toBeInTheDocument();
      expect(
        screen.getByTestId("factory-region-Factory A")
      ).toBeInTheDocument();
      expect(document.querySelector(".factory-overview-workflows")).toHaveClass(
        "is-expanded"
      );
      expect(
        document.querySelector(".factory-overview-workflow-edges")
      ).toHaveClass("is-visible");
    });
    expect(
      document.querySelectorAll(".factory-overview-factories .uv-wf")
    ).toHaveLength(4);
    expect(
      document.querySelectorAll(
        ".factory-overview-factories .factory-node .uv-wf"
      )
    ).toHaveLength(0);
    expect(
      document.querySelectorAll(".factory-overview-workflow-edges .gedge")
        .length
    ).toBeGreaterThan(0);
  });

  it("selects No Factory as an exact null workflow scope", async () => {
    useFactoryFilterStore.getState().reset();
    mockSummary.mockReturnValue({
      summary: OVERVIEW_FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);

    fireEvent.click(screen.getByTestId("factory-node-No Factory"));

    await waitFor(() => {
      expect(document.querySelector(".ag-wf-name")).toHaveTextContent(
        "Unclassified"
      );
      expect(document.querySelectorAll(".uv-wf")).toHaveLength(1);
    });
    expect(document.querySelector(".ag-wf-name")).not.toHaveTextContent(
      "Build"
    );

    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    await waitFor(() =>
      expect(document.querySelector(".al-name")).toHaveTextContent(
        "Unclassified"
      )
    );
  });

  it("zooms from an opaque factory node into that factory's graph", async () => {
    useFactoryFilterStore.getState().reset();
    mockSummary.mockReturnValue({
      summary: OVERVIEW_FIXTURE,
      isLoading: false,
      error: null,
    });
    layoutFullMock.mockImplementation(async (model) => stubLayout(model));

    render(<WorkflowAtlas />);

    fireEvent.click(screen.getByTestId("factory-node-Factory A"));

    await waitFor(() => {
      expect(document.querySelectorAll(".uv-wf")).toHaveLength(2);
      const names = Array.from(document.querySelectorAll(".ag-wf-name")).map(
        (name) => name.textContent
      );
      expect(names).toContain("Build");
      expect(names).toContain("Unnamed workflow");
    });
    expect(
      Array.from(document.querySelectorAll(".ag-wf-name")).map(
        (name) => name.textContent
      )
    ).not.toContain("Review");
  });

  it("renders the graph from a fixture summary", async () => {
    mockSummary.mockReturnValue({
      summary: ALL_IN_FACTORY_FIXTURE,
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
    expect(
      screen.getByText("design · workflow topology · elk")
    ).toBeInTheDocument();
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
      summary: ALL_IN_FACTORY_FIXTURE,
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
      summary: ALL_IN_FACTORY_FIXTURE,
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
        workflows: ALL_IN_FACTORY_FIXTURE.workflows.map((w) => ({
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

    useFactoryFilterStore.getState().reset();
    render(<WorkflowAtlas />);
    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-testid^='factory-node-']")
      ).toHaveLength(2)
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
      summary: ALL_IN_FACTORY_FIXTURE,
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
        summary: ALL_IN_FACTORY_FIXTURE,
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
      summary: ALL_IN_FACTORY_FIXTURE,
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
      summary: ALL_IN_FACTORY_FIXTURE,
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
      summary: ALL_IN_FACTORY_FIXTURE,
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
