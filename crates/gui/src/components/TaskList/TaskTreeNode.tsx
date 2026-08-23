import { useCallback, useMemo } from "react";
import type { Task, TaskRunStatus } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import type { useSummaryExpanded } from "../../hooks/useSummaryExpanded";
import { useActiveTaskRunsForTasks } from "../../hooks/useTaskRuns";
import { computeVisibleChildren } from "../../utils/computeVisibleChildren";
import { noteTaskDetailTreeRowRender } from "../../utils/taskDetailTrace";
import { formatRelative } from "../../utils/formatRelative";
import { getPriorityIndicator } from "../../utils/taskPriority";
import {
  deriveHearthStateBreakdown,
  deriveRunStateChip,
  hasHearthStateBreakdown,
  isActiveRunStatus,
} from "../../utils/runState";
import {
  Glyph,
  IdChip,
  Pipeline,
  RunChip,
  StateBreakdown,
} from "../shared/HearthPrimitives";
import type { PipelineSegment } from "../shared/HearthPrimitives";

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
}

/**
 * Terminal-run completion marker shown in the row's chip slot when there is no
 * active run. Mirrors the reference (docs/design/lib/tasks-app.jsx
 * `CompletionMark`): done → green ✓, stopped → muted ⊘, failed → error ⊘.
 * Active runs are handled by the RunChip instead, and never-run tasks render
 * nothing.
 *
 * `done` is driven purely by `completed_at`: any task with a completion
 * timestamp shows the ✓, whether or not it has a run. The ⊘ stays keyed off
 * the concrete terminal run `status` (a stopped/failed run that never
 * completed).
 */
function CompletionMark({
  done,
  status,
}: {
  done: boolean;
  status: TaskRunStatus | null;
}) {
  if (done) {
    return (
      <span
        className="done-mark"
        title="Completed"
        aria-label="Completed"
        data-testid="task-tree-node-done-mark"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (status === "stopped" || status === "failed") {
    const failed = status === "failed";
    return (
      <span
        className={["cancel-mark", failed ? "failed" : ""]
          .filter(Boolean)
          .join(" ")}
        title={failed ? "Failed" : "Stopped"}
        aria-label={failed ? "Failed" : "Stopped"}
        data-testid="task-tree-node-cancel-mark"
        data-run-status={status}
      >
        ⊘
      </span>
    );
  }
  return null;
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

/**
 * Pluralized child-level summary for the metadata line. The label reflects the
 * level *of the children* (one below this node), e.g. an epic with four tickets
 * reads "4 tickets". Falls back to the generic "items" when the child level is
 * unknown.
 */
function childSummary(node: TaskTreeNodeType): string | null {
  const count = node.children.length;
  if (count === 0) return null;

  const childLevel = node.children[0]?.task.level ?? null;
  const noun =
    childLevel === "epic"
      ? "epic"
      : childLevel === "ticket"
        ? "ticket"
        : childLevel === "task"
          ? "task"
          : "item";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function levelClass(level: Task["level"]): "l0" | "l1" | "l2" {
  if (level === "epic") return "l0";
  if (level === "ticket") return "l1";
  return "l2";
}

export function TaskTreeNode({
  node,
  depth,
  selectedTaskId,
  onTaskSelect,
  expandedNodes,
  hideCompleted = false,
  filtering = false,
  summaryExpanded,
}: TaskTreeNodeProps) {
  const task = node.task;
  if (selectedTaskId) {
    noteTaskDetailTreeRowRender(selectedTaskId, 1 + node.children.length);
  }
  const { activeRunsByTaskId } = useActiveTaskRunsForTasks([
    task.id,
    ...node.children.map((child) => child.task.id),
  ]);
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

  const priority = getPriorityIndicator(task.priority);
  const activeRun = activeRunsByTaskId.get(task.id) ?? null;
  const runChip = deriveRunStateChip(activeRun);
  const activeRunStatus = activeRun?.status ?? null;
  const tags = task.tags ?? [];
  const childLine = task.level === "task" ? null : childSummary(node);
  const breakdown = useMemo(
    () =>
      deriveHearthStateBreakdown(
        node.children.map((child) => child.task),
        activeRunsByTaskId
      ),
    [activeRunsByTaskId, node.children]
  );
  const hasBreakdown = hasHearthStateBreakdown(breakdown);

  // Workflow pipeline segments for the meta line. Not yet sourced for the list
  // view — the per-task step-state data isn't loaded here, so this stays empty
  // and the <Pipeline> renders nothing until that wiring lands.
  const pipeline: PipelineSegment[] = [];

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
            {childLine && (
              <>
                <span className="sep">·</span>
                <span
                  className="tabular-nums"
                  data-testid="task-tree-node-child-summary"
                >
                  {childLine}
                </span>
              </>
            )}
            {tags.length > 0 && (
              <>
                <span className="sep">·</span>
                {tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    data-testid="task-tree-node-tag"
                    className="tag"
                  >
                    {tag}
                  </span>
                ))}
              </>
            )}
            {pipeline.length > 0 && (
              <>
                <span className="sep">·</span>
                <Pipeline segments={pipeline} width={120} />
              </>
            )}
            {hasBreakdown && (
              <>
                <span className="sep">·</span>
                <StateBreakdown {...breakdown} />
              </>
            )}
          </div>
        </div>
        <div className="t-right">
          <span className="chip-slot">
            {runChip ? (
              <RunChip
                status={runChip.status}
                label={runChip.label}
                data-testid="task-tree-node-run-chip"
                data-run-status={runChip.status ?? undefined}
              />
            ) : (
              <CompletionMark
                done={Boolean(task.completed_at)}
                status={activeRunStatus}
              />
            )}
          </span>
          {task.updated_at && (
            <span className="when">{formatRelative(task.updated_at)}</span>
          )}
        </div>
        <div className="t-pri-col" aria-hidden={!priority || undefined}>
          {priority && (
            <span
              className={`t-pri ${task.priority ?? ""}`}
              title={priority.label}
              aria-label={priority.label}
              data-testid="task-tree-node-priority"
              data-priority={task.priority}
            >
              {priority.glyph}
            </span>
          )}
        </div>
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
}
