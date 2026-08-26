import type { PipelineSummary } from "../../bindings";
import { buildFactoryOverviewGroups } from "./factoryOverviewModel";

interface FactoryOverviewProps {
  summary: PipelineSummary;
  query: string;
  onSelect: (factoryName: string) => void;
}

/** Black-box factory nodes shown before a factory scope is selected. */
export function FactoryOverview({
  summary,
  query,
  onSelect,
}: FactoryOverviewProps) {
  const normalizedQuery = query.trim().toLowerCase();
  const groups = buildFactoryOverviewGroups(summary).filter(
    (group) =>
      normalizedQuery === "" ||
      group.name.toLowerCase().includes(normalizedQuery)
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
        <div className="factory-overview-grid">
          {groups.map((group) => (
            <button
              key={group.name}
              type="button"
              className="factory-overview-box"
              data-no-pan
              data-testid={`factory-node-${group.name}`}
              aria-label={`Factory ${group.name}`}
              onClick={() => onSelect(group.name)}
            >
              <span className="factory-overview-label">Factory</span>
              <strong className="factory-overview-name">{group.name}</strong>
              <span className="factory-overview-meta">
                {group.workflowCount} workflow
                {group.workflowCount === 1 ? "" : "s"}
                {group.workItemCount > 0
                  ? ` · ${group.workItemCount} work item${group.workItemCount === 1 ? "" : "s"}`
                  : ""}
              </span>
              {group.activeCount > 0 && (
                <span className="factory-overview-active">
                  {group.activeCount} active
                </span>
              )}
            </button>
          ))}
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
