import { useCallback, useMemo } from "react";
import type { Task } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { formatRelative } from "../../utils/formatRelative";
import { getPriorityIndicator } from "../../utils/taskPriority";
import {
  deriveHearthStateBreakdown,
  deriveRunStateChip,
  hasHearthStateBreakdown,
  isActiveRunStatus,
} from "../../utils/runState";
import { formatStepName } from "../../utils/formatStepName";
import {
  Glyph,
  IdChip,
  RunChip,
  StateBreakdown,
} from "../shared/HearthPrimitives";

interface TaskTreeNodeProps {
  node: TaskTreeNodeType;
  depth: number;
  isSelected?: boolean;
  selectedTaskId?: string | null;
  onTaskSelect?: (task: Task) => void;
  expandedNodes?: ReturnType<typeof useExpandedNodes>;
  hideStatus?: boolean;
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
  hideStatus,
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

  const priority = getPriorityIndicator(task.priority);
  const runChip = deriveRunStateChip(task);
  const activeRunStatus = task.run_controls?.active_run?.status ?? null;
  const tags = task.tags ?? [];
  const childLine = task.level === "task" ? null : childSummary(node);
  const breakdown = useMemo(
    () => deriveHearthStateBreakdown(node.children.map((child) => child.task)),
    [node.children]
  );
  const hasBreakdown = hasHearthStateBreakdown(breakdown);

  const chevron = hasChildren ? (isExpanded ? "▾" : "▸") : "";

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
            {priority && (
              <span
                className={`t-pri ${task.priority ?? ""} ${priority.color}`}
                title={priority.label}
                aria-label={priority.label}
                data-testid="task-tree-node-priority"
                data-priority={task.priority}
              >
                {priority.glyph}
              </span>
            )}
          </div>
          <div className="t-meta">
            {childLine && (
              <span
                className="tabular-nums"
                data-testid="task-tree-node-child-summary"
              >
                {childLine}
              </span>
            )}
            {tags.slice(0, 3).map((tag) => (
              <span key={tag} data-testid="task-tree-node-tag" className="tag">
                {tag}
              </span>
            ))}
            {hasBreakdown && <StateBreakdown {...breakdown} />}
          </div>
        </div>
        <div className="t-right">
          <span className="chip-slot">
            {runChip && (
              <RunChip
                status={runChip.status}
                label={runChip.label}
                data-testid="task-tree-node-run-chip"
                data-run-status={runChip.status ?? undefined}
              />
            )}
          </span>
          <IdChip
            id={task.id}
            kind="task"
            level={task.level}
            className="t-id"
            testId="task-tree-node-id"
          />
          {!hideStatus && task.step_name && (
            <span className="when">
              {formatStepName(task.step_name, "No step")}
            </span>
          )}
          {task.updated_at && (
            <span className="when">{formatRelative(task.updated_at)}</span>
          )}
        </div>
      </div>

      {hasChildren && isExpanded && (
        <div role="group" aria-label={`Children of ${task.title}`}>
          {node.children.map((childNode: TaskTreeNodeType) => (
            <TaskTreeNode
              key={childNode.task.id}
              node={childNode}
              depth={depth + 1}
              selectedTaskId={selectedTaskId}
              onTaskSelect={onTaskSelect}
              expandedNodes={expandedNodes}
              hideStatus={hideStatus}
            />
          ))}
        </div>
      )}
    </div>
  );
}
