import { useState, useEffect } from "react";
import { runStatusLabel, type ActiveTaskRun } from "../../utils/runState";
import { formatDuration } from "./formatDuration";
import { StepBadge } from "../molecules/StepBadge";

export type LiveItem = ActiveTaskRun;

interface LiveSectionProps {
  items: LiveItem[];
}

/**
 * Displays a live-updating duration timer that re-renders every second.
 */
function LiveDuration({ startedAt }: { startedAt: string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="font-mono text-xs text-ok">
      {formatDuration(startedAt, null)}
    </span>
  );
}

export function LiveSection({ items }: LiveSectionProps) {
  if (items.length === 0) return null;

  return (
    <section aria-label="Live operations">
      <h2 className="mb-3 flex items-baseline gap-2 border-b border-[var(--color-line)] pb-2 font-mono text-eyebrow font-medium uppercase tracking-eyebrow text-[var(--color-ok)]">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-ok)] opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-ok)]" />
        </span>
        <span>Live</span>
        <span className="ml-auto text-[var(--color-ok)]/70">
          {items.length}
        </span>
      </h2>

      <div className="space-y-1">
        {items.map((item) => {
          const statusLabel = runStatusLabel(item.taskRun.status).toLowerCase();
          return (
            <div
              key={item.taskRun.id ?? item.task.id}
              className="border-l-2 border-l-ok/40 bg-ok/5 px-4 py-3"
              data-testid="live-item"
              data-run-status={item.taskRun.status}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">
                    {item.task.title}
                    {item.task.workflow_name && (
                      <span className="font-normal text-fg-soft">
                        {" "}
                        &rarr; {item.task.workflow_name} ({statusLabel})
                        {item.taskRun.started_at && (
                          <>
                            {" "}
                            (
                            {
                              <LiveDuration
                                startedAt={item.taskRun.started_at}
                              />
                            }
                            )
                          </>
                        )}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-xs text-fg-mute">
                    {item.task.workflow_name && (
                      <span>{item.task.workflow_name}</span>
                    )}
                    {!item.task.workflow_name && (
                      <span className="font-mono">{statusLabel}</span>
                    )}
                    {item.task.step_name && (
                      <StepBadge
                        stepName={item.task.step_name}
                        stepType={item.task.step_type}
                        runStatus={item.taskRun.status}
                      />
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-ok border-t-transparent" />
                </div>
              </div>
              {/* Progress bar */}
              <div
                className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ok/10"
                data-testid="live-progress-bar"
              >
                <div
                  className="h-full animate-signal-flow rounded-full bg-ok/40"
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
