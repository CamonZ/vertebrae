/**
 * DelegationBlock — wraps a descendant task's events with an indent + left
 * border so the user can see a parent step "spawned" a child task and is
 * waiting on its work. The wrapped section gets its own StepBoundary
 * header rendered inline by the caller.
 */

import type { ReactNode } from "react";

interface DelegationBlockProps {
  parentTaskId: string;
  childTaskId: string;
  childTaskTitle?: string | null;
  depth?: number;
  children: ReactNode;
}

export function DelegationBlock({
  parentTaskId,
  childTaskId,
  childTaskTitle,
  depth = 1,
  children,
}: DelegationBlockProps): ReactNode {
  return (
    <div
      data-testid="unified-chat-delegation"
      data-parent-task-id={parentTaskId}
      data-child-task-id={childTaskId}
      data-depth={depth}
      className="my-2 border-l-2 border-primary/40 bg-bg-tertiary/30 pl-3"
      style={{ marginLeft: (depth - 1) * 16 }}
    >
      {childTaskTitle && (
        <div className="px-1 py-1 font-mono text-[10px] uppercase tracking-wider text-primary">
          delegated → {childTaskTitle}
        </div>
      )}
      {children}
    </div>
  );
}
