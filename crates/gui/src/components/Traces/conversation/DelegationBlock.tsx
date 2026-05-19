/**
 * DelegationBlock — wraps a descendant task's events with an indent + left
 * border so the user can see a parent step "spawned" a child task and is
 * waiting on its work. The wrapped section gets its own StepBoundary
 * header rendered inline by the caller.
 *
 * When the spawning event is itself a workflow threshold (e.g. an approval
 * that triggered the child task's creation), `thresholdKind` tints the left
 * border to match FlightStrip's per-kind threshold colors.
 */

import type { ReactNode } from "react";
import { thresholdKindBorderClass } from "../levelColors";
import type { ThresholdMarkerKind } from "../timeline";

interface DelegationBlockProps {
  parentTaskId: string;
  childTaskId: string;
  childTaskTitle?: string | null;
  depth?: number;
  children: ReactNode;
  thresholdKind?: ThresholdMarkerKind | null;
}

export function DelegationBlock({
  parentTaskId,
  childTaskId,
  childTaskTitle,
  depth = 1,
  children,
  thresholdKind = null,
}: DelegationBlockProps): ReactNode {
  const borderClass = thresholdKind
    ? thresholdKindBorderClass(thresholdKind)
    : "border-primary/40";
  return (
    <div
      data-testid="unified-chat-delegation"
      data-parent-task-id={parentTaskId}
      data-child-task-id={childTaskId}
      data-depth={depth}
      data-threshold-kind={thresholdKind ?? ""}
      className={`my-2 border-l-2 ${borderClass} bg-bg-tertiary/30 pl-3`}
      style={{ marginLeft: (depth - 1) * 16 }}
    >
      {childTaskTitle && (
        <div className="px-1 py-1 font-mono text-xs uppercase tracking-wider text-primary">
          delegated → {childTaskTitle}
        </div>
      )}
      {children}
    </div>
  );
}
