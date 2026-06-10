import { useCallback, useRef, useState } from "react";
import type { Task } from "../../bindings";
import { commands } from "../../bindings";
import { deriveRunControlsState } from "../../utils/runState";
import { Count } from "../atoms";
import { StepBadge } from "../molecules/StepBadge";

interface ReadySectionProps {
  tasks: Task[];
  onTaskStarted?: (taskId: string) => void;
}

export function ReadySection({ tasks, onTaskStarted }: ReadySectionProps) {
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(
    () => new Set()
  );
  const pendingTaskIdsRef = useRef<Set<string>>(new Set());

  const setTaskPending = useCallback((taskId: string, pending: boolean) => {
    const next = new Set(pendingTaskIdsRef.current);
    if (pending) {
      next.add(taskId);
    } else {
      next.delete(taskId);
    }
    pendingTaskIdsRef.current = next;
    setPendingTaskIds(next);
  }, []);

  const handleStart = useCallback(
    async (task: Task) => {
      const runControls = deriveRunControlsState(task.run_controls ?? null, {
        hasWorkflow: Boolean(task.workflow_id),
      });
      if (
        !task.current_step_id ||
        runControls.runDisabled ||
        pendingTaskIdsRef.current.has(task.id)
      ) {
        return;
      }
      setTaskPending(task.id, true);
      try {
        const result = await commands.runWorkflow(task.id);
        if (result.status === "ok") {
          onTaskStarted?.(task.id);
        }
      } catch {
        // Errors are surfaced via toasts from the event listeners
      } finally {
        setTaskPending(task.id, false);
      }
    },
    [onTaskStarted, setTaskPending]
  );

  if (tasks.length === 0) return null;

  return (
    <section aria-label="Ready to start">
      <h2 className="mb-3 flex items-baseline gap-2 border-b border-[var(--color-line)] pb-2 font-mono text-eyebrow font-medium uppercase tracking-eyebrow text-[var(--color-fg-mute)]">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-fg-faint)]"
          aria-hidden="true"
        />
        <span>Ready</span>
        <Count value={tasks.length} className="ml-auto" />
      </h2>

      <div className="space-y-1">
        {tasks.map((task) => {
          const isPending = pendingTaskIds.has(task.id);
          const runControls = deriveRunControlsState(
            task.run_controls ?? null,
            { hasWorkflow: Boolean(task.workflow_id) }
          );
          const startDisabled = runControls.runDisabled || isPending;
          const shortId = task.id.slice(0, 8);
          return (
            <div
              key={task.id}
              className="border-l-2 border-l-[var(--color-line)] bg-[var(--color-bg-1)] px-4 py-2.5 transition-colors hover:bg-[var(--color-bg-2)]"
              data-testid="ready-item"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-fg-faint)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                      {task.title}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-fg-mute)]">
                      {task.workflow_name && <span>{task.workflow_name}</span>}
                      {task.step_name && <StepBadge stepName={task.step_name} />}
                      {!task.workflow_name && !task.step_name && (
                        <span>No workflow assigned</span>
                      )}
                    </p>
                  </div>
                </div>

                <span
                  className="shrink-0 font-mono text-xs text-[var(--color-fg-faint)]"
                  data-testid="ready-item-id"
                  aria-hidden="true"
                >
                  {shortId}
                </span>

                {task.workflow_id && task.current_step_id ? (
                  <button
                    type="button"
                    onClick={() => handleStart(task)}
                    disabled={startDisabled}
                    aria-busy={isPending}
                    data-testid="ready-start-button"
                    title={
                      runControls.hasActiveRun
                        ? "Run is already active"
                        : !runControls.runnable && task.run_controls
                          ? (task.run_controls.disabled_reason ??
                            "Not runnable right now")
                          : "Run the entire workflow for this task"
                    }
                    aria-label="Run entire workflow"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-accent)]/40 bg-[var(--color-accent-wash)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] transition-all hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-wash)] hover:shadow-[0_0_12px_var(--color-accent-glow)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
                  >
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 12 12"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M3 2l7 4-7 4V2z" />
                    </svg>
                    Run
                  </button>
                ) : (
                  <span
                    className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-bg-2)] px-2 py-0.5 text-xs text-[var(--color-fg-mute)]"
                    data-testid="ready-item-backlog-chip"
                  >
                    Backlog
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
