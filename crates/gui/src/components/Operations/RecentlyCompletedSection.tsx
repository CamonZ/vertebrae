import { useState, useCallback } from "react";
import type { Task, StepExecution } from "../../bindings";
import { formatDuration } from "./formatDuration";
import { RelativeTime } from "../RelativeTime";

/** A completed execution paired with its task. */
export interface CompletedItem {
  task: Task;
  execution: StepExecution;
}

interface RecentlyCompletedSectionProps {
  items: CompletedItem[];
}

export function RecentlyCompletedSection({
  items,
}: RecentlyCompletedSectionProps) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const handleDismiss = useCallback((executionId: string) => {
    setDismissedIds((prev) => new Set(prev).add(executionId));
  }, []);

  const handleDismissAll = useCallback(() => {
    setDismissedIds(new Set(items.map((i) => i.execution.id!).filter(Boolean)));
  }, [items]);

  const visibleItems = items.filter(
    (item) => item.execution.id && !dismissedIds.has(item.execution.id),
  );

  if (visibleItems.length === 0) return null;

  return (
    <section aria-label="Recently completed">
      <div className="mb-3 flex items-baseline justify-between border-b border-[var(--color-line)] pb-2">
        <h2 className="flex items-baseline gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-ok)]">
          <svg
            className="h-2.5 w-2.5"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M1 5l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Recently Completed</span>
          <span className="text-[var(--color-ok)]/70">{visibleItems.length}</span>
        </h2>
        {visibleItems.length > 1 && (
          <button
            type="button"
            onClick={handleDismissAll}
            className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-fg-mute)] transition-colors hover:text-[var(--color-fg-soft)]"
          >
            Dismiss all
          </button>
        )}
      </div>

      <div className="space-y-1">
        {visibleItems.map((item) => (
          <div
            key={item.execution.id}
            className="group border-l-2 border-l-border bg-bg-secondary px-4 py-3"
            data-testid="completed-item"
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
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <div className="min-w-0">
                  <p className="text-sm text-text-secondary">
                    {item.task.title}
                    {item.execution.step_name && (
                      <span className="text-text-muted">
                        {" "}&mdash; completed step &apos;{item.execution.step_name}&apos;
                        {item.execution.started_at && (
                          <> ({formatDuration(item.execution.started_at, item.execution.completed_at)})</>
                        )}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {item.task.workflow_name && <>{item.task.workflow_name}</>}
                    {item.execution.completed_at && (
                      <> &middot; <RelativeTime date={item.execution.completed_at} className="inline" /></>
                    )}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => handleDismiss(item.execution.id!)}
                className="shrink-0 rounded p-1 text-text-muted opacity-0 transition-all hover:bg-bg-hover hover:text-text-secondary group-hover:opacity-100"
                aria-label={`Dismiss ${item.task.title}`}
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
