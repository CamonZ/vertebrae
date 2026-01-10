import { useWorkflows } from '../hooks/useWorkflows';
import { WorkflowGrid } from '../components/WorkflowGrid';

export function WorkflowsPage() {
  const { workflows, isLoading, error, refetch } = useWorkflows();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Workflows</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Manage and view your automation workflows
          </p>
        </div>
        <button
          onClick={refetch}
          disabled={isLoading}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Refresh workflows"
        >
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <WorkflowGrid workflows={workflows} isLoading={isLoading} error={error} />
    </div>
  );
}
