import { useEffect, useMemo, useRef, useState } from "react";
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
  Rect,
} from "./layout/types";
import {
  buildFactoryOverviewGroups,
  layoutFactoryOverview,
  NO_FACTORY_KEY,
} from "./factoryOverviewModel";
import { roundedPath } from "./layout/geometry";
import { ZoomWidget } from "./ZoomWidget";

export const FACTORY_EXPAND_SCALE = 1.6;

const FULL_OPTS = { headH: 118, stepW: 150, stepH: 90 } as const;
const COND_OPTS = { boxW: 264, boxH: 140 } as const;

interface FactoryOverviewProps {
  summary: PipelineSummary;
  query: string;
  view: WfBoxView;
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
  onSelect,
}: FactoryOverviewProps) {
  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      buildFactoryOverviewGroups(summary).filter(
        (group) =>
          normalizedQuery === "" ||
          group.name.toLowerCase().includes(normalizedQuery)
      ),
    [normalizedQuery, summary]
  );

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

  const stageRef = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(
    stageRef,
    { w: layout?.width ?? 0, h: layout?.height ?? 0 },
    { min: 0.12, max: 2.4 }
  );

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
      <div className="factory-overview-heading">
        <span className="factory-overview-eyebrow">Factory scope</span>
        <span className="factory-overview-hint">
          Zoom in to inspect the workflows in place
        </span>
      </div>
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
                  <div className="uv-layer factory-overview-map-columns">
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
                    {full.cross.map((edge) => (
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
                    className="factory-overview-region"
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

              <svg
                className={
                  "factory-overview-factory-edges" +
                  (expanded ? " is-hidden" : " is-visible")
                }
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                aria-hidden={expanded}
              >
                <GraphMarkers />
                {layout.factoryRoutes.map((route) => (
                  <g key={route.id} data-testid={route.id}>
                    <GraphEdge
                      kind="handoff"
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
                {layout.factories.map((factory) => (
                  <WfBox
                    key={factory.name}
                    variant="factory"
                    factory={{
                      id:
                        typeof factory.scope === "string"
                          ? factory.scope
                          : NO_FACTORY_KEY,
                      name: factory.name,
                      workflowCount: factory.workflowCount,
                      workItemCount: factory.workItemCount,
                      activeCount: factory.activeCount,
                    }}
                    rect={factory.rect}
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
                {layout.factoryRoutes.map((route) => {
                  if (route.count < 2) return null;
                  const point = route.points[0];
                  return (
                    <EdgeLabel
                      key={`${route.id}-count`}
                      labels={[`${route.count} routes`]}
                      left={point.x}
                      top={point.y}
                    />
                  );
                })}
              </div>
            </div>
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
  );
}
