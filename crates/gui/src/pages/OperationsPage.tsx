import { useOperationsData } from "../hooks/useOperationsData";
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
 *   1. Needs Attention -- failed executions and review requests
 *   2. Live -- currently running operations
 *   3. Recently Completed -- what just finished
 *   4. Ready -- unblocked tasks waiting to start
 *
 * Real-time event listeners keep all sections in sync with backend changes.
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

  const isEmpty =
    !isLoading &&
    !error &&
    attentionItems.length === 0 &&
    liveItems.length === 0 &&
    completedItems.length === 0 &&
    readyTasks.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="relative border-b border-border bg-bg-primary px-6 py-4">
        <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />
        <div className="relative flex items-center gap-4">
          <h1 className="text-lg font-semibold text-text-primary">
            Operations
          </h1>
          {liveItems.length > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              {liveItems.length} running
            </span>
          )}
          {attentionItems.length > 0 && (
            <span className="rounded-full bg-error/10 px-2.5 py-0.5 text-xs font-medium text-error">
              {attentionItems.length} need attention
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto bg-bg-primary p-6">
        {isLoading && attentionItems.length === 0 && liveItems.length === 0 && completedItems.length === 0 && readyTasks.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-text-muted">Loading operations...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-error">{error}</p>
              <button
                type="button"
                onClick={refetch}
                className="mt-2 text-xs text-text-muted underline hover:text-text-secondary"
              >
                Try again
              </button>
            </div>
          </div>
        ) : isEmpty ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <svg
                className="mx-auto mb-4 h-12 w-12 text-text-muted"
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
              <p className="text-sm text-text-muted">All clear</p>
              <p className="mt-1 text-xs text-text-muted">
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
