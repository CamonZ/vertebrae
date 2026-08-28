import { useEffect, useMemo, useRef, useState } from "react";
import type { PipelineSummary } from "../../bindings";
import type { FactoryFilterValue } from "../../utils/workflowFactory";
import { EdgeLabel } from "./EdgeLabel";
import { GraphEdge } from "./GraphEdge";
import { GraphMarkers } from "./GraphMarkers";
import { WfBox, type WfBoxView } from "./WfBox";
import { buildAtlasModel } from "./adapter/buildAtlasModel";
import { usePanZoom } from "./hooks/usePanZoom";
import {
  buildFactoryOverviewGroups,
  layoutFactoryOverview,
  NO_FACTORY_KEY,
} from "./factoryOverviewModel";
import { roundedPath } from "./layout/geometry";
import { ZoomWidget } from "./ZoomWidget";

export const FACTORY_EXPAND_SCALE = 1.6;

interface FactoryOverviewProps {
  summary: PipelineSummary;
  query: string;
  view: WfBoxView;
  onSelect: (factoryName: FactoryFilterValue) => void;
}

/**
 * Factory-level Atlas. Factory nodes and their routes use the same custom node
 * and edge primitives as the selected-factory Graph and Map views, but the
 * factory node is deliberately opaque until it is selected.
 */
export function FactoryOverview({
  summary,
  query,
  view,
  onSelect,
}: FactoryOverviewProps) {
  const model = useMemo(() => buildAtlasModel(summary), [summary]);
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
  const collapsedLayout = useMemo(
    () => layoutFactoryOverview(model, groups),
    [groups, model]
  );
  const expandedLayout = useMemo(
    () => layoutFactoryOverview(model, groups, true),
    [groups, model]
  );
  const [expanded, setExpanded] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraContent = expanded ? expandedLayout : collapsedLayout;
  const pz = usePanZoom(
    stageRef,
    { w: cameraContent.width, h: cameraContent.height },
    { min: 0.12, max: 2.4 }
  );

  useEffect(() => {
    const shouldExpand = pz.userControlled && pz.scale >= FACTORY_EXPAND_SCALE;
    setExpanded((current) =>
      current === shouldExpand ? current : shouldExpand
    );
  }, [pz.scale, pz.userControlled]);

  const layout = expanded ? expandedLayout : collapsedLayout;

  return (
    <div className="factory-overview" data-testid="factory-overview">
      <div className="factory-overview-heading">
        <span className="factory-overview-eyebrow">Factory scope</span>
        <span className="factory-overview-hint">
          Select a factory to inspect its workflows
        </span>
      </div>
      {groups.length > 0 ? (
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
              <svg
                className="factory-overview-edges"
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                aria-hidden="true"
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

              {layout.factories.map((factory) => (
                <WfBox
                  key={factory.name}
                  variant="factory"
                  expanded={expanded}
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
                >
                  {expanded ? (
                    <>
                      <svg
                        className="factory-overview-inner-edges"
                        width={factory.rect.w}
                        height={factory.rect.h}
                        viewBox={`0 0 ${factory.rect.w} ${factory.rect.h}`}
                        aria-hidden="true"
                      >
                        <GraphMarkers />
                        {layout.workflowRoutes
                          .filter((route) =>
                            factory.workflowIds.includes(route.from)
                          )
                          .map((route) => (
                            <g key={route.id} data-testid={route.id}>
                              <GraphEdge
                                kind="handoff"
                                solid
                                d={roundedPath(route.points, 8)}
                              />
                            </g>
                          ))}
                      </svg>
                      {factory.workflows.map(({ workflow, rect, shape }) => (
                        <WfBox
                          key={workflow.id}
                          workflow={workflow}
                          rect={rect}
                          shape={shape}
                          stepCount={workflow.stepIds.length}
                          view={view}
                          onSelect={() => onSelect(factory.scope)}
                        />
                      ))}
                    </>
                  ) : null}
                </WfBox>
              ))}

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
      ) : (
        <div className="factory-overview-empty">
          {normalizedQuery
            ? "No factories match the search"
            : "No factories configured"}
        </div>
      )}
      {groups.length > 0 ? (
        <ZoomWidget
          onZoomIn={pz.zoomIn}
          onZoomOut={pz.zoomOut}
          onFit={pz.fit}
        />
      ) : null}
    </div>
  );
}
