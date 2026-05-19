import { useCallback } from "react";
import type { Task, TaskRun } from "../../bindings";
import { commands } from "../../bindings";
import { formatDuration } from "./formatDuration";
import { ScanIdentifier } from "../shared/EntityId";

export interface AttentionItem {
  kind: "failed_run" | "review_request";
  task: Task;
  taskRun?: TaskRun;
}

interface NeedsAttentionSectionProps {
  items: AttentionItem[];
  onViewLogs?: (taskRunId: string) => void;
  onRetry?: (taskId: string) => void;
}

const NULL_UPDATE = {
  title: null,
  description: null,
  priority: null,
  level: null,
  archived: null,
  worktree: null,
};

export function NeedsAttentionSection({
  items,
  onViewLogs,
  onRetry,
}: NeedsAttentionSectionProps) {
  const handleReview = useCallback(async (taskId: string, feedback?: string) => {
    await commands.updateTask(taskId, {
      ...NULL_UPDATE,
      needs_human_review: false,
      revision_feedback: feedback ?? null,
    });
  }, []);

  if (items.length === 0) return null;

  return (
    <section aria-label="Needs attention">
      <h2 className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-error">
        <span className="inline-block h-2.5 w-2.5 rounded-sm bg-error" aria-hidden="true" />
        Needs Attention
        <span className="rounded-full bg-error/20 px-2 py-0.5 text-xs font-medium text-error">
          {items.length}
        </span>
      </h2>

      <div className="space-y-1">
        {items.map((item) => {
          const key =
            item.kind === "failed_run" && item.taskRun?.id
              ? `run-${item.taskRun.id}`
              : `review-${item.task.id}`;

          return (
            <div
              key={key}
              className="border-l-2 border-l-error/40 bg-error/5 px-4 py-3"
              data-testid="attention-item"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {item.kind === "review_request" ? (
                    <svg
                      className="mt-0.5 h-4 w-4 shrink-0 text-error"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                      />
                    </svg>
                  ) : (
                    <svg
                      className="mt-0.5 h-4 w-4 shrink-0 text-error"
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
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">
                      {item.task.title}
                      {item.kind === "failed_run" && (
                        <span className="font-normal text-text-secondary">
                          {" "}&mdash; orchestration run failed
                        </span>
                      )}
                      {item.kind === "review_request" && (
                        <span className="font-normal text-text-secondary">
                          {" "}&mdash; Flagged for human review
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {item.kind === "failed_run" ? (
                        <>
                          {item.task.workflow_name && <>{item.task.workflow_name} &middot; </>}
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
                            <> &middot; {formatDuration(item.taskRun.started_at, item.taskRun.ended_at)}</>
                          )}
                        </>
                      ) : (
                        <>
                          {item.task.workflow_name && <>{item.task.workflow_name} &middot; </>}
                          Waiting for human review
                        </>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {item.kind === "failed_run" && item.taskRun?.id && (
                    <>
                      <button
                        type="button"
                        onClick={() => onViewLogs?.(item.taskRun!.id!)}
                        className="rounded-md border border-border bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                      >
                        View Logs
                      </button>
                      <button
                        type="button"
                        onClick={() => onRetry?.(item.task.id)}
                        className="rounded-md border border-error/30 bg-error/10 px-2.5 py-1 text-xs text-error transition-colors hover:bg-error/20"
                      >
                        Retry
                      </button>
                    </>
                  )}
                  {item.kind === "review_request" && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleReview(item.task.id)}
                        className="rounded-md bg-success px-3 py-1 text-xs font-medium text-bg-primary transition-colors hover:bg-success/90"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReview(item.task.id, "Rejected during review")}
                        className="rounded-md border border-error/30 bg-error/10 px-3 py-1 text-xs font-medium text-error transition-colors hover:bg-error/20"
                      >
                        Reject
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
