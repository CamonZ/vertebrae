import { useMemo, useState } from "react";
import { useRunTrace } from "../../../hooks";
import type { LocalChatRunRow } from "../../../utils/localChatSessionGroups";
import { formatRelative } from "../../../utils/formatRelative";
import { isActiveRunStatus } from "../../../utils/runState";

interface RunHistoryRowProps {
  row: LocalChatRunRow;
  isActive: boolean;
  onSelect: (row: LocalChatRunRow) => void;
  onSelectStep: (row: LocalChatRunRow, executionId: string) => void;
}

function age(updatedAt: string): string {
  const relative = formatRelative(updatedAt);
  return relative === "Just now" ? "now" : relative.replace(/ ago$/, "");
}

/** A TaskRun row in the chat history panel, with a lazy step outline. */
export function RunHistoryRow({
  row,
  isActive,
  onSelect,
  onSelectStep,
}: RunHistoryRowProps) {
  const { run } = row;
  const shortId = run.id.slice(0, 8);
  const title = `${row.label} ${shortId}`;
  const working = isActiveRunStatus(run.status);

  return (
    <>
      <div
        className="hc-mini-history-row"
        data-kind="run"
        data-run-id={run.id}
        data-active={isActive || undefined}
        data-completed={row.completed || undefined}
        data-activity={working ? "thinking" : undefined}
      >
        <div className="hc-mini-history-entry">
          <button
            type="button"
            className="hc-mini-history-open"
            onClick={() => onSelect(row)}
            title={`Open run ${run.id}`}
            aria-label={`Load run ${title} into active pane`}
            aria-current={isActive ? "true" : undefined}
          >
            <span className="label">{row.label}</span>
          </button>
          <div className="hc-mini-history-secondary">
            <div className="hc-mini-history-row-actions">
              <span
                className="hc-mini-history-run-status"
                data-status={run.status}
                title={`Run ${run.status}`}
              >
                {run.status}
              </span>
              <span className="meta" title={run.id}>
                {shortId}
              </span>
            </div>
            <time
              className="meta"
              dateTime={row.updatedAt}
              title={row.updatedAt}
            >
              {age(row.updatedAt)}
            </time>
          </div>
        </div>
      </div>
      <RunSteps row={row} title={title} onSelectStep={onSelectStep} />
    </>
  );
}

function RunSteps({
  row,
  title,
  onSelectStep,
}: {
  row: LocalChatRunRow;
  title: string;
  onSelectStep: RunHistoryRowProps["onSelectStep"];
}) {
  const [expanded, setExpanded] = useState(false);
  const rowsId = `run-steps-${encodeURIComponent(row.id)}`;

  return (
    <div className="hc-mini-history-agents">
      <button
        type="button"
        className="hc-mini-history-agents-toggle hc-mini-history-toggle"
        data-mini-history-toggle
        aria-label={`Steps for ${title}`}
        aria-expanded={expanded}
        aria-controls={rowsId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span>Steps</span>
      </button>
      <div id={rowsId} hidden={!expanded}>
        {expanded && <RunStepRows row={row} onSelectStep={onSelectStep} />}
      </div>
    </div>
  );
}

/** Mounted only when expanded: loads the run's executions without logs. */
function RunStepRows({
  row,
  onSelectStep,
}: {
  row: LocalChatRunRow;
  onSelectStep: RunHistoryRowProps["onSelectStep"];
}) {
  const { stepExecutions, isLoading, error } = useRunTrace(row.taskId, row.id, {
    includeExecutionLogs: false,
  });
  const ordered = useMemo(
    () =>
      [...stepExecutions].sort((a, b) =>
        (a.started_at ?? "").localeCompare(b.started_at ?? "")
      ),
    [stepExecutions]
  );

  if (error) return <span className="meta">{error}</span>;
  if (isLoading && ordered.length === 0)
    return <span className="meta">Loading steps…</span>;
  if (ordered.length === 0) return <span className="meta">No steps yet</span>;

  return ordered.map((execution, index) => (
    <button
      key={execution.id ?? index}
      type="button"
      className="hc-mini-history-agent"
      style={{ paddingLeft: "12px" }}
      data-working={execution.completed_at ? undefined : true}
      disabled={!execution.id}
      onClick={() => execution.id && onSelectStep(row, execution.id)}
      title={`Jump to step ${execution.step_name ?? index + 1}`}
      aria-label={`Jump to step ${execution.step_name ?? index + 1} in run ${row.id.slice(0, 8)}`}
    >
      <span className="label">
        {execution.step_name ?? `Step ${index + 1}`}
      </span>
      {execution.step_type && (
        <span className="meta">{execution.step_type}</span>
      )}
    </button>
  ));
}
