import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PipelineSummary } from "../../bindings";
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

export const FACTORY_EXPAND_SCALE = 1.6;

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

interface FactoryOverviewProps {
  summary: PipelineSummary;
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
export function FactoryOverview({
  summary,
  query,
  view,
  recentFactory = null,
  onSelect,
}: FactoryOverviewProps) {
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
  const workflowView: WfBoxView = view === "graph" && full ? "graph" : "map";
  const activeWidth =
    workflowView === "graph" ? (full?.width ?? 0) : cond.width;
  const activeHeight =
    workflowView === "graph" ? (full?.height ?? 0) : cond.height;
  const activeRects = useMemo(
    () => (workflowView === "graph" ? graphRects(full) : mapRects(cond)),
    [cond, full, workflowView]
  );
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
  const pz = usePanZoom(
    stageRef,
    { w: layout?.width ?? 0, h: layout?.height ?? 0 },
    {
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
    if (!expanded || full) return;
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
  }, [expanded, full, model]);

  // If ELK replaces the temporary Map geometry before the user takes over the
  // camera, reframe once around the actual Graph world. Manual pan/zoom is
  // preserved.
  const { fit, userControlled } = pz;
  useEffect(() => {
    if (full && !userControlled) fit();
  }, [fit, full, userControlled]);

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

  if (layoutError) {
    return <div className="factory-overview-empty">{layoutError}</div>;
  }

  return (
    <div className="factory-overview" data-testid="factory-overview">
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

                  {workflowView === "map" && (
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

                    {model.workflows.map((workflow) => {
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

                    {workflowView === "map" &&
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
                      <span className="factory-overview-region-name">
                        {region.name}
                      </span>
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
