/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — the canonical workflow-topology surface.

   GRAPH view — the shared machine-flow path: the adapter, the
                `useLaidOutFlow` worker/cache and `AtlasMachineScene`, hosted
                by `ScopedMachineGraph` (factory scope) and by the zoom-expanded
                `FactoryOverview` (no scope). See adapter/README.md.
   MAP view   — `layoutCondensed`: deterministic value-stream phase columns,
                condensed workflow cards (step-count + live ember only),
                aggregated workflow→workflow edges with condition chips, plus
                a lit/dim workflow search.
   BOARD view — the factory's Kanban board (`KanbanBoard`). Columns come from
                the same `kanban_column` values the map uses as phases, so the
                board only exists while a factory scope is selected.

   HOVER-TRACE (Map) — hovering a workflow is a quiet trace: its handoffs show
   at full opacity in their in/out colour (no glow), connected workflows tint
   their name, and the rest dims mildly. Search and trace compose: a query
   dims non-matches; a trace overrides with lit/dim within the matches.

   Re-layout discipline: the condensed map layout is pure + synchronous and is
   memoised on a STRUCTURAL key (workflow/step ids + kinds + phases + edge
   topology). Live `pipeline_counts` change the `live` ember and re-render
   chrome only — they never re-trigger a layout.

   Ported from docs/design/workflow-views.jsx (UnifiedViews).
   ────────────────────────────────────────────────────────────────── */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScopedMachineGraph } from "./ScopedMachineGraph";
import { useAtlasLayoutWarmup } from "./adapter/useAtlasLayoutWarmup";
import type { PanZoomTransform } from "./hooks/usePanZoom";
import { useProjectScopeGeneration } from "../../stores/projectScopedStores";
import { SearchInput } from "../molecules/SearchInput";
import {
  SegmentedControl,
  type SegmentedOption,
} from "../molecules/SegmentedControl";
import { FactoryFilter } from "../FactoryFilter";
import { KanbanBoard } from "../KanbanBoard";
import {
  factoryScopeExists,
  filterByFactory,
  isNoFactoryScope,
  type FactoryFilterValue,
} from "../../utils/workflowFactory";
import { usePipelineSummary } from "../../hooks/usePipelineSummary";
import { useSteps } from "../../hooks/useStep";
import type { JsonValue, RouteStepConfig } from "../../bindings";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { ColumnHeader } from "./ColumnHeader";
import { EdgeLabel } from "./EdgeLabel";
import { GraphEdge } from "./GraphEdge";
import { GraphMarkers } from "./GraphMarkers";
import { KindLegend } from "./KindLegend";
import { FactoryOverview } from "./FactoryOverview";
import { RunConsole } from "./RunConsole";
import { WfBox, type WfBoxState } from "./WfBox";
import { ZoomWidget } from "./ZoomWidget";
import { buildAtlasModel } from "./adapter/buildAtlasModel";
import { usePanZoom } from "./hooks/usePanZoom";
import { useFactoryFilterStore } from "../../stores/factoryFilterStore";
import { roundedPath } from "./layout/geometry";
import { layoutCondensed } from "./layout/layoutCondensed";
import type { AtlasModel, CondensedLayout, Kind } from "./layout/types";
import "./WorkflowAtlas.css";

const COND_OPTS = { boxW: 264, boxH: 140 } as const;

/** Delay before reframing the Map once its canvas has mounted. */
const MAP_FIT_DELAY = 30;

export type AtlasView = "graph" | "map" | "board";

const TOPOLOGY_VIEW_OPTIONS: ReadonlyArray<SegmentedOption<AtlasView>> = [
  { value: "map", label: "Map" },
  { value: "graph", label: "Graph" },
];
const BOARD_VIEW_OPTION: SegmentedOption<AtlasView> = {
  value: "board",
  label: "Board",
};

/** Trace/search visual state applied to a card or edge. */
type TraceState = "" | "lit" | "dim";

/**
 * Structural fingerprint of an `AtlasModel`: everything the Map layout
 * consumes (ids, kinds, phases, edge topology) and nothing it ignores
 * (counts / `live`). Two models with the same key produce the same geometry,
 * so the layout is memoised on it — `pipeline_counts` churn never re-runs it.
 */
export function layoutKey(model: AtlasModel): string {
  const wfs = model.workflows
    .map((w) => `${w.id}:${w.phase}:${w.stepIds.join(">")}`)
    .join("|");
  const steps = model.steps.map((s) => `${s.id}=${s.kind}`).join(",");
  const edges = model.edges
    .map((e) => `${e.kind}:${e.from}->${e.to}:${e.label ?? ""}`)
    .join(";");
  // Route-decision labels reserve space in the layout, so they key it too.
  const forwardLabels = Object.entries(model.forwardLabels ?? {})
    .map(([key, label]) => `${key}=${label}`)
    .sort()
    .join(";");
  return `${wfs}#${steps}#${edges}#${forwardLabels}`;
}

export function WorkflowAtlas() {
  const projectGeneration = useProjectScopeGeneration();
  const { summary, isLoading, error } = usePipelineSummary();
  useAtlasLayoutWarmup(summary);

  const [view, setView] = useState<AtlasView>("graph");
  const factoryFilter = useFactoryFilterStore((state) => state.factoryName);
  const setFactoryFilter = useFactoryFilterStore(
    (state) => state.setFactoryName
  );
  const lastFactory = useFactoryFilterStore((state) => state.lastFactoryName);
  const scopeKey = JSON.stringify([projectGeneration, factoryFilter]);
  const cameras = useMemo(
    () => new Map<string, { current: PanZoomTransform | null }>(),
    [projectGeneration]
  );
  const graphCamera = useMemo(() => {
    const saved = cameras.get(scopeKey) ?? { current: null };
    cameras.set(scopeKey, saved);
    return saved;
  }, [cameras, scopeKey]);
  // Factory search and workflow search have separate meanings. Restore each
  // scope's query on return instead of applying one scope's text to another.
  const [queries, setQueries] = useState<Record<string, string>>({});
  const query = queries[scopeKey] ?? "";
  const setQuery = (text: string) =>
    setQueries((current) => ({ ...current, [scopeKey]: text }));
  const changeScope = useCallback(
    (scope: FactoryFilterValue) => setFactoryFilter(scope),
    [setFactoryFilter]
  );
  const [hover, setHover] = useState<string | null>(null);
  // Edge-hover is written by the inspector in the global entity host. Keeping
  // it in the shared UI store lets the inspector move out of this component
  // without losing the canvas highlight interaction.
  const hoverEdge = useEntityPanelStore((state) => state.hoveredEdgeId);
  const entitySelection = useEntityPanelStore((state) => state.selection);

  const showFactoryOverview = summary !== null && factoryFilter === null;
  const isBoard = view === "board";
  const isGraph = view === "graph";
  // The factory overview only knows Graph and Map; Board stands in for Map.
  const overviewView = isGraph ? "graph" : "map";

  // The board needs a factory scope. Clearing the scope while on Board returns
  // to the factory overview, which has no Board option.
  useEffect(() => {
    if (showFactoryOverview && isBoard) setView("map");
  }, [showFactoryOverview, isBoard]);

  // Keep the topology input scoped before deriving the Atlas model. This makes
  // the same literal factory comparison govern both Graph and Map layouts.
  const scopedSummary = useMemo(() => {
    if (!summary || factoryFilter === null) return summary;
    return {
      ...summary,
      workflows: filterByFactory(summary.workflows, factoryFilter),
    };
  }, [summary, factoryFilter]);

  // If a realtime update removes the selected factory from the project, return
  // to the unscoped topology instead of leaving a value with no option.
  useEffect(() => {
    if (
      factoryFilter !== null &&
      summary &&
      !factoryScopeExists(summary.workflows, factoryFilter)
    ) {
      setFactoryFilter(null);
    }
  }, [factoryFilter, setFactoryFilter, summary]);

  // Route configs label the edges leaving route steps with their decisions.
  // PipelineSummary carries no step config, so read the scoped route steps
  // through the shared per-step cache (realtime step updates refresh them).
  const routeStepIds = useMemo(
    () =>
      (scopedSummary?.workflows ?? []).flatMap((workflow) =>
        workflow.workflow_steps
          .filter((step) => step.step_type === "route")
          .map((step) => step.id)
      ),
    [scopedSummary]
  );
  const routeSteps = useSteps(routeStepIds);
  const routeConfigsKey = JSON.stringify(
    routeSteps.map((step) =>
      step?.step_type === "route"
        ? ((step.config as RouteStepConfig | null)?.route_config ?? null)
        : null
    )
  );
  const routeConfigs = useMemo(() => {
    const configs = JSON.parse(routeConfigsKey) as (JsonValue | null)[];
    return new Map(routeStepIds.map((id, index) => [id, configs[index]]));
  }, [routeConfigsKey, routeStepIds]);

  // The global entity selection is also the canvas highlight. The global host
  // renders the inspector; this component only projects the same selection onto
  // the atlas so the page cannot mount a second detail surface.
  const model = useMemo(
    () =>
      !showFactoryOverview && scopedSummary
        ? buildAtlasModel(scopedSummary, routeConfigs)
        : null,
    [scopedSummary, showFactoryOverview, routeConfigs]
  );

  // A selection from another factory should not remain open beside a scoped
  // canvas. The global host owns the panel, so close through the shared store.
  useEffect(() => {
    if (!entitySelection || entitySelection.type === "task") return;
    const workflows = showFactoryOverview
      ? summary?.workflows
      : model?.workflows;
    if (!workflows) return;
    const workflowId = entitySelection.workflowId;
    if (
      workflowId &&
      !workflows.some((workflow) => workflow.id === workflowId)
    ) {
      useEntityPanelStore.getState().close();
    }
  }, [entitySelection, model, showFactoryOverview, summary]);

  const openWorkflow = (workflowId: string) =>
    useEntityPanelStore.getState().openWorkflow(workflowId);

  // The shared machine Graph hosts the factory scope; the overview hosts both
  // of its own views. The Map canvas below is the scoped Map.
  const machineGraph = isGraph && factoryFilter !== null;
  const showMap = view === "map" && !showFactoryOverview;

  const key = useMemo(() => (model ? layoutKey(model) : ""), [model]);

  // Condensed map layout — pure + synchronous, memoised on the structural key
  // (the model identity is stable for a given key, so this never thrashes on
  // counts).
  const cond = useMemo<CondensedLayout | null>(
    () => (model && key !== "" ? layoutCondensed(model, COND_OPTS) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  const canvasRef = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(
    canvasRef,
    { w: cond?.width ?? 0, h: cond?.height ?? 0 },
    { min: 0.12, max: 2.4, enabled: showMap }
  );
  const fitMap = pz.fit;

  // Reframe the Map whenever it is entered or its scope changes. The Map canvas
  // mounts on entry, so the fit waits a tick for its board to have a size.
  useEffect(() => {
    if (!showMap) return;
    const timer = setTimeout(fitMap, MAP_FIT_DELAY);
    return () => clearTimeout(timer);
  }, [showMap, fitMap, projectGeneration, factoryFilter]);

  const mapRectById = useMemo(() => {
    const m = new Map<string, CondensedLayout["nodes"][number]>();
    cond?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [cond]);

  // Ordered step kinds per workflow (drives the map-face StepStrip).
  const mapShapeById = useMemo(() => {
    const m = new Map<string, Kind[]>();
    if (model) {
      for (const w of model.workflows) {
        m.set(
          w.id,
          w.stepIds
            .map((sid) => model.steps.find((s) => s.id === `${w.id}.${sid}`))
            .filter((s): s is NonNullable<typeof s> => !!s)
            .map((s) => s.kind)
        );
      }
    }
    return m;
  }, [model]);

  // ── HOVER-TRACE: the connected set of the hovered workflow across the
  // aggregated map edges. null ⇒ no workflow hovered.
  const connected = useMemo<Set<string> | null>(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    cond?.edges.forEach((e) => {
      if (e.from === hover) set.add(e.to);
      if (e.to === hover) set.add(e.from);
    });
    return set;
  }, [hover, cond]);

  // Search composes UNDER the trace: a query dims non-matching cards; an active
  // trace overrides resting/search state with lit/dim.
  const q = query.trim().toLowerCase();
  const matches = (id: string): boolean => {
    if (!q) return true;
    const wf = model?.workflows.find((w) => w.id === id);
    return !!wf && wf.name.toLowerCase().includes(q);
  };

  // ── EDGE-HOVER: hovering a transition row in the inspector lights the
  // aggregated map edge for that workflow pair and dims the rest. A loop-back
  // has no map edge, so it's inert.
  const hoveredEdge = useMemo(
    () =>
      hoverEdge && model
        ? (model.edges.find((e) => e.id === hoverEdge) ?? null)
        : null,
    [hoverEdge, model]
  );
  const activeHoverEdge =
    hoveredEdge && hoveredEdge.fromWorkflow !== hoveredEdge.toWorkflow
      ? hoveredEdge
      : null;
  const hoverEndpoints = activeHoverEdge
    ? new Set([activeHoverEdge.fromWorkflow, activeHoverEdge.toWorkflow])
    : null;
  const inspectedWorkflow =
    entitySelection?.type === "workflow" ? entitySelection.workflowId : null;

  /** Visual state of a workflow card. */
  const wfState = (id: string): WfBoxState => {
    if (hoverEndpoints) return hoverEndpoints.has(id) ? "lit" : "dim";
    if (connected) return connected.has(id) ? "lit" : "dim";
    if (q) return matches(id) ? "lit" : "dim";
    return "";
  };

  /** Visual state of a map edge — edge-hover, then trace, then search. */
  const condEdgeState = (from: string, to: string): TraceState => {
    if (activeHoverEdge)
      return from === activeHoverEdge.fromWorkflow &&
        to === activeHoverEdge.toWorkflow
        ? "lit"
        : "dim";
    if (connected) return from === hover || to === hover ? "lit" : "dim";
    if (q) return matches(from) && matches(to) ? "" : "dim";
    return "";
  };

  // A handoff is a "return" edge when its target card sits above its source.
  // Lit return edges render white (vs accent forward), so tracing a hub
  // separates work flowing onward from paths returning back.
  const crossIsBack = (from: string, to: string): boolean => {
    const a = mapRectById.get(from);
    const b = mapRectById.get(to);
    if (!a || !b) return false;
    return b.y + b.h / 2 < a.y + a.h / 2 - 4;
  };

  // The workflow the canvas is "focused" on for edge DIRECTION: an inspected
  // workflow whose transition row is hovered (so panel and canvas agree),
  // otherwise the hover-traced workflow.
  const focusWorkflowId: string | null =
    activeHoverEdge && inspectedWorkflow ? inspectedWorkflow : hover;

  // A lit handoff is coloured by its direction relative to the focused
  // workflow — routes IN read white (return), routes OUT read accent (forward)
  // — so the canvas agrees with the inspector's in/out coding. With nothing
  // focused it falls back to geometric up/down detection. `back` is inert
  // unless the edge is also lit (see `.gedge.lit.back`).
  const edgeBack = (fromWorkflow: string, toWorkflow: string): boolean => {
    if (focusWorkflowId) {
      if (toWorkflow === focusWorkflowId) return true; // route IN → white
      if (fromWorkflow === focusWorkflowId) return false; // route OUT → accent
    }
    return crossIsBack(fromWorkflow, toWorkflow);
  };

  // A workflow trace softens the dim and quiets lit handoffs; inspector
  // edge-hover keeps the full contrast.
  const traceClass = !activeHoverEdge && connected ? " trace-wf" : "";

  const mapReady = showMap && !!cond && !!model;
  const empty =
    !showFactoryOverview &&
    !isBoard &&
    !!summary &&
    model !== null &&
    model.workflows.length === 0;

  // z-sort: lit edges paint LAST so they read over the dimmed field. Stable sort
  // keeps resting order otherwise.
  const litLast = (s: TraceState): number => (s === "lit" ? 1 : 0);

  return (
    <main className="uv-main">
      <header className="uv-head">
        <div className="uv-name">
          {factoryFilter !== null ? (
            <nav className="crumb uv-crumb" aria-label="Breadcrumb">
              <button
                type="button"
                className="uv-crumb-back"
                onClick={() => changeScope(null)}
              >
                Factories
              </button>
              <span aria-hidden="true">/</span>
              <span className="uv-crumb-current" aria-current="page">
                {isNoFactoryScope(factoryFilter) ? "No Factory" : factoryFilter}
              </span>
            </nav>
          ) : (
            !showFactoryOverview && (
              <div className="crumb">design · workflow topology · elk</div>
            )
          )}
          <h1>
            Workflow{" "}
            <em>
              {showFactoryOverview
                ? "Factories"
                : isBoard
                  ? "Board"
                  : isGraph
                    ? "Graph"
                    : "Atlas"}
            </em>
          </h1>
        </div>
        <div className="uv-controls">
          {/* Search fills the toolbar in the topology views (the board has its
              own task search); the view toggle sits at the end. */}
          <div className="uv-search">
            {!isBoard && (
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder={
                  showFactoryOverview ? "Find a factory…" : "Find a workflow…"
                }
                hint="/"
              />
            )}
          </div>
          <FactoryFilter
            id="atlas-factory-filter"
            workflows={summary?.workflows ?? []}
            value={factoryFilter}
            onChange={changeScope}
          />
          <SegmentedControl<AtlasView>
            ariaLabel="Workflow view"
            options={
              showFactoryOverview
                ? TOPOLOGY_VIEW_OPTIONS
                : [...TOPOLOGY_VIEW_OPTIONS, BOARD_VIEW_OPTION]
            }
            value={view}
            onChange={setView}
          />
        </div>
      </header>

      <div className="uv-canvas" ref={canvasRef}>
        {(isLoading || (showMap && !mapReady && !empty && !error)) && (
          <div className="uv-loading">
            <div className="sp" />
            {isBoard
              ? "loading workflows…"
              : `laying out workflow ${isGraph ? "graph" : "map"}…`}
          </div>
        )}

        {error && <div className="uv-empty">{error}</div>}

        {empty && !error && (
          <div className="uv-empty">no workflows to graph</div>
        )}

        {showFactoryOverview && !isLoading && !error && summary && (
          <FactoryOverview
            key={projectGeneration}
            routeConfigs={routeConfigs}
            scope={JSON.stringify([projectGeneration, null])}
            summary={summary}
            query={query}
            view={overviewView}
            recentFactory={lastFactory}
            onSelect={changeScope}
          />
        )}

        {machineGraph && scopedSummary && !isLoading && !error && !empty && (
          <ScopedMachineGraph
            key={JSON.stringify([projectGeneration, factoryFilter])}
            cameraSnapshot={graphCamera}
            summary={scopedSummary}
            routeConfigs={routeConfigs}
            scope={JSON.stringify([projectGeneration, factoryFilter])}
            query={query}
          />
        )}

        {isBoard && factoryFilter !== null && (
          <div className="uv-kanban" data-no-pan>
            <KanbanBoard factoryName={factoryFilter} />
          </div>
        )}

        {mapReady && cond && model && (
          <div className="uv-scaler" style={{ transform: pz.transform }}>
            <div
              className={"uv-board" + traceClass}
              style={{ width: cond.width, height: cond.height }}
            >
              {/* ── phase-column headers ─────────────────────────────── */}
              <div className="uv-layer">
                {cond.columns.map((col) => {
                  const first = mapRectById.get(col.members[0]);
                  if (!first) return null;
                  return (
                    <ColumnHeader
                      key={col.index}
                      column={col}
                      left={first.x}
                      width={first.w}
                    />
                  );
                })}
              </div>

              {/* ── aggregated workflow→workflow handoffs ────────────── */}
              <svg
                className="al-edges uv-layer"
                width={cond.width}
                height={cond.height}
                viewBox={`0 0 ${cond.width} ${cond.height}`}
              >
                <GraphMarkers />
                {cond.edges
                  .slice()
                  .sort(
                    (a, b) =>
                      litLast(condEdgeState(a.from, a.to)) -
                      litLast(condEdgeState(b.from, b.to))
                  )
                  .map((e) => (
                    <GraphEdge
                      key={e.id}
                      kind="handoff"
                      state={condEdgeState(e.from, e.to)}
                      back={edgeBack(e.from, e.to)}
                      d={roundedPath(e.points, 9)}
                    />
                  ))}
              </svg>

              {/* ── workflow cards ───────────────────────────────────── */}
              {model.workflows.map((w) => {
                const rect = mapRectById.get(w.id);
                if (!rect) return null;
                return (
                  <WfBox
                    key={w.id}
                    workflow={w}
                    rect={rect}
                    shape={mapShapeById.get(w.id) ?? []}
                    stepCount={w.stepIds.length}
                    state={wfState(w.id)}
                    onHover={setHover}
                    onSelect={openWorkflow}
                  />
                );
              })}

              {/* ── condition chips on the handoffs ──────────────────── */}
              {cond.edges.map((e) => {
                if (!e.labelPos || e.labels.length === 0) return null;
                return (
                  <EdgeLabel
                    key={`cc-${e.id}`}
                    labels={e.labels}
                    left={e.labelPos.x}
                    top={e.labelPos.y}
                    state={condEdgeState(e.from, e.to)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {mapReady && (
          <ZoomWidget
            onZoomIn={pz.zoomIn}
            onZoomOut={pz.zoomOut}
            onFit={pz.fit}
          />
        )}

        {/* Run Console — docked over the canvas so it persists across view
            changes. Reads the live task list; its surfaces carry `data-no-pan`
            so dragging them never pans the world. */}
        <RunConsole summary={scopedSummary} factoryName={factoryFilter} />
      </div>

      {showMap && <KindLegend />}

      {/* The global entity host renders the one workflow/step inspector. */}
    </main>
  );
}
