import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { JsonValue, PipelineSummary } from "../../bindings";
import {
  NO_FACTORY_SCOPE,
  type FactoryFilterValue,
} from "../../utils/workflowFactory";
import { ColumnHeader } from "./ColumnHeader";
import { EdgeLabel } from "./EdgeLabel";
import { GraphEdge } from "./GraphEdge";
import { GraphMarkers } from "./GraphMarkers";
import { StepNodeGeo } from "./StepNodeGeo";
import { WfBox, type WfBoxView } from "./WfBox";
import { buildAtlasModel } from "./adapter/buildAtlasModel";
import { usePanZoom } from "./hooks/usePanZoom";
import { layoutCondensed } from "./layout/layoutCondensed";
import { layoutFull } from "./layout/layoutFull";
import type {
  AtlasModel,
  CondensedLayout,
  FullLayout,
  Point,
  Rect,
} from "./layout/types";
import {
  buildFactoryOverviewGroups,
  factoryGroupKey,
  factoryLinkCounts,
  factoryScopeKey,
  layoutFactoryOverview,
  routePoints,
  separateRects,
} from "./factoryOverviewModel";
import { FactoryIndex } from "./FactoryIndex";
import { roundedPath, routeFromSourcePort } from "./layout/geometry";
import { ZoomWidget } from "./ZoomWidget";

import { useAtlasMachineFlow } from "./adapter/useAtlasMachineFlow";
import { AtlasMachineScene } from "./adapter/AtlasMachineScene";
import type { DiagramTimeline } from "../MachineDiagram/flow/compile";

export const FACTORY_EXPAND_SCALE = 1.6;
// Shared parts use a 640×400 logical catalogue frame. Project that scene into
// Atlas world units without changing any compiled positions or route metadata.
const MACHINE_WORLD_SCALE = 0.32;

/**
 * Factory markers are drawn in screen space so they stay legible at any zoom.
 * Their fixed size also gives the factory routes exact endpoints.
 */
const MARKER_W = 212;
const MARKER_H = 30;
const MARKER_GAP = 6;
/** Fitting frames the markers, never zooming far enough to expand regions. */
const MARKER_FIT_PAD = MARKER_W + 64;
const MARKER_FIT_MAX = 1;

type HighlightState = "" | "lit" | "dim";

const FULL_OPTS = { headH: 118 } as const;
const COND_OPTS = { boxW: 264, boxH: 140 } as const;
// A disabled overview has no detailed topology. Switching to this stable empty
// input retires the shared hook's pending result without starting another worker.
const EMPTY_MACHINE_SUMMARY: PipelineSummary = { workflows: [] };

interface FactoryOverviewProps {
  summary: PipelineSummary;
  machineGraph?: boolean;
  scope?: string;
  routeConfigs?: ReadonlyMap<string, JsonValue | null>;
  query: string;
  view: WfBoxView;
  /** The factory the user last opened; marked and focused in the index. */
  recentFactory?: FactoryFilterValue;
  onSelect: (factoryName: FactoryFilterValue) => void;
}

function workflowScope(factoryName: string | null): FactoryFilterValue {
  return factoryName === null ? NO_FACTORY_SCOPE : factoryName;
}

function graphRects(full: FullLayout | null): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  full?.workflows.forEach((workflow) =>
    rects.set(workflow.id, {
      x: workflow.x,
      y: workflow.y,
      w: workflow.w,
      h: workflow.h,
    })
  );
  return rects;
}

function mapRects(cond: CondensedLayout | null): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  cond?.nodes.forEach((node) =>
    rects.set(node.id, { x: node.x, y: node.y, w: node.w, h: node.h })
  );
  return rects;
}

function stepShape(
  model: AtlasModel
): Map<string, AtlasModel["steps"][number]["kind"][]> {
  const shapes = new Map<string, AtlasModel["steps"][number]["kind"][]>();
  for (const workflow of model.workflows) {
    shapes.set(
      workflow.id,
      workflow.stepIds
        .map((stepId) =>
          model.steps.find(
            (step) => step.workflowId === workflow.id && step.stepId === stepId
          )
        )
        .filter((step): step is NonNullable<typeof step> => !!step)
        .map((step) => step.kind)
    );
  }
  return shapes;
}

/**
 * The factory overview is the normal workflow canvas with a second semantic
 * layer on top. It never lays out workflows inside factory nodes: the selected
 * Graph or Map layout remains the world, while factories switch between a
 * dashed grouping region and an opaque summary node at the zoom threshold.
 */
export function FactoryOverview(props: FactoryOverviewProps) {
  const [attempt, setAttempt] = useState(0);
  return props.machineGraph ? (
    <SharedFactoryOverview
      key={attempt}
      {...props}
      retry={() => setAttempt((n) => n + 1)}
    />
  ) : (
    <FactoryOverviewCanvas {...props} />
  );
}

function SharedFactoryOverview(
  props: FactoryOverviewProps & { retry: () => void }
) {
  const summary = useMemo(() => {
    const query = props.query.trim().toLowerCase();
    if (!query) return props.summary;
    const ids = new Set(
      buildFactoryOverviewGroups(props.summary)
        .filter((group) => group.name.toLowerCase().includes(query))
        .flatMap((group) => group.workflowIds)
    );
    return {
      ...props.summary,
      workflows: props.summary.workflows.filter((w) => ids.has(w.id)),
    };
  }, [props.summary, props.query]);
  const model = useAtlasMachineFlow(
    props.view === "graph" ? summary : EMPTY_MACHINE_SUMMARY,
    props.routeConfigs,
    props.scope
  );
  const state = model.layout;
  const diagram =
    state.status === "done" && state.result.ok
      ? state.result.flow.arrangements[0]
      : null;
  return (
    <FactoryOverviewCanvas
      {...props}
      shared={
        props.view === "graph"
          ? { model, diagram, retry: props.retry }
          : undefined
      }
    />
  );
}

type SharedOverview = {
  model: ReturnType<typeof useAtlasMachineFlow>;
  diagram: DiagramTimeline | null;
  retry: () => void;
};

function FactoryOverviewCanvas({
  summary,
  query,
  view,
  recentFactory = null,
  onSelect,
  shared,
}: FactoryOverviewProps & { shared?: SharedOverview }) {
  const normalizedQuery = query.trim().toLowerCase();
  const allGroups = useMemo(
    () => buildFactoryOverviewGroups(summary),
    [summary]
  );
  const groups = useMemo(
    () =>
      allGroups.filter(
        (group) =>
          normalizedQuery === "" ||
          group.name.toLowerCase().includes(normalizedQuery)
      ),
    [allGroups, normalizedQuery]
  );
  // One highlight shared by the index and the map, so hovering either side
  // points at the same factory on the other.
  const [hotKey, setHotKey] = useState<string | null>(null);
  const recentKey = useMemo(() => {
    const key = factoryScopeKey(recentFactory);
    return key !== null &&
      groups.some((group) => factoryGroupKey(group) === key)
      ? key
      : null;
  }, [groups, recentFactory]);

  // Search is a factory search in the unscoped view. Keep the same exact set of
  // workflow records in the canvas model so a matching factory does not leave
  // unrelated workflows floating outside its grouping region.
  const overviewSummary = useMemo(() => {
    if (!normalizedQuery) return summary;
    const visibleIds = new Set(groups.flatMap((group) => group.workflowIds));
    return {
      ...summary,
      workflows: summary.workflows.filter((workflow) =>
        visibleIds.has(workflow.id)
      ),
    };
  }, [groups, normalizedQuery, summary]);
  const model = useMemo(
    () => buildAtlasModel(overviewSummary),
    [overviewSummary]
  );

  const [fullState, setFullState] = useState<{
    model: AtlasModel;
    layout: FullLayout;
  } | null>(null);
  const full = fullState?.model === model ? fullState.layout : null;
  const [workflowTitlePorts, setWorkflowTitlePorts] = useState<
    Record<string, Point>
  >({});
  const reportWorkflowTitlePort = useCallback(
    (workflowId: string, point: Point) => {
      setWorkflowTitlePorts((current) => {
        const previous = current[workflowId];
        if (
          previous &&
          Math.abs(previous.x - point.x) < 0.5 &&
          Math.abs(previous.y - point.y) < 0.5
        ) {
          return current;
        }
        return { ...current, [workflowId]: point };
      });
    },
    []
  );
  const graphCross = useMemo(
    () =>
      (full?.cross ?? []).map((edge) => {
        const titlePort = workflowTitlePorts[edge.fromWorkflow];
        return titlePort
          ? { ...edge, points: routeFromSourcePort(edge.points, titlePort) }
          : edge;
      }),
    [full, workflowTitlePorts]
  );
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const cond = useMemo(() => layoutCondensed(model, COND_OPTS), [model]);
  // The condensed geometry is a useful temporary world while ELK resolves in
  // Graph mode. It also means opaque factory summaries appear immediately.
  const workflowView: WfBoxView =
    view === "graph" && (shared?.diagram || full) ? "graph" : "map";
  const activeWidth =
    workflowView === "graph"
      ? shared?.diagram
        ? shared.diagram.width * MACHINE_WORLD_SCALE
        : (full?.width ?? 0)
      : cond.width;
  const activeHeight =
    workflowView === "graph"
      ? shared?.diagram
        ? shared.diagram.height * MACHINE_WORLD_SCALE
        : (full?.height ?? 0)
      : cond.height;
  const activeRects = useMemo(() => {
    if (shared?.diagram) {
      const rects = new Map<string, Rect>();
      for (const region of shared.diagram.regions) {
        const selection = shared.model.selections.get(region.id);
        if (selection?.type === "workflow")
          rects.set(selection.workflowId, {
            x: region.x * MACHINE_WORLD_SCALE,
            y: region.y * MACHINE_WORLD_SCALE,
            w: region.width * MACHINE_WORLD_SCALE,
            h: region.height * MACHINE_WORLD_SCALE,
          });
      }
      return rects;
    }
    return workflowView === "graph" ? graphRects(full) : mapRects(cond);
  }, [cond, full, workflowView, shared]);
  const layout = useMemo(
    () =>
      activeWidth > 0 && activeHeight > 0
        ? layoutFactoryOverview(
            model,
            groups,
            activeRects,
            activeWidth,
            activeHeight
          )
        : null,
    [activeHeight, activeRects, activeWidth, groups, model]
  );

  // Frame the factory markers rather than the whole workflow world. The world
  // holds every workflow's footprint; fitting all of it squeezes the markers
  // into a cramped cluster surrounded by empty canvas.
  const markerBounds = useMemo(() => {
    if (!layout || layout.factories.length === 0) return null;
    const rects = layout.factories.map((factory) => factory.rect);
    const x = Math.min(...rects.map((rect) => rect.x));
    const y = Math.min(...rects.map((rect) => rect.y));
    return {
      x,
      y,
      w: Math.max(...rects.map((rect) => rect.x + rect.w)) - x,
      h: Math.max(...rects.map((rect) => rect.y + rect.h)) - y,
    };
  }, [layout]);

  const stageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const hidden = expanded
      ? ".factory-overview-factories"
      : ".factory-overview-workflows, .factory-overview-regions";
    const active = document.activeElement;
    if (
      active &&
      [...(stageRef.current?.querySelectorAll(hidden) ?? [])].some((layer) =>
        layer.contains(active)
      )
    )
      stageRef.current?.focus({ preventScroll: true });
  }, [expanded]);
  const pz = usePanZoom(
    stageRef,
    { w: layout?.width ?? 0, h: layout?.height ?? 0 },
    {
      enabled: groups.length > 0 && !!layout,
      min: 0.12,
      max: 2.4,
      pad: MARKER_FIT_PAD,
      fitBounds: markerBounds,
      fitMax: MARKER_FIT_MAX,
    }
  );

  // Markers and their routes live in screen space: project each factory's
  // world centre through the camera and give it a fixed on-screen size.
  const markers = useMemo(() => {
    const projected = (layout?.factories ?? []).map((factory) => {
      const cx = pz.x + (factory.rect.x + factory.rect.w / 2) * pz.scale;
      const cy = pz.y + (factory.rect.y + factory.rect.h / 2) * pz.scale;
      return {
        factory,
        key: factoryGroupKey(factory),
        rect: {
          x: cx - MARKER_W / 2,
          y: cy - MARKER_H / 2,
          w: MARKER_W,
          h: MARKER_H,
        },
      };
    });
    const separated = separateRects(
      projected.map((marker) => marker.rect),
      MARKER_GAP
    );
    return projected.map((marker, index) => ({
      ...marker,
      rect: separated[index],
    }));
  }, [layout, pz.scale, pz.x, pz.y]);
  const markerRoutes = useMemo(() => {
    const rects = new Map(markers.map((marker) => [marker.key, marker.rect]));
    return (layout?.factoryRoutes ?? []).flatMap((route) => {
      const from = rects.get(route.from);
      const to = rects.get(route.to);
      return from && to ? [{ ...route, points: routePoints(from, to) }] : [];
    });
  }, [layout, markers]);
  const linkCounts = useMemo(
    () => factoryLinkCounts(layout?.factoryRoutes ?? []),
    [layout]
  );
  const neighbours = useMemo(() => {
    const keys = new Set<string>();
    for (const route of layout?.factoryRoutes ?? []) {
      if (route.from === hotKey) keys.add(route.to);
      if (route.to === hotKey) keys.add(route.from);
    }
    return keys;
  }, [hotKey, layout]);
  // Highlighting keeps the hot factory and its neighbours at rest and quiets
  // everything else, rather than shouting about the hovered one.
  const markerState = (key: string): HighlightState =>
    hotKey === null
      ? ""
      : key === hotKey
        ? "lit"
        : neighbours.has(key)
          ? ""
          : "dim";
  const routeState = (route: { from: string; to: string }): HighlightState =>
    hotKey === null
      ? ""
      : route.from === hotKey || route.to === hotKey
        ? "lit"
        : "dim";

  useEffect(() => {
    const shouldExpand = pz.scale >= FACTORY_EXPAND_SCALE;
    setExpanded((current) =>
      current === shouldExpand ? current : shouldExpand
    );
  }, [pz.scale]);

  // ELK is only needed once the user has zoomed into the grouped surface. The
  // low-zoom factory view uses the synchronous Map geometry as an immediate
  // fallback, so the overview does not pay for a second hidden layout.
  useEffect(() => {
    if (shared || view !== "graph" || !expanded || full) return;
    let cancelled = false;
    setLayoutError(null);
    layoutFull(model, FULL_OPTS)
      .then((result) => {
        if (!cancelled) setFullState({ model, layout: result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLayoutError(
            error instanceof Error ? error.message : String(error)
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, full, model, shared, view]);

  // If ELK replaces the temporary Map geometry before the user takes over the
  // camera, reframe once around the actual Graph world. Manual pan/zoom is
  // preserved.
  const { fit, userControlled } = pz;
  const sharedDiagram = shared?.diagram;
  useEffect(() => {
    if ((full || sharedDiagram) && !userControlled) fit();
  }, [fit, full, sharedDiagram, userControlled]);

  const shapes = useMemo(() => stepShape(model), [model]);
  const stepCounts = useMemo(
    () =>
      new Map(
        model.steps.map((step) => [
          step.id,
          { total: step.total, running: step.running },
        ])
      ),
    [model]
  );
  const intra = full?.workflows.flatMap((workflow) => workflow.intra) ?? [];

  const sharedState = shared?.model.layout;
  if (layoutError) {
    return <div className="factory-overview-empty">{layoutError}</div>;
  }

  return (
    <div className="factory-overview" data-testid="factory-overview">
      {sharedState?.status === "pending" && (
        <div role="status" className="uv-loading">
          Laying out factories…
        </div>
      )}
      {sharedState?.status === "done" && !sharedState.result.ok && (
        <div role="alert" className="uv-empty">
          Unable to compile workflow graph:{" "}
          {sharedState.result.errors.map((e) => e.message).join("; ")}
        </div>
      )}
      {sharedState?.status === "done" && sharedState.fallbackError && (
        <div role="alert" className="uv-machine-warning">
          Automatic layout failed. Showing a simplified layout.{" "}
          {sharedState.fallbackError}{" "}
          <button data-no-pan onClick={shared?.retry}>
            Retry layout
          </button>
        </div>
      )}
      <FactoryIndex
        groups={groups}
        totalCount={allGroups.length}
        query={query}
        hotKey={hotKey}
        recentKey={recentKey}
        linkCounts={linkCounts}
        onHover={setHotKey}
        onSelect={onSelect}
      />
      <div className="factory-overview-map">
        {groups.length > 0 && layout ? (
          <div
            className="factory-overview-stage"
            data-testid="factory-overview-stage"
            ref={stageRef}
            tabIndex={-1}
          >
            <div
              className="factory-overview-scaler"
              style={{
                width: layout.width,
                height: layout.height,
                transform: pz.transform,
              }}
            >
              <div
                className="factory-overview-canvas"
                style={{ width: layout.width, height: layout.height }}
              >
                <div
                  className="factory-overview-world"
                  style={{
                    left: layout.offsetX,
                    top: layout.offsetY,
                    width: activeWidth,
                    height: activeHeight,
                  }}
                >
                  {view === "map" && (
                    <div
                      className={
                        "uv-layer factory-overview-map-columns" +
                        (expanded ? " is-visible" : " is-hidden")
                      }
                      aria-hidden={!expanded}
                    >
                      {cond.columns.map((column) => {
                        const first = cond.nodes.find(
                          (node) => node.id === column.members[0]
                        );
                        if (!first) return null;
                        return (
                          <ColumnHeader
                            key={column.index}
                            column={column}
                            left={first.x}
                            width={first.w}
                          />
                        );
                      })}
                    </div>
                  )}

                  {!shared && workflowView === "map" && (
                    <svg
                      className={
                        "factory-overview-workflow-edges al-edges" +
                        (expanded ? " is-visible" : " is-hidden")
                      }
                      width={activeWidth}
                      height={activeHeight}
                      viewBox={`0 0 ${activeWidth} ${activeHeight}`}
                      aria-hidden="true"
                    >
                      <GraphMarkers />
                      {cond.edges.map((edge) => (
                        <GraphEdge
                          key={edge.id}
                          kind="handoff"
                          d={roundedPath(edge.points, 9)}
                        />
                      ))}
                    </svg>
                  )}

                  {workflowView === "graph" && full && (
                    <svg
                      className={
                        "factory-overview-workflow-edges ag-edges" +
                        (expanded ? " is-visible" : " is-hidden")
                      }
                      width={activeWidth}
                      height={activeHeight}
                      viewBox={`0 0 ${activeWidth} ${activeHeight}`}
                      aria-hidden="true"
                    >
                      <GraphMarkers />
                      {graphCross.map((edge) => (
                        <GraphEdge
                          key={edge.id}
                          kind="handoff"
                          d={roundedPath(edge.points, 10)}
                        />
                      ))}
                      {intra.map((edge) => (
                        <GraphEdge
                          key={edge.id}
                          kind={edge.kind === "loop" ? "loop" : "step"}
                          d={roundedPath(edge.points, 7)}
                        />
                      ))}
                    </svg>
                  )}

                  {workflowView === "graph" &&
                    graphCross.map((edge) => {
                      if (!edge.labelPos || !edge.label) return null;
                      return (
                        <EdgeLabel
                          key={`graph-${edge.id}`}
                          labels={[edge.label]}
                          left={edge.labelPos.x}
                          top={edge.labelPos.y}
                          variant="graph"
                        />
                      );
                    })}

                  <div
                    inert={!expanded}
                    className={
                      "factory-overview-workflows" +
                      (expanded ? " is-expanded" : " is-collapsed")
                    }
                    aria-hidden={!expanded}
                  >
                    {workflowView === "graph" && full && (
                      <div className="uv-layer uv-steplayer">
                        {full.workflows.flatMap((workflow) =>
                          workflow.steps.map((step) => {
                            const counts = stepCounts.get(step.id);
                            return (
                              <StepNodeGeo
                                key={step.id}
                                step={step}
                                total={counts?.total ?? 0}
                                running={counts?.running ?? 0}
                              />
                            );
                          })
                        )}
                      </div>
                    )}

                    {shared?.diagram && (
                      <div
                        className="uv-machine-scene"
                        style={{
                          transform: `scale(${MACHINE_WORLD_SCALE})`,
                          transformOrigin: "0 0",
                        }}
                      >
                        <AtlasMachineScene
                          model={shared.model}
                          diagram={shared.diagram}
                          t={0}
                          label="Factory overview workflow graph"
                        />
                      </div>
                    )}
                    {!shared &&
                      model.workflows.map((workflow) => {
                        const rect = activeRects.get(workflow.id);
                        if (!rect) return null;
                        return (
                          <WfBox
                            key={workflow.id}
                            workflow={workflow}
                            rect={rect}
                            shape={shapes.get(workflow.id) ?? []}
                            stepCount={workflow.stepIds.length}
                            view={workflowView}
                            onTitlePort={reportWorkflowTitlePort}
                            onSelect={() =>
                              onSelect(workflowScope(workflow.factoryName))
                            }
                          />
                        );
                      })}

                    {!shared &&
                      workflowView === "map" &&
                      cond.edges.map((edge) => {
                        if (!edge.labelPos || edge.labels.length === 0)
                          return null;
                        return (
                          <EdgeLabel
                            key={`factory-overview-${edge.id}`}
                            labels={edge.labels}
                            left={edge.labelPos.x}
                            top={edge.labelPos.y}
                          />
                        );
                      })}
                  </div>
                </div>

                <div
                  className={
                    "factory-overview-regions" +
                    (expanded ? " is-visible" : " is-hidden")
                  }
                  aria-hidden={!expanded}
                  inert={!expanded}
                >
                  {layout.regions.map((region) => (
                    <div
                      key={region.name}
                      className={
                        "factory-overview-region" +
                        (factoryGroupKey(region) === hotKey ? " is-hot" : "")
                      }
                      data-testid={`factory-region-${region.name}`}
                      style={{
                        left: region.rect.x,
                        top: region.rect.y,
                        width: region.rect.w,
                        height: region.rect.h,
                      }}
                    >
                      {shared ? (
                        <button
                          type="button"
                          className="factory-overview-region-name factory-overview-region-enter"
                          aria-label={`Open factory ${region.name}`}
                          data-no-pan
                          onClick={() => onSelect(region.scope)}
                        >
                          {region.name} ↗
                        </button>
                      ) : (
                        <span className="factory-overview-region-name">
                          {region.name}
                        </span>
                      )}
                      <span className="factory-overview-region-meta">
                        {region.workflowCount} workflow
                        {region.workflowCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Screen-space overlay: factory markers and the routes between
              them keep a constant, legible size at any zoom. */}
            <svg
              className={
                "factory-overview-factory-edges" +
                (expanded ? " is-hidden" : " is-visible")
              }
              aria-hidden="true"
            >
              <GraphMarkers />
              {markerRoutes.map((route) => (
                <g key={route.id} data-testid={route.id}>
                  <GraphEdge
                    kind="handoff"
                    state={routeState(route)}
                    d={roundedPath(route.points, 10)}
                  />
                </g>
              ))}
            </svg>

            <div
              className={
                "factory-overview-factories" +
                (expanded ? " is-hidden" : " is-visible")
              }
              aria-hidden={expanded}
              inert={expanded}
            >
              {markers.map(({ factory, key, rect }) => (
                <WfBox
                  key={key}
                  variant="factory"
                  factory={{
                    id: key,
                    name: factory.name,
                    workflowCount: factory.workflowCount,
                    workItemCount: factory.workItemCount,
                    activeCount: factory.activeCount,
                  }}
                  rect={rect}
                  state={markerState(key)}
                  onHover={setHotKey}
                  onSelect={() => onSelect(factory.scope)}
                />
              ))}
            </div>

            <div
              className={
                "factory-overview-route-labels" +
                (expanded ? " is-hidden" : " is-visible")
              }
              aria-hidden={expanded}
            >
              {markerRoutes.map((route) => {
                if (route.count < 2) return null;
                const a = route.points[0];
                const b = route.points[route.points.length - 1];
                return (
                  <EdgeLabel
                    key={`${route.id}-count`}
                    labels={[`${route.count} routes`]}
                    left={(a.x + b.x) / 2}
                    top={(a.y + b.y) / 2}
                  />
                );
              })}
            </div>
          </div>
        ) : groups.length > 0 ? (
          <div className="factory-overview-empty">Laying out factories…</div>
        ) : (
          <div className="factory-overview-empty">
            {normalizedQuery
              ? "No factories match the search"
              : "No factories configured"}
          </div>
        )}
        {groups.length > 0 && layout ? (
          <ZoomWidget
            onZoomIn={pz.zoomIn}
            onZoomOut={pz.zoomOut}
            onFit={pz.fit}
          />
        ) : null}
      </div>
    </div>
  );
}
