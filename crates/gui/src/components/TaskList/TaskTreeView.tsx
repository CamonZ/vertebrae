import type { Task } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import { SummaryRow, TaskTreeNode } from "./TaskTreeNode";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import type { useSummaryExpanded } from "../../hooks/useSummaryExpanded";
import {
  computeVisibleChildren,
  computeVisibleRoots,
} from "../../utils/computeVisibleChildren";
import { EmptyState } from "../molecules/EmptyState";
import { useCallback, useEffect, useMemo } from "react";
import { traceTaskDetailPhaseOnce } from "../../utils/taskDetailTrace";

interface TaskTreeViewProps {
  hierarchy: TaskTreeNodeType[];
  isLoading: boolean;
  error: string | null;
  selectedTaskId?: string | null;
  onTaskSelect?: (task: Task) => void;
  expandedNodes?: ReturnType<typeof useExpandedNodes>;
  hideCompleted?: boolean;
  filtering?: boolean;
  summaryExpanded?: ReturnType<typeof useSummaryExpanded>;
}

function LoadingSkeleton() {
  return (
    <div role="status" aria-label="Loading tasks">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-[var(--color-line)]/60 px-4 py-2.5"
          style={{
            paddingLeft: `${(index % 3) * 24 + 16}px`,
          }}
        >
          <div className="h-5 w-5 animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-bg-2)]" />
          <div className="h-4 w-12 animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-bg-2)]" />
          <div className="h-4 flex-1 animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-bg-2)]" />
          <div className="h-5 w-12 animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-bg-2)]" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-[var(--color-bg-2)]" />
        </div>
      ))}
      <span className="sr-only">Loading tasks...</span>
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-16 text-center"
      role="alert"
    >
      <svg
        className="mx-auto mb-4 h-12 w-12 text-[var(--color-err)]"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <p className="text-sm font-medium text-[var(--color-fg)]">
        Failed to load tasks
      </p>
      <p className="mt-2 max-w-sm rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-err)_30%,transparent)] bg-[var(--color-err-wash)] px-4 py-2 font-mono text-xs text-[var(--color-err)]">
        {error}
      </p>
    </div>
  );
}

interface FlattenOptions {
  expandedNodes?: ReturnType<typeof useExpandedNodes>;
  hideCompleted: boolean;
  filtering: boolean;
  summaryExpanded: ReadonlySet<string>;
}

/**
 * Flatten the visible, selectable rows in document order for keyboard
 * navigation. This shares {@link computeVisibleChildren} with the render path
 * so the keyboard cursor can never land on a row that isn't drawn — or skip a
 * row that is. Summary rows are not selectable and carry no task, so they are
 * intentionally absent from this list (the helper only yields them as
 * `kind: "summary"`, which we drop here).
 */
function flattenVisibleNodes(
  nodes: TaskTreeNodeType[],
  { expandedNodes, hideCompleted, filtering, summaryExpanded }: FlattenOptions
): TaskTreeNodeType[] {
  const out: TaskTreeNodeType[] = [];
  // Apply the same root-level collapse the render uses so the keyboard cursor
  // never lands on a folded-away root node (or skips a visible one).
  const visibleRoots = computeVisibleRoots(nodes, {
    hideCompleted,
    filtering,
    summaryExpanded,
  });
  const stack = visibleRoots
    .filter((child) => child.kind === "node")
    .map((child) => child.node)
    .reverse();

  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    const isExpanded = expandedNodes
      ? expandedNodes.isNodeExpanded(node.task.id)
      : true;
    if (node.children.length > 0 && isExpanded) {
      const visible = computeVisibleChildren(node, {
        hideCompleted,
        filtering,
        summaryExpanded,
      });
      for (let index = visible.length - 1; index >= 0; index -= 1) {
        const child = visible[index];
        if (child.kind === "node") {
          stack.push(child.node);
        }
      }
    }
  }

  return out;
}

export function TaskTreeView({
  hierarchy,
  isLoading,
  error,
  selectedTaskId,
  onTaskSelect,
  expandedNodes,
  hideCompleted = false,
  filtering = false,
  summaryExpanded,
}: TaskTreeViewProps) {
  const summaryExpandedIds = summaryExpanded?.summaryExpandedIds;
  const visibleNodes = useMemo(
    () =>
      onTaskSelect
        ? flattenVisibleNodes(hierarchy, {
            expandedNodes,
            hideCompleted,
            filtering,
            summaryExpanded: summaryExpandedIds ?? new Set<string>(),
          })
        : [],
    [
      hierarchy,
      expandedNodes,
      onTaskSelect,
      hideCompleted,
      filtering,
      summaryExpandedIds,
    ]
  );

  const visibleRoots = useMemo(
    () =>
      computeVisibleRoots(hierarchy, {
        hideCompleted,
        filtering,
        summaryExpanded: summaryExpandedIds ?? new Set<string>(),
      }),
    [hierarchy, hideCompleted, filtering, summaryExpandedIds]
  );

  useEffect(() => {
    if (!selectedTaskId || !onTaskSelect) return;
    traceTaskDetailPhaseOnce(selectedTaskId, "task-tree-data-ready", {
      visibleRows: visibleNodes.length,
      rootRows: visibleRoots.length,
    });
  }, [onTaskSelect, selectedTaskId, visibleNodes.length, visibleRoots.length]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!onTaskSelect || !selectedTaskId) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

      const selectedIndex = visibleNodes.findIndex(
        (node) => node.task.id === selectedTaskId
      );
      if (selectedIndex === -1) return;

      event.preventDefault();
      const nextIndex =
        event.key === "ArrowDown"
          ? Math.min(visibleNodes.length - 1, selectedIndex + 1)
          : Math.max(0, selectedIndex - 1);

      const nextNode = visibleNodes[nextIndex];
      if (nextNode && nextNode.task.id !== selectedTaskId) {
        onTaskSelect(nextNode.task);
      }
    },
    [onTaskSelect, selectedTaskId, visibleNodes]
  );

  if (error) {
    return <ErrorState error={error} />;
  }

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (hierarchy.length === 0) {
    return (
      <EmptyState
        title="No tasks found"
        description="Adjust filters or create a new task"
      />
    );
  }

  return (
    <div className="tasks-v2-tree">
      <div role="tree" aria-label="Task hierarchy" onKeyDown={handleKeyDown}>
        {visibleRoots.map((child) =>
          child.kind === "node" ? (
            <TaskTreeNode
              key={child.node.task.id}
              node={child.node}
              depth={0}
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
              depth={0}
              open={summaryExpandedIds?.has(child.parentId) ?? false}
              onToggle={(parentId) => summaryExpanded?.toggleSummary(parentId)}
            />
          )
        )}
      </div>
    </div>
  );
}
