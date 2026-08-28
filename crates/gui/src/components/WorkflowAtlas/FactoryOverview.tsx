import { useMemo } from "react";
import type { PipelineSummary } from "../../bindings";
import type { FactoryFilterValue } from "../../utils/workflowFactory";
import { EdgeLabel } from "./EdgeLabel";
import { GraphEdge } from "./GraphEdge";
import { GraphMarkers } from "./GraphMarkers";
import { WfBox } from "./WfBox";
import { buildAtlasModel } from "./adapter/buildAtlasModel";
import {
  buildFactoryOverviewGroups,
  layoutFactoryOverview,
  NO_FACTORY_KEY,
} from "./factoryOverviewModel";
import { roundedPath } from "./layout/geometry";

interface FactoryOverviewProps {
  summary: PipelineSummary;
  query: string;
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
          </svg>

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
