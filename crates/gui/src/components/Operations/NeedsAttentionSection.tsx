import type { Task, TaskRun } from "../../bindings";
import { formatDuration } from "./formatDuration";
import { ScanIdentifier } from "../shared/EntityId";

export interface AttentionItem {
  kind: "failed_run";
  task: Task;
  taskRun?: TaskRun;
}

interface NeedsAttentionSectionProps {
  items: AttentionItem[];
  onViewLogs?: (taskRunId: string) => void;
  onRetry?: (taskId: string) => void;
}

export function NeedsAttentionSection({
  items,
  onViewLogs,
  onRetry,
}: NeedsAttentionSectionProps) {
  if (items.length === 0) return null;

  return (
    <section aria-label="Needs attention">
      <h2 className="mb-3 flex items-baseline gap-2 border-b border-[var(--color-line)] pb-2 font-mono text-eyebrow font-medium uppercase tracking-[0.16em] text-[var(--color-err)]">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-err)]"
          aria-hidden="true"
        />
        <span>Zone: Attention</span>
        <span className="ml-auto text-[var(--color-err)]/80">
          {items.length}
        </span>
      </h2>

      <div className="space-y-1">
        {items.map((item) => {
          const key = item.taskRun?.id
            ? `run-${item.taskRun.id}`
            : `run-${item.task.id}`;

          return (
            <div
              key={key}
              className="border-l-2 border-l-err/40 bg-err/5 px-4 py-3"
              data-testid="attention-item"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <svg
                    className="mt-0.5 h-4 w-4 shrink-0 text-err"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
                    />
                  </svg>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">
                      {item.task.title}
                      <span className="font-normal text-fg-soft">
                        {" "}
                        &mdash; orchestration run failed
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-fg-mute">
                      {item.task.workflow_name && (
                        <>{item.task.workflow_name} &middot; </>
                      )}
                      Run{" "}
                      {item.taskRun?.id ? (
                        <ScanIdentifier
                          id={item.taskRun.id}
                          kind="task run"
                          className="text-xs"
                          testId="needs-attention-run-id"
                        />
                      ) : (
                        <span className="font-mono">unknown</span>
                      )}
                      {item.taskRun?.started_at && (
                        <>
                          {" "}
                          &middot;{" "}
                          {formatDuration(
                            item.taskRun.started_at,
                            item.taskRun.ended_at
                          )}
                        </>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {item.taskRun?.id && (
                    <>
                      <button
                        type="button"
                        onClick={() => onViewLogs?.(item.taskRun!.id!)}
                        className="rounded-md border border-border bg-bg-2 px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-bg-hover hover:text-fg"
                      >
                        View Logs
                      </button>
                      <button
                        type="button"
                        onClick={() => onRetry?.(item.task.id)}
                        className="rounded-md border border-err/30 bg-err/10 px-2.5 py-1 text-xs text-err transition-colors hover:bg-err/20"
                      >
                        Retry
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
