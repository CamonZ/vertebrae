import { useEffect, useMemo } from "react";
import { useOperationsData } from "../hooks/useOperationsData";
import { useShellHeader } from "../hooks/useShellHeader";
import { useShellStore } from "../stores/shellStore";
import {
  NeedsAttentionSection,
  LiveSection,
  RecentlyCompletedSection,
  ReadySection,
} from "../components/Operations";

/**
 * Operations dashboard showing live system activity.
 *
 * Sections are ordered by urgency:
 *   1. Needs Attention -- failed TaskRuns and review requests. Failed
 *      StepExecution attempts inside an active TaskRun are NOT surfaced
 *      here -- they live in trace history, not the attention queue.
 *   2. Live -- TaskRuns whose status is queued/executing/waiting.
 *   3. Recently Completed -- StepExecutions that just finished (kept for
 *      attempt-level cost/log rollups).
 *   4. Ready -- unblocked tasks waiting to start.
 *
 * Real-time sync is handled by GlobalListeners at the app root.
 */
export function OperationsPage() {
  const {
    attentionItems,
    liveItems,
    completedItems,
    readyTasks,
    isLoading,
    error,
    refetch,
  } = useOperationsData();

  const headerActions = useMemo(
    () => (
      <div className="flex items-center gap-2 text-xs">
        {liveItems.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-ok-wash)] px-2.5 py-0.5 font-medium text-[var(--color-ok)]">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-ok)] opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-ok)]" />
            </span>
            {liveItems.length} running
          </span>
        )}
        {attentionItems.length > 0 && (
          <span className="rounded-full bg-[var(--color-err-wash)] px-2.5 py-0.5 font-medium text-[var(--color-err)]">
            {attentionItems.length} need attention
          </span>
        )}
      </div>
    ),
    [liveItems.length, attentionItems.length],
  );

  useShellHeader("Operations", headerActions);

  // Surface the attention count to the sidebar so the Operations nav icon
  // can light up its needs-attention dot.
  useEffect(() => {
    useShellStore.getState().setNeedsAttentionCount(attentionItems.length);
    return () => {
      useShellStore.getState().setNeedsAttentionCount(0);
    };
  }, [attentionItems.length]);

  const isEmpty =
    !isLoading &&
    !error &&
    attentionItems.length === 0 &&
    liveItems.length === 0 &&
    completedItems.length === 0 &&
    readyTasks.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Visually-hidden heading: the visible page title lives in the shell
          header via useShellHeader above. We keep an in-page <h1> so screen
          readers and route/page-isolation tests see a stable heading even
          when the AppShell wrapper isn't mounted in a test environment. */}
      <h1 className="sr-only">Operations</h1>
      <div className="flex-1 overflow-auto bg-[var(--color-bg)] p-6">
        {isLoading &&
        attentionItems.length === 0 &&
        liveItems.length === 0 &&
        completedItems.length === 0 &&
        readyTasks.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
              <p className="text-sm text-[var(--color-fg-mute)]">
                Loading operations...
              </p>
            </div>
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-[var(--color-err)]">{error}</p>
              <button
                type="button"
                onClick={refetch}
                className="mt-2 text-xs text-[var(--color-fg-mute)] underline hover:text-[var(--color-fg-soft)]"
              >
                Try again
              </button>
            </div>
          </div>
        ) : isEmpty ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <svg
                className="mx-auto mb-4 h-12 w-12 text-[var(--color-fg-mute)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <p className="font-serif text-lg text-[var(--color-fg)]">
                All clear
              </p>
              <p className="mt-1 text-xs text-[var(--color-fg-mute)]">
                No active operations or items needing attention
              </p>
            </div>
          </div>
        ) : (
          <div className="w-full space-y-6">
            <NeedsAttentionSection items={attentionItems} />
            <LiveSection items={liveItems} />
            <RecentlyCompletedSection items={completedItems} />
            <ReadySection tasks={readyTasks} />
          </div>
        )}
      </div>
    </div>
  );
}
