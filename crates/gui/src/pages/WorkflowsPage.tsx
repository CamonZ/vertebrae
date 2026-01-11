import { useWorkflows } from '../hooks/useWorkflows';
import { WorkflowGrid } from '../components/WorkflowGrid';

/**
 * WorkflowsPage displays all workflows with neural-pathway design.
 */
export function WorkflowsPage() {
  const { workflows, isLoading, error, refetch } = useWorkflows();

  return (
    <div className="relative flex-1 space-y-6 overflow-auto p-6">
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

      <div className="relative flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Workflows</h2>
          <p className="mt-1 text-sm text-text-muted">
            Manage automation pipelines
          </p>
        </div>
        <button
          onClick={refetch}
          disabled={isLoading}
          className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-all hover:border-primary hover:bg-primary hover:text-bg-primary hover:shadow-glow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Refresh workflows"
        >
          <svg
            className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <div className="relative">
        <WorkflowGrid workflows={workflows} isLoading={isLoading} error={error} />
      </div>
    </div>
  );
}
