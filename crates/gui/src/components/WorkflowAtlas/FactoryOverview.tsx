import { useMemo } from "react";
import type { PipelineSummary } from "../../bindings";
import type { FactoryFilterValue } from "../../utils/workflowFactory";
import { EdgeLabel } from "./EdgeLabel";
import { GraphEdge } from "./GraphEdge";
import { GraphMarkers } from "./GraphMarkers";
import { WfBox, type WfBoxView } from "./WfBox";
import { buildAtlasModel } from "./adapter/buildAtlasModel";
import {
  buildFactoryOverviewGroups,
  layoutFactoryOverview,
} from "./factoryOverviewModel";
import { roundedPath } from "./layout/geometry";

interface FactoryOverviewProps {
  summary: PipelineSummary;
  query: string;
  view: WfBoxView;
  onSelect: (factoryName: FactoryFilterValue) => void;
}

/**
 * Factory-level Atlas. Factory containers provide the scope boundary, while
 * their children and routes use the same custom workflow/edge primitives as
 * the selected-factory Graph and Map views.
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
  const layout = useMemo(
    () => layoutFactoryOverview(model, groups),
    [groups, model]
  );

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
          className="factory-overview-canvas"
          style={{ width: layout.width, height: layout.height }}
        >
          <div className="factory-overview-factories">
            {layout.factories.map((factory) => (
              <div
                key={factory.name}
                className="factory-overview-factory"
                data-no-pan
                data-testid={`factory-node-${factory.name}`}
                role="button"
                tabIndex={0}
                aria-label={`Factory ${factory.name}`}
                style={{
                  left: factory.rect.x,
                  top: factory.rect.y,
                  width: factory.rect.w,
                  height: factory.rect.h,
                }}
                onClick={() => onSelect(factory.scope)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(factory.scope);
                  }
                }}
              >
                <span className="factory-overview-label">
                  {factory.name === "No Factory" ? "Scope" : "Factory"}
                </span>
                <strong className="factory-overview-name">
                  {factory.name}
                </strong>
                <span className="factory-overview-meta">
                  {factory.workflowCount} workflow
                  {factory.workflowCount === 1 ? "" : "s"}
                  {factory.workItemCount > 0
                    ? ` · ${factory.workItemCount} work item${factory.workItemCount === 1 ? "" : "s"}`
                    : ""}
                </span>
                {factory.activeCount > 0 && (
                  <span className="factory-overview-active">
                    {factory.activeCount} active
                  </span>
                )}
              </div>
            ))}
          </div>

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
                <GraphEdge kind="handoff" d={roundedPath(route.points, 10)} />
              </g>
            ))}
            {layout.workflowRoutes.map((route) => (
              <g key={route.id} data-testid={route.id}>
                <GraphEdge
                  kind="handoff"
                  solid
                  d={roundedPath(route.points, 8)}
                />
              </g>
            ))}
          </svg>

          {layout.factories.flatMap((factory) =>
            factory.workflows.map(({ workflow, rect, shape }) => (
              <WfBox
                key={workflow.id}
                workflow={workflow}
                rect={rect}
                shape={shape}
                stepCount={workflow.stepIds.length}
                view={view}
                onSelect={() => onSelect(factory.scope)}
              />
            ))
          )}

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
      ) : (
        <div className="factory-overview-empty">
          {normalizedQuery
            ? "No factories match the search"
            : "No factories configured"}
        </div>
      )}
    </div>
  );
}
