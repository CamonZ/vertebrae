import type { Workflow } from '../../bindings';
import { WorkflowCard } from './WorkflowCard';

interface WorkflowGridProps {
  workflows: Workflow[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Loading skeleton for the workflow grid
 */
function LoadingSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      role="status"
      aria-label="Loading workflows"
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-lg border border-border bg-bg p-5"
        >
          <div className="flex items-start justify-between">
            <div className="h-5 w-32 rounded bg-bg-2" />
            <div className="h-4 w-12 rounded bg-bg-2" />
          </div>
          <div className="mt-3 h-4 w-full rounded bg-bg-2" />
          <div className="mt-1 h-4 w-3/4 rounded bg-bg-2" />
          <div className="mt-4 flex items-center gap-4">
            <div className="h-4 w-16 rounded bg-bg-2" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading workflows...</span>
    </div>
  );
}

/**
 * Empty state when no workflows exist
 */
function EmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 text-center"
      role="status"
    >
      <svg
        className="mb-4 h-12 w-12 text-fg-mute"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
        />
      </svg>
      <p className="text-sm font-medium text-fg">No workflows found</p>
      <p className="mt-1 text-sm text-fg-soft">
        Create a workflow to get started.
      </p>
    </div>
  );
}

/**
 * Error state when workflow fetching fails
 */
function ErrorState({ error }: { error: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 text-center"
      role="alert"
    >
      <svg
        className="mb-4 h-12 w-12 text-err"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <p className="text-sm font-medium text-fg">
        Failed to load workflows
      </p>
      <p className="mt-1 text-sm text-err">{error}</p>
    </div>
  );
}

/**
 * WorkflowGrid component displays workflows in a responsive grid layout.
 * Uses WorkflowCard for individual workflow display.
 *
 * Responsive columns:
 * - Mobile (< 640px): 1 column
 * - Tablet (>= 640px): 2 columns
 * - Desktop (>= 1024px): 3 columns
 */
export function WorkflowGrid({ workflows, isLoading, error }: WorkflowGridProps) {
  if (error) {
    return <ErrorState error={error} />;
  }

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (workflows.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {workflows.map((workflow) => (
        <WorkflowCard key={workflow.id} workflow={workflow} />
      ))}
    </div>
  );
}
