import type { Task } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import { TaskTreeNode } from "./TaskTreeNode";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { EmptyState } from "../molecules/EmptyState";
import { useCallback, useMemo } from "react";

interface TaskTreeViewProps {
  hierarchy: TaskTreeNodeType[];
  isLoading: boolean;
  error: string | null;
  selectedTaskId?: string | null;
  onTaskSelect?: (task: Task) => void;
  expandedNodes?: ReturnType<typeof useExpandedNodes>;
  hideStatus?: boolean;
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

function flattenVisibleNodes(
  nodes: TaskTreeNodeType[],
  expandedNodes?: ReturnType<typeof useExpandedNodes>
): TaskTreeNodeType[] {
  const out: TaskTreeNodeType[] = [];
  const stack = [...nodes].reverse();

  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    const isExpanded = expandedNodes
      ? expandedNodes.isNodeExpanded(node.task.id)
      : true;
    if (node.children.length > 0 && isExpanded) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index]);
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
  hideStatus,
}: TaskTreeViewProps) {
  const visibleNodes = useMemo(
    () => (onTaskSelect ? flattenVisibleNodes(hierarchy, expandedNodes) : []),
    [hierarchy, expandedNodes, onTaskSelect]
  );

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
        {hierarchy.map((node) => (
          <TaskTreeNode
            key={node.task.id}
            node={node}
            depth={0}
            selectedTaskId={selectedTaskId}
            onTaskSelect={onTaskSelect}
            expandedNodes={expandedNodes}
            hideStatus={hideStatus}
          />
        ))}
      </div>
    </div>
  );
}
