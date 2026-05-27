import { useCallback } from "react";
import type { Task, TaskPriority } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { RelativeTime } from "../RelativeTime";
import { deriveRunStateChip } from "../../utils/runState";
import { IdentityBadge } from "../shared/EntityId";
import { LevelMark } from "../shared/LevelMark";
import { TreeNode } from "../molecules/TreeNode";
import { StatusBadge } from "../molecules/StatusBadge";
import { RunStateBadge } from "./RunStateBadge";

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
 * Priority surfaces as a directional arrow on the right edge: high points up,
 * medium points right, low points down. `critical` reuses the up arrow with the
 * error tone so it still reads as "most urgent". Unset priority renders nothing.
 */
function getPriorityIndicator(
  priority: TaskPriority | null
): { glyph: string; color: string; label: string } | null {
  switch (priority) {
    case "critical":
      return { glyph: "↑", color: "text-[var(--color-err)]", label: "Critical priority" };
    case "high":
      return { glyph: "↑", color: "text-[var(--color-warn)]", label: "High priority" };
    case "medium":
      return { glyph: "→", color: "text-[var(--color-fg-soft)]", label: "Medium priority" };
    case "low":
      return { glyph: "↓", color: "text-[var(--color-fg-mute)]", label: "Low priority" };
    default:
      return null;
  }
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
  const tags = task.tags ?? [];
  const childLine = childSummary(node);

  // Leading slot: the per-level mark sits between the chevron and the title so
  // the hierarchy is legible without reading the ID. It matches the chevron's
  // box (h-6) so the two leading icons sit on one tidy line.
  const leading = (
    <LevelMark
      level={task.level}
      className="h-6 w-5"
      testId="task-tree-node-level-glyph"
    />
  );

  // Two-line body: title on the first line, a metadata line beneath it carrying
  // the short ID (with copy), tags, and the child-count summary.
  const body = (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="truncate font-medium text-[var(--color-fg)]">
        {task.title}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-sans text-2xs text-[var(--color-fg-mute)]">
        <IdentityBadge
          id={task.id}
          kind="task"
          level={task.level}
          className="shrink-0"
          testId="task-tree-node-id"
        />
        {childLine && (
          <span
            className="shrink-0 tabular-nums"
            data-testid="task-tree-node-child-summary"
          >
            {childLine}
          </span>
        )}
        {tags.map((tag) => (
          <span
            key={tag}
            data-testid="task-tree-node-tag"
            className="inline-flex h-4 max-w-[10rem] shrink-0 items-center truncate rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-1.5 text-[10px] font-medium text-[var(--color-fg-soft)]"
          >
            {tag}
          </span>
        ))}
      </span>
    </span>
  );

  // Trailing slot: the live run-state badge (only while running), the neutral
  // workflow|step breadcrumb, priority arrow, and the created-at timestamp.
  const right = (
    <span className="flex items-center gap-2">
      {runChip && (
        <RunStateBadge
          chip={runChip}
          stepName={task.step_name}
          startedAt={task.run_controls?.active_run?.started_at ?? null}
        />
      )}
      {!hideStatus && (task.workflow_name || task.step_name) && (
        <StatusBadge
          state={{
            kind: "workflow",
            workflow: task.workflow_name ?? "",
            step: task.step_name ?? "",
          }}
        />
      )}
      {priority && (
        <span
          className={`w-4 shrink-0 text-center text-sm font-bold leading-none ${priority.color}`}
          title={priority.label}
          aria-label={priority.label}
          data-testid="task-tree-node-priority"
          data-priority={task.priority}
        >
          {priority.glyph}
        </span>
      )}
      <span className="w-16 text-right">
        {task.created_at ? (
          <RelativeTime
            date={task.created_at}
            className="font-mono text-eyebrow tabular-nums text-[var(--color-fg-mute)]"
          />
        ) : (
          <span className="font-mono text-eyebrow text-[var(--color-fg-faint)]">
            —
          </span>
        )}
      </span>
    </span>
  );

  return (
    <div>
      <TreeNode
        depth={depth}
        hasChildren={hasChildren}
        expanded={isExpanded}
        selected={isSelected}
        onSelect={handleSelect}
        onToggle={handleToggleExpand}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        icon={leading}
        right={right}
        multiline
        testId="task-tree-node-row"
        className="border-b border-[var(--color-line)]/60"
      >
        {body}
      </TreeNode>

      {/* Children */}
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

