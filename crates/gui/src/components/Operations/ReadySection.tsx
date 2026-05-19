import { useCallback, useRef, useState } from "react";
import type { Task } from "../../bindings";
import { commands } from "../../bindings";
import { deriveRunControlsState } from "../../utils/runState";

interface ReadySectionProps {
  tasks: Task[];
  onTaskStarted?: (taskId: string) => void;
}

export function ReadySection({ tasks, onTaskStarted }: ReadySectionProps) {
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(
    () => new Set(),
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
    [onTaskStarted, setTaskPending],
  );

  if (tasks.length === 0) return null;

  return (
    <section aria-label="Ready to start">
      <h2 className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        <span className="inline-block h-2.5 w-2.5 rounded-sm bg-text-muted" aria-hidden="true" />
        Ready
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-muted">
          {tasks.length}
        </span>
      </h2>

      <div className="space-y-1">
        {tasks.map((task) => {
          const isPending = pendingTaskIds.has(task.id);
          const runControls = deriveRunControlsState(
            task.run_controls ?? null,
            { hasWorkflow: Boolean(task.workflow_id) }
          );
          const startDisabled = runControls.runDisabled || isPending;
          return (
            <div
              key={task.id}
              className="border-l-2 border-l-border bg-bg-secondary px-4 py-3"
              data-testid="ready-item"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <svg
                    className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" strokeWidth={2} />
                  </svg>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">
                      {task.title}
                      <span className="font-normal text-text-secondary">
                        {" "}&mdash; {task.workflow_id ? "all blockers resolved" : "ready to start"}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {task.workflow_name && (
                        <span>{task.workflow_name}</span>
                      )}
                      {task.step_name && (
                        <> &middot; <span className="font-mono">{task.step_name}</span></>
                      )}
                      {!task.workflow_name && !task.step_name && (
                        <span>No workflow assigned</span>
                      )}
                    </p>
                  </div>
                </div>

                {task.workflow_id && task.current_step_id && (
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
                          ? task.run_controls.disabled_reason ??
                            "Not runnable right now"
                          : "Run the entire workflow for this task"
                    }
                    aria-label="Run entire workflow"
                    className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-bg-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Run Workflow
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
