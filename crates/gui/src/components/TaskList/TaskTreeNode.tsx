import { memo, useCallback, useMemo } from "react";
import type { Task, TaskRun } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import type { useSummaryExpanded } from "../../hooks/useSummaryExpanded";
import { computeVisibleChildren } from "../../utils/computeVisibleChildren";
import { formatRelative } from "../../utils/formatRelative";
import { getPriorityIndicator } from "../../utils/taskPriority";
import { formatStepName } from "../../utils/formatStepName";
import {
  deriveHearthStateBreakdown,
  deriveRunStateChip,
  isActiveRunStatus,
} from "../../utils/runState";
import { Glyph, IdChip, RunChip } from "../shared/HearthPrimitives";

import { activeRunsFromTasks } from "../../hooks/useTaskRuns";

interface TaskTreeNodeProps {
  node: TaskTreeNodeType;
  depth: number;
  isSelected?: boolean;
  selectedTaskId?: string | null;
  onTaskSelect?: (task: Task) => void;
  expandedNodes?: ReturnType<typeof useExpandedNodes>;
  hideCompleted?: boolean;
  filtering?: boolean;
  summaryExpanded?: ReturnType<typeof useSummaryExpanded>;
  activeRunsByTaskId?: ReadonlyMap<string, TaskRun>;
}

/**
 * The row's status, one slot for every state the scope chips count: an active
 * run shows its Hearth run chip; otherwise a dependency-blocked task shows
 * "Blocked" and a completed task a quiet "Done". Idle, never-run tasks show
 * nothing. Terminal run history (stopped/failed) is not list state.
 */
function RowStatus({
  task,
  runChip,
}: {
  task: Task;
  runChip: ReturnType<typeof deriveRunStateChip>;
}) {
  if (runChip) {
    return (
      <RunChip
        status={runChip.status}
        label={runChip.label}
        small
        data-testid="task-tree-node-run-chip"
        data-run-status={runChip.status ?? undefined}
      />
    );
  }
  if (task.completed_at) {
    return (
      <span
        className="t-status done"
        aria-label="Completed"
        data-testid="task-tree-node-done-mark"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Done
      </span>
    );
  }
  if (task.run_controls?.disabled_reason_code === "blocked") {
    return (
      <span className="t-status blocked" data-testid="task-tree-node-blocked">
        Blocked
      </span>
    );
  }
  return null;
}

/**
 * Children progress for parents: a bar segmented by child state (done,
 * running, waiting, open) and "16 of 20 tickets done", with live counts
 * appended when children are running or waiting.
 */
function ChildProgress({
  breakdown,
  total,
  noun,
}: {
  breakdown: ReturnType<typeof deriveHearthStateBreakdown>;
  total: number;
  noun: string;
}) {
  const { done, running, waiting } = breakdown;
  const pct = (value: number) => `${(value / total) * 100}%`;
  return (
    <span
      className="t-progress"
      data-testid="task-tree-node-child-summary"
    >
      <span className="t-progress-bar" aria-hidden>
        <span className="seg done" style={{ width: pct(done) }} />
        <span className="seg running" style={{ width: pct(running) }} />
        <span className="seg waiting" style={{ width: pct(waiting) }} />
      </span>
      <span className="tabular-nums">
        {done} of {total} {noun} done
      </span>
      {running > 0 && (
        <span className="t-progress-live running tabular-nums">
          {" "}· {running} running
        </span>
      )}
      {waiting > 0 && (
        <span className="t-progress-live waiting tabular-nums">
          {" "}· {waiting} waiting
        </span>
      )}
    </span>
  );
}

/**
 * Collapsed-done summary row. Stands in for `count` folded done-leaf children
 * under an expanded parent. It is not a `treeitem` and is not selectable —
 * clicking it toggles the fold open/closed. Rendered at the same indent depth
 * as the leaves it replaces.
 */
export function SummaryRow({
  parentId,
  count,
  depth,
  open,
  onToggle,
}: {
  parentId: string;
  count: number;
  depth: number;
  open: boolean;
  onToggle: (parentId: string) => void;
}) {
  return (
    <div
      className={["t-summary", open ? "open" : ""].filter(Boolean).join(" ")}
      onClick={() => onToggle(parentId)}
      data-testid="task-tree-summary-row"
      data-parent-id={parentId}
      style={{ ["--depth" as string]: depth }}
    >
      <div className="t-indent" aria-hidden>
        {depth >= 1 ? <span className="g l1" /> : null}
        {depth >= 2 ? <span className="g l2" /> : null}
      </div>
      <span className="sum-chev">{open ? "▾" : "▸"}</span>
      <span className="sum-mark" aria-hidden>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <span className="sum-label">{count} completed</span>
      <span className="sum-hint">{open ? "hide" : "show"}</span>
    </div>
  );
}

/** Plural noun for this node's children, by the children's level. */
function childNoun(node: TaskTreeNodeType): string {
  const childLevel = node.children[0]?.task.level ?? null;
  const noun =
    childLevel === "epic"
      ? "epic"
      : childLevel === "ticket"
        ? "ticket"
        : childLevel === "task"
          ? "task"
          : "item";
  return node.children.length === 1 ? noun : `${noun}s`;
}

const MAX_TAGS = 3;

function levelClass(level: Task["level"]): "l0" | "l1" | "l2" {
  if (level === "epic") return "l0";
  if (level === "ticket") return "l1";
  return "l2";
}

function containsTask(
  node: TaskTreeNodeType,
  id: string | null | undefined
): boolean {
  return Boolean(
    id &&
    (node.task.id === id ||
      node.children.some((child) => containsTask(child, id)))
  );
}

function sameNodeProps(
  previous: TaskTreeNodeProps,
  next: TaskTreeNodeProps
): boolean {
  return (
    previous.node === next.node &&
    previous.depth === next.depth &&
    previous.onTaskSelect === next.onTaskSelect &&
    previous.expandedNodes === next.expandedNodes &&
    previous.hideCompleted === next.hideCompleted &&
    previous.filtering === next.filtering &&
    previous.summaryExpanded === next.summaryExpanded &&
    previous.activeRunsByTaskId === next.activeRunsByTaskId &&
    (previous.selectedTaskId === next.selectedTaskId ||
      (!containsTask(next.node, previous.selectedTaskId) &&
        !containsTask(next.node, next.selectedTaskId)))
  );
}

export const TaskTreeNode = memo(function TaskTreeNodeRow({
  node,
  depth,
  selectedTaskId,
  onTaskSelect,
  expandedNodes,
  hideCompleted = false,
  filtering = false,
  summaryExpanded,
  activeRunsByTaskId,
}: TaskTreeNodeProps) {
  const task = node.task;
  const hasChildren = node.children.length > 0;
  const isSelected = selectedTaskId === task.id;
  const isExpanded = expandedNodes
    ? expandedNodes.isNodeExpanded(task.id)
    : true;

  const handleSelect = useCallback(() => {
    onTaskSelect?.(task);
  }, [onTaskSelect, task]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onTaskSelect?.(task);
      }
    },
    [onTaskSelect, task]
  );

  const handleToggleExpand = useCallback(() => {
    expandedNodes?.toggleNode(task.id);
  }, [expandedNodes, task.id]);

  // Only priorities that ask for attention get a mark; medium/low stay quiet.
  const urgent =
    task.priority === "critical" || task.priority === "high";
  const priority = urgent
    ? {
        ...getPriorityIndicator(task.priority)!,
        short: task.priority === "critical" ? "Critical" : "High",
      }
    : null;
  // List tasks already carry run state. An unrelated task's run must not
  // invalidate this row through a newly allocated, list-wide map.
  const localRuns = useMemo(
    () =>
      activeRunsByTaskId ??
      activeRunsFromTasks([
        node.task,
        ...node.children.map((child) => child.task),
      ]),
    [activeRunsByTaskId, node]
  );
  const activeRun = localRuns.get(task.id) ?? null;
  const runChip = deriveRunStateChip(activeRun);
  const activeRunStatus = activeRun?.status ?? null;
  const tags = task.tags ?? [];
  const showProgress = hasChildren && task.level !== "task";
  // Step names are labels, shown only while a run is moving the task.
  const stepLabel =
    runChip?.isActive && task.step_name
      ? formatStepName(task.step_name, "")
      : null;
  const breakdown = useMemo(
    () =>
      deriveHearthStateBreakdown(
        node.children.map((child) => child.task),
        localRuns
      ),
    [localRuns, node.children]
  );
  const chevron = hasChildren ? (isExpanded ? "▾" : "▸") : "";

  const summaryExpandedIds = summaryExpanded?.summaryExpandedIds;
  const visibleChildren = useMemo(
    () =>
      computeVisibleChildren(node, {
        hideCompleted,
        filtering,
        summaryExpanded: summaryExpandedIds ?? new Set<string>(),
      }),
    [node, hideCompleted, filtering, summaryExpandedIds]
  );

  return (
    <div>
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isSelected || undefined}
        onClick={handleSelect}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        data-testid="task-tree-node-row"
        data-selected={isSelected || undefined}
        className={[
          "t-row",
          levelClass(task.level),
          isSelected ? "sel" : "",
          task.completed_at ? "completed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ ["--depth" as string]: depth }}
      >
        <div className="t-indent" aria-hidden>
          {depth >= 1 ? <span className="g l1" /> : null}
          {depth >= 2 ? <span className="g l2" /> : null}
        </div>
        <div className="t-body">
          <div className="t-top">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleExpand();
              }}
              aria-label={isExpanded ? "Collapse" : "Expand"}
              className="t-chev"
              tabIndex={-1}
            >
              {chevron}
            </button>
            <span
              className="t-glyph"
              data-testid="task-tree-node-level-glyph"
              data-level={task.level ?? undefined}
              data-accent={
                isSelected || isActiveRunStatus(activeRunStatus) || undefined
              }
            >
              <Glyph
                level={task.level}
                accent={isSelected || isActiveRunStatus(activeRunStatus)}
              />
            </span>
            <span
              className={["t-title", task.completed_at ? "done" : ""]
                .filter(Boolean)
                .join(" ")}
            >
              {task.title}
            </span>
          </div>
          <div className="t-meta">
            <IdChip
              id={task.id}
              kind="task"
              level={task.level}
              className="t-id"
              testId="task-tree-node-id"
            />
            {showProgress && (
              <ChildProgress
                breakdown={breakdown}
                total={node.children.length}
                noun={childNoun(node)}
              />
            )}
            {stepLabel && (
              <span className="t-step" data-testid="task-tree-node-step">
                {stepLabel}
              </span>
            )}
          </div>
        </div>
        <span className="t-tags">
          {tags.slice(0, MAX_TAGS).map((tag) => (
            <span
              key={tag}
              data-testid="task-tree-node-tag"
              className="tag"
            >
              {tag}
            </span>
          ))}
          {tags.length > MAX_TAGS && (
            <span className="tag-more" title={tags.slice(MAX_TAGS).join(", ")}>
              +{tags.length - MAX_TAGS}
            </span>
          )}
        </span>
        <span className="t-status-col">
          <RowStatus task={task} runChip={runChip} />
        </span>
        <span className="t-pri-col">
          {priority && (
            <span
              className={`t-pri ${task.priority ?? ""}`}
              title={priority.label}
              aria-label={priority.label}
              data-testid="task-tree-node-priority"
              data-priority={task.priority}
            >
              {priority.glyph} {priority.short}
            </span>
          )}
        </span>
        <span className="t-when">
          {task.updated_at ? formatRelative(task.updated_at) : null}
        </span>
      </div>

      {hasChildren && isExpanded && (
        <div role="group" aria-label={`Children of ${task.title}`}>
          {visibleChildren.map((child) =>
            child.kind === "node" ? (
              <TaskTreeNode
                key={child.node.task.id}
                node={child.node}
                depth={depth + 1}
                selectedTaskId={selectedTaskId}
                onTaskSelect={onTaskSelect}
                expandedNodes={expandedNodes}
                activeRunsByTaskId={activeRunsByTaskId}
                hideCompleted={hideCompleted}
                filtering={filtering}
                summaryExpanded={summaryExpanded}
              />
            ) : (
              <SummaryRow
                key={`summary-${child.parentId}`}
                parentId={child.parentId}
                count={child.count}
                depth={depth + 1}
                open={summaryExpandedIds?.has(child.parentId) ?? false}
                onToggle={(parentId) =>
                  summaryExpanded?.toggleSummary(parentId)
                }
              />
            )
          )}
        </div>
      )}
    </div>
  );
}, sameNodeProps);
