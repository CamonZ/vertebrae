/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — the canonical workflow-topology surface
   (P4 GRAPH + P5 MAP + P6 MORPH + P7 HOVER-TRACE).

   Pipeline data → adapter → two layouts → a custom DOM+SVG canvas inside a
   pan/zoom world:

     GRAPH view (P4)  — `layoutFull`: nested workflow containers, ELK-positioned
                        step nodes, routed handoff / step / loop edges.
     MAP view (P5)    — `layoutCondensed`: deterministic value-stream phase
                        columns, condensed workflow cards (step-count + live
                        ember only), aggregated workflow→workflow edges with
                        condition chips, plus a step-grouping control and a
                        lit/dim workflow search.

   THE MORPH (P6) — both layouts are held in state at once. The Map⇄Graph
   SegmentedControl flips `view`; each workflow box is ONE persistent element
   whose left/top/width/height CSS-transition (~0.66s) between its graph-rect and
   its map-rect, while the view chrome (step nodes, edges, labels, columns,
   chips) crossfades (~0.28s). A `morphing` flag hides all chrome and disables
   pointer events for the duration so ONLY the boxes choreograph; the camera
   glides to reframe via a `setTimeout`→`fit` (rAF is paused in background
   frames). The board is sized to `max(full, cond)` so neither layout clips
   mid-flight. Pan/zoom persists across the toggle (the hook is never remounted).

   HOVER-TRACE (P7) — hovering (or, later, selecting) a workflow lights its
   connected set and dims the rest. The connected set is computed per view:
   graph cross-edges vs. condensed map edges. High-degree hub edges (e.g. Human
   Review) stay hidden at rest and only appear when tracing one of their
   endpoints. Lit edges are z-sorted last so they paint over the dimmed ones.
   Search and trace compose: a query dims non-matches; a trace overrides with
   lit/dim within (or across) the matches.

   Re-layout discipline (plan risk #5): the ELK graph layout is async and
   expensive, so it is memoised on a STRUCTURAL key (workflow/step ids + kinds +
   phases + edge topology). The condensed map layout is pure + synchronous and is
   memoised on the same key. Live `pipeline_counts` change the `live` ember and
   re-render chrome only — they never re-trigger a layout.

   Ported from docs/design/workflow-views.jsx (UnifiedViews).
   ────────────────────────────────────────────────────────────────── */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SearchInput } from "../molecules/SearchInput";
import { SegmentedControl } from "../molecules/SegmentedControl";
import { FactoryFilter } from "../FactoryFilter";
import {
  factoryScopeExists,
  filterByFactory,
} from "../../utils/workflowFactory";
import { usePipelineSummary } from "../../hooks/usePipelineSummary";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import type { AtlasSelection } from "./inspector/selection";
import { ColumnHeader } from "./ColumnHeader";
import { EdgeLabel } from "./EdgeLabel";
import { GraphEdge } from "./GraphEdge";
import { GraphMarkers } from "./GraphMarkers";
import { KindLegend } from "./KindLegend";
import { FactoryOverview } from "./FactoryOverview";
import { RunConsole } from "./RunConsole";
import { StepNodeGeo } from "./StepNodeGeo";
import { WfBox, type WfBoxState } from "./WfBox";
import { ZoomWidget } from "./ZoomWidget";
import { buildAtlasModel } from "./adapter/buildAtlasModel";
import { selectionFromWorkflowTarget } from "./inspector/selection";
import { usePanZoom } from "./hooks/usePanZoom";
import { useFactoryFilterStore } from "../../stores/factoryFilterStore";
import { roundedPath } from "./layout/geometry";
import { layoutCondensed } from "./layout/layoutCondensed";
import { layoutFull } from "./layout/layoutFull";
import type {
  AtlasModel,
  CondensedLayout,
  FullLayout,
  Kind,
  PlacedEdge,
  Rect,
} from "./layout/types";
import "./WorkflowAtlas.css";

const FULL_OPTS = { headH: 118, stepW: 150, stepH: 90 } as const;
const COND_OPTS = { boxW: 264, boxH: 140 } as const;

/** Camera-glide schedule for the morph (matches the 0.66s box transition). */
const MORPH_FIT_DELAY = 30;
const MORPH_END = 800;

export type AtlasView = "graph" | "map";

/** Trace/search visual state applied to a box, edge, or step. */
type TraceState = "" | "lit" | "dim";

/**
 * Structural fingerprint of an `AtlasModel`: everything the layouts consume
 * (ids, kinds, phases, edge topology) and nothing they ignore (counts / `live`).
 * Two models with the same key produce the same geometry, so layouts are
 * memoised on it — `pipeline_counts` churn never re-runs them.
 */
export function layoutKey(model: AtlasModel): string {
  const wfs = model.workflows
    .map((w) => `${w.id}:${w.phase}:${w.stepIds.join(">")}`)
    .join("|");
  const steps = model.steps.map((s) => `${s.id}=${s.kind}`).join(",");
  const edges = model.edges
    .map((e) => `${e.kind}:${e.from}->${e.to}`)
    .join(";");
  return `${wfs}#${steps}#${edges}`;
}

export function WorkflowAtlas() {
  const { summary, isLoading, error } = usePipelineSummary();

  const [view, setView] = useState<AtlasView>("graph");
  const factoryFilter = useFactoryFilterStore((state) => state.factoryName);
  const setFactoryFilter = useFactoryFilterStore(
    (state) => state.setFactoryName
  );
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  // Step-node hover: the ref of the step node under the cursor (graph view).
  // Its owning workflow drives `hover` (so the box stays traced while the cursor
  // sits over a step that paints above it), and this id emphasises that one node.
  const [hoverStep, setHoverStep] = useState<string | null>(null);
  // Edge-hover is written by the inspector in the global entity host. Keeping
  // it in the shared UI store lets the inspector move out of this component
  // without losing the canvas highlight interaction.
  const hoverEdge = useEntityPanelStore((state) => state.hoveredEdgeId);
  const [morphing, setMorphing] = useState(false);
  const entitySelection = useEntityPanelStore((state) => state.selection);

  const showFactoryOverview = summary !== null && factoryFilter === null;

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

  // The global entity selection is also the canvas highlight. The global host
  // renders the inspector; this component only projects the same selection onto
  // the atlas so the page cannot mount a second detail surface.
  const model = useMemo(
    () =>
      !showFactoryOverview && scopedSummary
        ? buildAtlasModel(scopedSummary)
        : null,
    [scopedSummary, showFactoryOverview]
  );

  // A selection from another factory should not remain open beside a scoped
  // canvas. The global host owns the panel, so close through the shared store.
  useEffect(() => {
    if (showFactoryOverview && entitySelection?.type !== "task") {
      if (entitySelection) useEntityPanelStore.getState().close();
      return;
    }
    if (!model || !entitySelection || entitySelection.type === "task") return;
    const workflowId = entitySelection.workflowId;
    if (
      workflowId &&
      !model.workflows.some((workflow) => workflow.id === workflowId)
    ) {
      useEntityPanelStore.getState().close();
    }
  }, [entitySelection, model, showFactoryOverview]);

  const sel = useMemo<AtlasSelection | null>(() => {
    if (!model || !entitySelection || entitySelection.type === "task") {
      return null;
    }
    return selectionFromWorkflowTarget(model, entitySelection);
  }, [entitySelection, model]);
  const setSel = (selection: AtlasSelection | null) => {
    const store = useEntityPanelStore.getState();
    if (!selection) {
      store.close();
    } else if (selection.type === "workflow") {
      store.openWorkflow(selection.workflowId);
    } else {
      store.openStep(selection.stepId, selection.workflowId);
    }
  };

  const isGraph = view === "graph";

  const key = useMemo(() => (model ? layoutKey(model) : ""), [model]);

  // Per-step task counts (total parked + running), keyed by step ref. Lives off
  // the model (not the layout) so it tracks live count churn without re-laying.
  const stepCountById = useMemo(() => {
    const m = new Map<string, { total: number; running: number }>();
    model?.steps.forEach((s) =>
      m.set(s.id, { total: s.total, running: s.running })
    );
    return m;
  }, [model]);

  // Async ELK graph layout, memoised on the structural key. The effect runs on
  // `key` alone (so counts churn never re-lays out); it reads the latest `model`
  // through a ref, and `keyRef` guards a stale async result from clobbering a
  // newer one (key changed mid-flight).
  const [full, setFull] = useState<FullLayout | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    const currentModel = modelRef.current;
    if (!currentModel || key === "") {
      setFull(null);
      return;
    }
    let cancelled = false;
    setLayoutError(null);
    layoutFull(currentModel, FULL_OPTS)
      .then((result) => {
        if (cancelled || keyRef.current !== key) return;
        setFull(result);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLayoutError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Condensed map layout — pure + synchronous, memoised on the same key (the
  // model identity is stable for a given key, so this never thrashes on counts).
  const cond = useMemo<CondensedLayout | null>(
    () => (model && key !== "" ? layoutCondensed(model, COND_OPTS) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  // ── Camera: fits whichever layout is active. The board is sized to the union
  // of both layouts so neither clips during the morph; the camera reframes the
  // ACTIVE layout's content box on each view change.
  const canvasRef = useRef<HTMLDivElement>(null);
  const dims = useMemo(() => {
    if (isGraph) return { w: full?.width ?? 0, h: full?.height ?? 0 };
    return { w: cond?.width ?? 0, h: cond?.height ?? 0 };
  }, [isGraph, full, cond]);
  const pz = usePanZoom(canvasRef, dims, { min: 0.12, max: 2.4 });
  const pzRef = useRef(pz);
  pzRef.current = pz;

  // ── THE MORPH (P6): on every view change after the first, arm the `morphing`
  // flag (which hides chrome + freezes pointer events), then glide the camera to
  // the new layout via setTimeout (NOT rAF — rAF is paused in background tabs).
  // The flag clears once the box transition has landed.
  const firstView = useRef(true);
  useLayoutEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    setMorphing(true); // arm the transition first…
    const tFit = setTimeout(() => pzRef.current.fit(), MORPH_FIT_DELAY); // …then move
    const tEnd = setTimeout(() => setMorphing(false), MORPH_END);
    return () => {
      clearTimeout(tFit);
      clearTimeout(tEnd);
    };
  }, [view]);

  // Flatten intra (forward + loop) edges with their owning workflow id.
  const intra = useMemo(
    () =>
      full
        ? full.workflows.flatMap((w) =>
            w.intra.map((e) => ({ ...e, wf: w.id }))
          )
        : [],
    [full]
  );

  // Per-workflow placement lookups for each view (the persistent box reads its
  // rect for the active view from these every render → CSS transitions the move).
  const graphRectById = useMemo(() => {
    const m = new Map<string, Rect>();
    full?.workflows.forEach((w) =>
      m.set(w.id, { x: w.x, y: w.y, w: w.w, h: w.h })
    );
    return m;
  }, [full]);

  const mapRectById = useMemo(() => {
    const m = new Map<string, Rect>();
    cond?.nodes.forEach((n) => m.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h }));
    return m;
  }, [cond]);

  const condNodeById = useMemo(() => {
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

  // ── HOVER-TRACE (P7): the connected set of the hovered workflow, computed per
  // view. Graph traces cross-workflow handoffs; map traces aggregated map edges.
  // null ⇒ nothing hovered (no trace active).
  const connected = useMemo<Set<string> | null>(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    if (isGraph) {
      full?.cross.forEach((e) => {
        if (e.fromWorkflow === hover) set.add(e.toWorkflow);
        if (e.toWorkflow === hover) set.add(e.fromWorkflow);
      });
    } else {
      cond?.edges.forEach((e) => {
        if (e.from === hover) set.add(e.to);
        if (e.to === hover) set.add(e.from);
      });
    }
    return set;
  }, [hover, isGraph, full, cond]);

  // Search composes UNDER the trace: a query dims non-matching cards; an active
  // trace overrides resting/search state with lit/dim.
  const q = query.trim().toLowerCase();
  const matches = (id: string): boolean => {
    if (!q) return true;
    const wf = model?.workflows.find((w) => w.id === id);
    return !!wf && wf.name.toLowerCase().includes(q);
  };

  // ── EDGE-HOVER: hovering a transition row in the inspector lights that one
  // edge in the canvas. We resolve the hovered model edge, then in the active
  // view light only it (graph matches by step-ref endpoints; map by the
  // aggregated workflow pair) and dim the rest. A loop-back has no map edge, so
  // it's inert in map view.
  const hoveredEdge = useMemo(
    () =>
      hoverEdge && model
        ? (model.edges.find((e) => e.id === hoverEdge) ?? null)
        : null,
    [hoverEdge, model]
  );
  const activeHoverEdge =
    hoveredEdge &&
    (isGraph || hoveredEdge.fromWorkflow !== hoveredEdge.toWorkflow)
      ? hoveredEdge
      : null;
  const hoverEndpoints = activeHoverEdge
    ? new Set([activeHoverEdge.fromWorkflow, activeHoverEdge.toWorkflow])
    : null;

  /** Visual state of a workflow box / its step nodes. */
  const wfState = (id: string): WfBoxState => {
    if (hoverEndpoints) return hoverEndpoints.has(id) ? "lit" : "dim";
    if (connected) return connected.has(id) ? "lit" : "dim";
    if (q) return matches(id) ? "lit" : "dim";
    return "";
  };

  /** Visual state of a graph cross-edge — edge-hover first (a single edge by its
   *  step-ref endpoints), then the workflow hover-trace, then search. */
  const crossEdgeState = (e: PlacedEdge): TraceState => {
    if (activeHoverEdge) {
      return e.from === activeHoverEdge.from && e.to === activeHoverEdge.to
        ? "lit"
        : "dim";
    }
    if (connected)
      return e.fromWorkflow === hover || e.toWorkflow === hover ? "lit" : "dim";
    if (q) return matches(e.fromWorkflow) && matches(e.toWorkflow) ? "" : "dim";
    return "";
  };

  /** Visual state of a graph loop-back edge — edge-hover first, then trace, then
   *  search (a loop belongs to a single workflow). */
  const loopEdgeState = (e: PlacedEdge & { wf: string }): TraceState => {
    if (activeHoverEdge) {
      return e.from === activeHoverEdge.from && e.to === activeHoverEdge.to
        ? "lit"
        : "dim";
    }
    if (connected) return hover === e.wf ? "lit" : "dim";
    if (q) return matches(e.wf) ? "" : "dim";
    return "";
  };

  /** Visual state of a condensed map edge — edge-hover, then trace, then search. */
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

  // During a morph, strip all connective tissue so ONLY the boxes choreograph;
  // edges / step-nodes / labels / columns re-attach once the boxes have landed.
  const showGraphChrome = isGraph && !morphing;
  const showMapChrome = !isGraph && !morphing;

  // Shared world box: the union of both layouts, so neither clips while a box
  // travels from one layout's rect to the other's.
  const board = {
    w: Math.max(full?.width ?? 0, cond?.width ?? 0),
    h: Math.max(full?.height ?? 0, cond?.height ?? 0),
  };

  /** The active-view rect for a workflow box (the persistent traveling element). */
  const rectOf = (id: string): Rect | null =>
    (isGraph ? graphRectById.get(id) : mapRectById.get(id)) ?? null;

  // A cross-workflow handoff is a "return" edge when its target workflow sits
  // above its source in the laid-out DAG — i.e. flow heads back up against the
  // downward progression. Lit return edges render white (vs accent forward), so
  // tracing a hub separates work flowing onward from paths returning back.
  const crossIsBack = (from: string, to: string): boolean => {
    const a = rectOf(from);
    const b = rectOf(to);
    if (!a || !b) return false;
    return b.y + b.h / 2 < a.y + a.h / 2 - 4;
  };

  // The single workflow the canvas is "focused" on for edge DIRECTION. One
  // resolved value feeds both views: an inspected workflow whose transition row
  // is hovered takes precedence (so panel and canvas agree), otherwise the
  // hover-traced workflow — a box hover, or a step hover (which resolves to its
  // workflow via `hover`). null ⇒ nothing focused.
  const focusWorkflowId: string | null =
    activeHoverEdge && sel?.type === "workflow" ? sel.workflowId : hover;

  // A lit cross/handoff edge is coloured by its direction relative to the focused
  // workflow — routes IN read white (return), routes OUT read accent (forward) —
  // so the canvas agrees with the inspector's in/out coding. With nothing focused
  // it falls back to geometric up/down detection. `back` is inert unless the edge
  // is also lit (see `.gedge.lit.back`), so resting/dimmed edges are unaffected
  // regardless of which branch they take. Graph cross-edges and map condensed
  // edges are both keyed by workflow id, so one helper serves both views.
  const edgeBack = (fromWorkflow: string, toWorkflow: string): boolean => {
    if (focusWorkflowId) {
      if (toWorkflow === focusWorkflowId) return true; // route IN → white
      if (fromWorkflow === focusWorkflowId) return false; // route OUT → accent
    }
    return crossIsBack(fromWorkflow, toWorkflow);
  };

  const ready =
    showFactoryOverview || (isGraph ? !!full && !!model : !!cond && !!model);
  const empty =
    !showFactoryOverview &&
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
          <div className="crumb">design · workflow topology · elk</div>
          <h1>
            Workflow <em>{isGraph ? "Graph" : "Atlas"}</em>
          </h1>
        </div>
        <div className="uv-controls">
          {/* Search fills the toolbar in both views; the view toggle sits at the end. */}
          <div className="uv-search">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={
                showFactoryOverview ? "Find a factory…" : "Find a workflow…"
              }
              hint="/"
            />
          </div>
          <FactoryFilter
            id="atlas-factory-filter"
            workflows={summary?.workflows ?? []}
            value={factoryFilter}
            onChange={setFactoryFilter}
          />
          <SegmentedControl<AtlasView>
            ariaLabel="Workflow view"
            options={[
              { value: "map", label: "Map" },
              { value: "graph", label: "Graph" },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </header>

      <div className="uv-canvas" ref={canvasRef}>
        {(isLoading || (!ready && !empty && !error && !layoutError)) && (
          <div className="uv-loading">
            <div className="sp" />
            laying out workflow {isGraph ? "graph" : "map"}…
          </div>
        )}

        {(error || layoutError) && (
          <div className="uv-empty">{error ?? layoutError}</div>
        )}

        {empty && !error && (
          <div className="uv-empty">no workflows to graph</div>
        )}

        {showFactoryOverview &&
          !isLoading &&
          !error &&
          !layoutError &&
          summary && (
            <FactoryOverview
              summary={summary}
              query={query}
              onSelect={setFactoryFilter}
            />
          )}

        {!showFactoryOverview && ready && (
          <div
            className={"uv-scaler" + (morphing ? " morphing" : "")}
            style={{ transform: pz.transform }}
          >
            <div
              className="uv-board"
              style={{ width: board.w, height: board.h }}
            >
              {/* ── MAP chrome: phase-column headers ─────────────────── */}
              {cond && (
                <div className={"uv-layer" + (showMapChrome ? "" : " hide")}>
                  {cond.columns.map((col) => {
                    const first = condNodeById.get(col.members[0]);
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
              )}

              {/* ── MAP chrome: aggregated workflow→workflow handoffs ─── */}
              {cond && (
                <svg
                  className={
                    "al-edges uv-layer" + (showMapChrome ? "" : " hide")
                  }
                  width={board.w}
                  height={board.h}
                  viewBox={`0 0 ${board.w} ${board.h}`}
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
              )}

              {/* ── GRAPH chrome: cross + forward step edges ──────────── */}
              {full && (
                <svg
                  className={
                    "ag-edges uv-layer" + (showGraphChrome ? "" : " hide")
                  }
                  width={board.w}
                  height={board.h}
                  viewBox={`0 0 ${board.w} ${board.h}`}
                >
                  <GraphMarkers />
                  {full.cross
                    .slice()
                    .sort(
                      (a, b) =>
                        litLast(crossEdgeState(a)) - litLast(crossEdgeState(b))
                    )
                    .map((e) => {
                      const st = crossEdgeState(e);
                      // hub overlay edges stay hidden at rest and only appear
                      // when you trace one of their endpoints (P7) or hover the
                      // matching transition row in the inspector.
                      if (e.hub && st !== "lit") return null;
                      return (
                        <GraphEdge
                          key={e.id}
                          kind="handoff"
                          state={st}
                          back={edgeBack(e.fromWorkflow, e.toWorkflow)}
                          d={roundedPath(e.points, 10)}
                        />
                      );
                    })}
                  {intra
                    .filter((e) => e.kind === "forward")
                    .map((e) => (
                      <GraphEdge
                        key={e.id}
                        kind="step"
                        state={wfState(e.wf) === "dim" ? "dim" : ""}
                        d={roundedPath(e.points, 6)}
                      />
                    ))}
                </svg>
              )}

              {/* ── GRAPH chrome: step nodes (above the boxes) ────────── */}
              {full && (
                <div
                  className={
                    "uv-layer uv-steplayer" + (showGraphChrome ? "" : " hide")
                  }
                >
                  {full.workflows.map((w) => {
                    const st = wfState(w.id);
                    return w.steps.map((s) => {
                      const c = stepCountById.get(s.id);
                      return (
                        <StepNodeGeo
                          key={s.id}
                          step={s}
                          total={c?.total ?? 0}
                          running={c?.running ?? 0}
                          state={st}
                          hovered={hoverStep === s.id}
                          onSelect={(workflowId, stepId) =>
                            setSel({ type: "step", workflowId, stepId })
                          }
                          onHover={(node) => {
                            // Keep the box traced while the cursor is over a
                            // node painted above it, and flag the exact node.
                            setHover(node ? node.workflowId : null);
                            setHoverStep(node ? node.id : null);
                          }}
                        />
                      );
                    });
                  })}
                </div>
              )}

              {/* ── The traveling element: ONE persistent box per workflow.
                   Always mounted; its rect comes from the active view, so the
                   CSS left/top/width/height transition does the morph. ────── */}
              {model?.workflows.map((w) => {
                const rect = rectOf(w.id);
                if (!rect) return null;
                return (
                  <WfBox
                    key={w.id}
                    workflow={w}
                    rect={rect}
                    shape={mapShapeById.get(w.id) ?? []}
                    stepCount={w.stepIds.length}
                    view={view}
                    state={wfState(w.id)}
                    onHover={setHover}
                    onSelect={(id) =>
                      setSel({ type: "workflow", workflowId: id })
                    }
                  />
                );
              })}

              {/* ── GRAPH chrome: loop-backs (above the boxes) ────────── */}
              {full && (
                <svg
                  className={
                    "ag-edges-top uv-layer" + (showGraphChrome ? "" : " hide")
                  }
                  width={board.w}
                  height={board.h}
                  viewBox={`0 0 ${board.w} ${board.h}`}
                >
                  <GraphMarkers />
                  {intra
                    .filter((e) => e.kind === "loop")
                    .map((e) => {
                      const st = loopEdgeState(e);
                      return (
                        <GraphEdge
                          key={e.id}
                          kind="loop"
                          state={st}
                          back
                          d={roundedPath(e.points, 7)}
                        />
                      );
                    })}
                </svg>
              )}

              {/* ── MAP chrome: condition chips on the handoffs ───────── */}
              {showMapChrome &&
                cond?.edges.map((e) => {
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

        {!showFactoryOverview && ready && (
          <ZoomWidget
            onZoomIn={pz.zoomIn}
            onZoomOut={pz.zoomOut}
            onFit={pz.fit}
          />
        )}

        {/* Run Console — docked over the canvas, OUTSIDE the morph layers so it
            persists across the Map⇄Graph toggle. Reads the live task list; its
            surfaces carry `data-no-pan` so dragging them never pans the world. */}
        <RunConsole summary={scopedSummary} factoryName={factoryFilter} />
      </div>

      {!showFactoryOverview && <KindLegend />}

      {/* The global entity host renders the one workflow/step inspector. */}
    </main>
  );
}
