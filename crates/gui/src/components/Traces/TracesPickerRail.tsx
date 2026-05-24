import { type ReactNode, type Ref } from "react";
import type { Task } from "../../bindings";
import { TaskPicker, type TaskPickerHandle } from "./TaskPicker";

interface TracesPickerRailProps {
  tasks: readonly Task[];
  onSelect: (taskId: string) => void;
  pickerRef: Ref<TaskPickerHandle>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** When set, shows a "Cancel" affordance to return to subtree mode. */
  onCancel?: () => void;
}

function Chevron({
  direction,
  className,
}: {
  direction: "right" | "left";
  className?: string;
}): ReactNode {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={direction === "right" ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"}
      />
    </svg>
  );
}

export function TracesPickerRail({
  tasks,
  onSelect,
  pickerRef,
  collapsed,
  onToggleCollapsed,
  onCancel,
}: TracesPickerRailProps): ReactNode {
  if (collapsed) {
    return (
      <aside
        data-testid="traces-picker-rail"
        data-collapsed="true"
        className="flex h-full w-8 flex-col items-center border-r border-[var(--color-line)] bg-[var(--color-bg-1)] py-2"
      >
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            data-testid="traces-picker-rail-toggle"
            aria-label="Expand task picker rail"
            className="rounded p-1 text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
          >
            <Chevron direction="right" className="h-4 w-4" />
          </button>
        )}
      </aside>
    );
  }

  return (
    <aside
      data-testid="traces-picker-rail"
      data-collapsed="false"
      className="flex h-full w-80 flex-col border-r border-[var(--color-line)] bg-[var(--color-bg-1)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-2 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-fg-mute)]">
          Pick a task
        </span>
        <div className="flex items-center gap-1">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              data-testid="traces-picker-rail-cancel"
              aria-label="Cancel switch task"
              className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
            >
              Cancel
            </button>
          )}
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              data-testid="traces-picker-rail-toggle"
              aria-label="Collapse task picker rail"
              className="rounded p-1 text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
            >
              <Chevron direction="left" className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-hidden p-2">
        <TaskPicker
          ref={pickerRef}
          tasks={tasks as Task[]}
          onSelect={onSelect}
          placeholder="Search tasks…"
        />
      </div>
    </aside>
  );
}
