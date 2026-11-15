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
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { useFactoryFilterStore } from "../../stores/factoryFilterStore";
import { GlobalEntityPanelHost } from "../GlobalEntityPanelHost";
import { WorkflowAtlas, layoutKey } from "./WorkflowAtlas";

/* ── mocks ─────────────────────────────────────────────────────────
   The Graph renders through the real shared machine-flow compiler and layout
   (jsdom exercises the layout client's documented non-browser fallback).
   `usePipelineSummary` is mocked per-test to drive loading / empty / error /
   ready states. The background warm-up has its own tests. */

vi.mock("./adapter/useAtlasLayoutWarmup", () => ({
  useAtlasLayoutWarmup: () => undefined,
}));

// The Run Console owns its own task feed (listReady + realtime events) and is
// covered by RunConsole.test.tsx. Stub it here so the atlas-canvas tests don't
// have to stand up the Tauri command/event plumbing it needs.
vi.mock("./RunConsole", () => ({ RunConsole: () => null }));

// The board's own data flow is covered by KanbanBoard tests; here it only
// needs to show which factory scope the Atlas hands it.
vi.mock("../KanbanBoard", () => ({
  KanbanBoard: ({ factoryName }: { factoryName: unknown }) => (
    <div data-testid="kanban-board-stub">
      {typeof factoryName === "string" ? factoryName : "no-factory"}
    </div>
  ),
}));

const mockSummary = vi.fn();
vi.mock("../../hooks/usePipelineSummary", () => ({
  usePipelineSummary: () => mockSummary(),
}));

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
    step_type: "llm_inference",
    transitions_to: [],
    transition_sessions: {},
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

/** Workflow names drawn as region headers in the shared Graph scene. */
function regionNames(): string[] {
  return Array.from(document.querySelectorAll("[data-region-header]")).map(
    (header) => (header.getAttribute("aria-label") ?? "").split(". ")[0]
  );
}

/** The scoped shared Graph, once its layout has resolved. */
function findScopedGraph() {
  return screen.findByLabelText("Factory workflow graph");
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
  it("shows the loading state before the summary resolves", () => {
    mockSummary.mockReturnValue({
      summary: null,
      isLoading: true,
      error: null,
    });
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

  it("starts without the retired legacy Graph toggle or renderer", async () => {
    mockSummary.mockReturnValue({
      summary: ALL_IN_FACTORY_FIXTURE,
      isLoading: false,
      error: null,
    });
    // A clean default launch: no stored experimental setting is consulted.
    window.localStorage.clear();
    render(<WorkflowAtlas />);
    expect(await findScopedGraph()).toBeInTheDocument();
    expect(document.querySelector(".ag-step")).toBeNull();
    expect(document.querySelector(".ag-wf-name")).toBeNull();
    expect(document.querySelector(".ag-edges")).toBeNull();
    expect(document.querySelector(".morphing")).toBeNull();
  });

  it("shows opaque factory nodes and collapsed routes until a factory is selected", async () => {
    useFactoryFilterStore.getState().reset();
    mockSummary.mockReturnValue({
      summary: OVERVIEW_FIXTURE,
      isLoading: false,
      error: null,
    });

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
    expect(document.querySelector(".factory-overview-workflows")).toHaveClass(
      "is-collapsed"
    );
    expect(
      document.querySelector(".factory-overview-map-columns")
    ).not.toBeInTheDocument();
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
    expect(document.querySelector(".uv-legend")).not.toBeInTheDocument();
    // The collapsed Graph overview holds the shared scene, never legacy cards.
    expect(
      await screen.findByLabelText("Factory overview workflow graph")
    ).toBeInTheDocument();
    expect(
      document.querySelectorAll(".factory-overview-workflows .uv-wf")
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    expect(screen.getByTestId("factory-overview")).toBeInTheDocument();
    expect(
      document.querySelectorAll(".factory-overview-factories .uv-wf")
    ).toHaveLength(4);
    expect(
      document.querySelector(".factory-overview-map-columns")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-node-Unnamed workflow")
    ).toBeInTheDocument();
    const workflowEdges = Array.from(
      document.querySelectorAll(".factory-overview-workflow-edges")
    );
    expect(workflowEdges.length).toBeGreaterThan(0);
    expect(
      workflowEdges.every((edge) => edge.classList.contains("is-hidden"))
    ).toBe(true);

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

    render(<WorkflowAtlas />);

    const stage = await screen.findByTestId("factory-overview-stage");
    await screen.findByLabelText("Factory overview workflow graph");
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
      expect(
        screen.getByTestId("factory-region-Factory A")
      ).toBeInTheDocument();
      expect(document.querySelector(".factory-overview-workflows")).toHaveClass(
        "is-expanded"
      );
    });
    expect(regionNames()).toEqual(
      expect.arrayContaining(["Build", "Review", "Pack", "Ship"])
    );
    expect(
      document.querySelectorAll(".factory-overview-factories .uv-wf")
    ).toHaveLength(4);
    expect(
      document.querySelectorAll(
        ".factory-overview-factories .factory-node .uv-wf"
      )
    ).toHaveLength(0);
    expect(
      document.querySelectorAll(".factory-overview-workflows .md-wire path")
        .length
    ).toBeGreaterThan(0);
  });

  it("links the factory index to the map and remembers the opened factory", async () => {
    useFactoryFilterStore.getState().reset();
    mockSummary.mockReturnValue({
      summary: OVERVIEW_FIXTURE,
      isLoading: false,
      error: null,
    });

    render(<WorkflowAtlas />);

    expect(
      await screen.findByRole("heading", { name: "Workflow Factories" })
    ).toBeInTheDocument();
    const index = screen.getByRole("navigation", { name: "Factories" });
    expect(index).toHaveTextContent("Factory A");
    expect(screen.getAllByTestId(/factory-index-row-/)).toHaveLength(4);

    // Hovering a row lights its marker, keeps linked factories at rest and
    // quiets the rest; the routes follow the same rule.
    fireEvent.mouseEnter(screen.getByTestId("factory-index-row-Factory A"));
    expect(screen.getByTestId("factory-node-Factory A")).toHaveClass("lit");
    expect(screen.getByTestId("factory-node-Factory B")).not.toHaveClass("dim");
    expect(screen.getByTestId("factory-node-Factory C")).toHaveClass("dim");
    expect(
      screen
        .getByTestId("factory-transition-Factory A>Factory B")
        .querySelector(".gedge")
    ).toHaveClass("lit");
    expect(
      screen
        .getByTestId("factory-transition-Factory B>Factory C")
        .querySelector(".gedge")
    ).toHaveClass("dim");

    // Hovering a marker highlights the matching row.
    fireEvent.mouseEnter(screen.getByTestId("factory-node-Factory C"));
    expect(screen.getByTestId("factory-index-row-Factory C")).toHaveClass(
      "is-hot"
    );

    // A factory search is dropped once the factory opens.
    fireEvent.change(screen.getByPlaceholderText("Find a factory…"), {
      target: { value: "factory b" },
    });
    expect(screen.getAllByTestId(/factory-index-row-/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId("factory-index-row-Factory B"));
    expect(await screen.findByPlaceholderText("Find a workflow…")).toHaveValue(
      ""
    );

    fireEvent.click(screen.getByRole("button", { name: "Factories" }));
    const recent = await screen.findByTestId("factory-index-row-Factory B");
    expect(recent).toHaveAttribute("aria-current", "location");
    expect(recent).toHaveTextContent("last opened");
  });

  it("selects No Factory as an exact null workflow scope", async () => {
    useFactoryFilterStore.getState().reset();
    mockSummary.mockReturnValue({
      summary: OVERVIEW_FIXTURE,
      isLoading: false,
      error: null,
    });

    render(<WorkflowAtlas />);

    fireEvent.click(await screen.findByTestId("factory-node-No Factory"));

    await findScopedGraph();
    await waitFor(() => expect(regionNames()).toEqual(["Unclassified"]));

    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".uv-wf")).toHaveLength(1);
      expect(document.querySelector(".al-name")).toHaveTextContent(
        "Unclassified"
      );
    });
  });

  it("opens an opaque factory node into that factory's graph", async () => {
    useFactoryFilterStore.getState().reset();
    mockSummary.mockReturnValue({
      summary: OVERVIEW_FIXTURE,
      isLoading: false,
      error: null,
    });

    render(<WorkflowAtlas />);

    fireEvent.click(await screen.findByTestId("factory-node-Factory A"));

    await findScopedGraph();
    await waitFor(() => {
      const names = regionNames();
      expect(names).toContain("Build");
      expect(names).toContain("Unnamed workflow");
    });
    expect(regionNames()).not.toContain("Review");
  });

  it("renders the shared graph from a fixture summary", async () => {
    mockSummary.mockReturnValue({
      summary: ALL_IN_FACTORY_FIXTURE,
      isLoading: false,
      error: null,
    });

    render(<WorkflowAtlas />);

    await findScopedGraph();
    // A factory scope replaces the topology crumb with a way back out.
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Factories/Factory A");
    expect(
      screen.queryByText("design · workflow topology · elk")
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(regionNames()).toEqual(expect.arrayContaining(["Build", "Review"]))
    );

    // step parts carry the step names
    expect(screen.getByTestId("step-node-Plan")).toBeInTheDocument();
    expect(screen.getByTestId("step-node-Ship")).toBeInTheDocument();

    // wf-review has an active TaskRun: its header reports it
    const review = Array.from(
      document.querySelectorAll("[data-region-header]")
    ).find((header) => header.getAttribute("aria-label")?.startsWith("Review"));
    expect(review?.getAttribute("aria-label")).toMatch(/2 active/);

    // zoom widget + search (the toolbar carries it in graph view too)
    expect(screen.getByLabelText(/fit to view/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/find a workflow/i)).toBeInTheDocument();
    // The Map legend belongs to the Map view only.
    expect(document.querySelector(".uv-legend")).not.toBeInTheDocument();
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

    renderAtlasWithEntityHost();
    await findScopedGraph();
    const build = await waitFor(() => {
      const header = Array.from(
        document.querySelectorAll<SVGElement>("[data-region-header]")
      ).find((el) => el.getAttribute("aria-label")?.startsWith("Build"));
      if (!header) throw new Error("Build header not rendered yet");
      return header;
    });

    fireEvent.click(build);
    expect(await screen.findByText(/Workflow Details/)).toBeInTheDocument();
    const inspector = screen.getByTestId("global-entity-panel");
    expect(inspector).toHaveAttribute("data-chat-adjacent", "true");
    expect(inspector.style.getPropertyValue("--detail-panel-chat-offset")).toBe(
      "calc(432px + var(--s-3))"
    );

    fireEvent.click(
      screen.getByTestId("step-node-Execute").querySelector("[data-part-id]")!
    );
    expect(await screen.findByText("Step Configuration")).toBeInTheDocument();
    expect(inspector).toHaveAttribute("data-chat-adjacent", "true");
    expect(screen.getAllByTestId("global-entity-panel")).toHaveLength(1);
  });

  it("scopes Graph and Map to the selected exact factory", async () => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });

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

    await findScopedGraph();
    await waitFor(() => expect(regionNames()).toEqual(["Build"]));

    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".uv-wf")).toHaveLength(1);
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
  async function renderMap(summary: PipelineSummary = ALL_IN_FACTORY_FIXTURE) {
    mockSummary.mockReturnValue({ summary, isLoading: false, error: null });
    const utils = render(<WorkflowAtlas />);
    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    // condensed cards render synchronously once the map is active
    await waitFor(() =>
      expect(document.querySelector(".al-name")).toBeInTheDocument()
    );
    return utils;
  }

  /** The card wrapper for a workflow, found via its map-face name. */
  function mapCard(name: string): HTMLElement {
    const names = Array.from(
      document.querySelectorAll<HTMLElement>(".al-name")
    );
    const el = names.find((n) => n.textContent === name);
    if (!el) throw new Error(`no map card for "${name}"`);
    return el.closest(".uv-wf") as HTMLElement;
  }

  /** wf-a → wf-b, where wf-a sits left of wf-b in the condensed map. */
  const HANDOFF: PipelineSummary = {
    workflows: [
      makeWorkflow("wf-a", [makeStep("a1", "wf-a", 0, { name: "Aye" })], {
        name: "Aye",
        transitions: [
          {
            id: "x1",
            from_workflow_id: "wf-a",
            to_workflow_id: "wf-b",
            target_step_id: "b1",
            label: "go",
          },
        ],
      }),
      makeWorkflow("wf-b", [makeStep("b1", "wf-b", 0, { name: "Bee" })], {
        name: "Bee",
        display_order: 1,
      }),
      makeWorkflow("wf-c", [makeStep("c1", "wf-c", 0, { name: "Sea" })], {
        name: "Sea",
        display_order: 2,
      }),
    ],
  };

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
    // Map cards carry no Graph face.
    expect(document.querySelector(".uv-face-graph")).toBeNull();
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
    expect(within(legend).getByText("llm")).toBeInTheDocument();
    expect(within(legend).queryByText("entry")).not.toBeInTheDocument();
    expect(within(legend).queryByText("final")).not.toBeInTheDocument();
    expect(within(legend).queryByText("done")).not.toBeInTheDocument();
    // Each of the eight backend step types appears exactly once.
    const items = Array.from(legend.querySelectorAll(".lg-item")).map(
      (item) => item.textContent
    );
    expect(items).toHaveLength(8);
    expect(new Set(items).size).toBe(8);
  });

  it("traces a hovered workflow's handoffs and colours them by direction", async () => {
    await renderMap(HANDOFF);
    const board = document.querySelector(".uv-board")!;
    const edge = () =>
      document
        .querySelector(".al-edges .gedge.k-handoff")!
        .getAttribute("class") ?? "";
    expect(edge()).not.toMatch(/\b(lit|dim)\b/);

    // Hover wf-b → the handoff is an INCOMING route → white (back); the
    // unconnected workflow recedes.
    fireEvent.mouseEnter(mapCard("Bee"));
    expect(board.className).toContain("trace-wf");
    expect(mapCard("Bee").className).toContain("lit");
    expect(mapCard("Aye").className).toContain("lit");
    expect(mapCard("Sea").className).toContain("dim");
    expect(edge()).toContain("lit");
    expect(edge()).toContain("back");
    fireEvent.mouseLeave(mapCard("Bee"));
    expect(board.className).not.toContain("trace-wf");
    expect(mapCard("Sea").className).not.toContain("dim");

    // Hover wf-a → the SAME handoff is an OUTGOING route → accent (not back).
    fireEvent.mouseEnter(mapCard("Aye"));
    expect(edge()).toContain("lit");
    expect(edge()).not.toContain("back");
  });

  it("lights the map handoff for a hovered inspector row, coloured by route direction", async () => {
    mockSummary.mockReturnValue({
      summary: HANDOFF,
      isLoading: false,
      error: null,
    });
    renderAtlasWithEntityHost();
    fireEvent.click(screen.getByRole("radio", { name: "Map" }));
    await waitFor(() =>
      expect(
        document.querySelector(".al-edges .gedge.k-handoff")
      ).toBeInTheDocument()
    );
    const edge = document.querySelector(".al-edges .gedge.k-handoff")!;

    // open wf-b's inspector → the handoff is a ROUTE IN there
    fireEvent.click(
      within(mapCard("Bee")).getByRole("button", { name: "Bee" })
    );
    const inRow = await waitFor(() => {
      const el = document.querySelector(".wfd-tr.in");
      if (!el) throw new Error("routes-in row not rendered yet");
      return el as HTMLElement;
    });

    fireEvent.mouseEnter(inRow);
    expect(edge.getAttribute("class")).toContain("lit");
    expect(edge.getAttribute("class")).toContain("back");
    expect(mapCard("Sea").className).toContain("dim");

    fireEvent.mouseLeave(inRow);
    expect(edge.getAttribute("class")).not.toContain("lit");
  });
});

describe("WorkflowAtlas — BOARD view", () => {
  beforeEach(() => {
    mockSummary.mockReturnValue({
      summary: FIXTURE,
      isLoading: false,
      error: null,
    });
  });

  it("offers Board only while a factory is selected", async () => {
    useFactoryFilterStore.getState().reset();
    render(<WorkflowAtlas />);

    expect(await screen.findByTestId("factory-overview")).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Board" })
    ).not.toBeInTheDocument();

    act(() => useFactoryFilterStore.getState().setFactoryName("Factory A"));

    expect(screen.getByRole("radio", { name: "Board" })).toBeInTheDocument();
  });

  it("renders the selected factory's board in place of the canvas", async () => {
    render(<WorkflowAtlas />);

    fireEvent.click(screen.getByRole("radio", { name: "Board" }));

    expect(screen.getByTestId("kanban-board-stub")).toHaveTextContent(
      "Factory A"
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Workflow Board"
    );
    expect(document.querySelector(".uv-scaler")).not.toBeInTheDocument();
    expect(document.querySelector(".uv-legend")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/find a workflow/i)
    ).not.toBeInTheDocument();
  });

  it("follows the Atlas factory filter", async () => {
    render(<WorkflowAtlas />);
    fireEvent.click(screen.getByRole("radio", { name: "Board" }));

    act(() => useFactoryFilterStore.getState().setFactoryName("Factory B"));

    expect(screen.getByTestId("kanban-board-stub")).toHaveTextContent(
      "Factory B"
    );
  });

  it("returns to the factory overview when the factory is cleared", async () => {
    render(<WorkflowAtlas />);
    fireEvent.click(screen.getByRole("radio", { name: "Board" }));

    act(() => useFactoryFilterStore.getState().setFactoryName(null));

    expect(await screen.findByTestId("factory-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("kanban-board-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Map" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("goes back to the topology canvas when leaving Board", async () => {
    render(<WorkflowAtlas />);
    fireEvent.click(screen.getByRole("radio", { name: "Board" }));
    fireEvent.click(screen.getByRole("radio", { name: "Map" }));

    expect(screen.queryByTestId("kanban-board-stub")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector(".uv-scaler")).toBeInTheDocument()
    );
  });
});

it("keeps shared rendering in Graph and returns through Map, Board and the factory overview", async () => {
  mockSummary.mockReturnValue({
    summary: FIXTURE,
    isLoading: false,
    error: null,
  });
  const view = render(<WorkflowAtlas />);
  expect(await findScopedGraph()).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Map" }));
  expect(
    screen.queryByLabelText("Factory workflow graph")
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(view.container.querySelector(".uv-board")).not.toBeNull()
  );
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(screen.getByTestId("kanban-board-stub")).toHaveTextContent(
    "Factory A"
  );
  fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
  expect(await findScopedGraph()).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Factories" }));
  expect(await screen.findByTestId("factory-overview")).toBeInTheDocument();
  expect(
    screen.queryByLabelText("Factory workflow graph")
  ).not.toBeInTheDocument();
});
