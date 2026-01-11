import { useParams, Link } from 'react-router-dom';
import { useWorkflow } from '../hooks/useWorkflow';
import { WorkflowPipeline } from '../components/WorkflowPipeline';

/**
 * Truncate workflow ID for display (show first 6 characters)
 */
function truncateId(id: string): string {
  return id.slice(0, 6);
}

/**
 * WorkflowDetailPage displays a workflow's pipeline view.
 * Features neural-pathway-inspired design with animated connections.
 */
export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workflow: workflowWithTasks, isLoading, error, refetch } = useWorkflow(id);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
            <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
          </div>
          <p className="text-sm text-text-muted">Loading workflow...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-6 rounded-xl border border-error/30 bg-error/5 p-6">
        <h2 className="mb-2 text-lg font-semibold text-text-primary">
          Error Loading Workflow
        </h2>
        <p className="mb-4 font-mono text-sm text-error">{error}</p>
        <button
          onClick={refetch}
          className="rounded-lg bg-error px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-error/90"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (!workflowWithTasks) {
    return (
      <div className="m-6 rounded-xl border border-border bg-bg-secondary p-6">
        <p className="text-text-muted">Workflow not found</p>
        <Link
          to="/workflows"
          className="mt-4 inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Workflows
        </Link>
      </div>
    );
  }

  const { workflow, tasks } = workflowWithTasks;
  const workflowId = workflow.id ?? '';

  return (
    <div className="relative flex-1 space-y-6 overflow-auto p-6">
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

      {/* Header */}
      <div className="relative rounded-xl border border-border bg-bg-secondary p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="mb-2 flex items-center gap-3">
              <Link
                to="/workflows"
                className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                aria-label="Back to workflows"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </Link>
              <h1 className="text-xl font-bold text-text-primary">{workflow.name}</h1>
            </div>
            <code className="rounded bg-bg-tertiary px-2 py-1 font-mono text-xs text-text-muted">
              {truncateId(workflowId)}
            </code>
          </div>

          <div className="flex items-center gap-4 text-sm text-text-secondary">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5">
              <svg className="h-4 w-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h7" />
              </svg>
              <span className="font-mono text-xs">
                {workflow.steps.length} step{workflow.steps.length !== 1 ? 's' : ''}
              </span>
            </div>

            {tasks.length > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5">
                <svg className="h-4 w-4 text-info" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span className="font-mono text-xs">
                  {tasks.length} task{tasks.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
          </div>
        </div>

        {workflow.description && (
          <p className="mt-4 text-sm text-text-secondary">{workflow.description}</p>
        )}

        {/* Chain indicators */}
        {(workflow.on_done_workflow || workflow.on_reject_workflow) && (
          <div className="mt-4 flex gap-4">
            {workflow.on_done_workflow && (
              <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-medium text-success">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                <span>On done: {truncateId(workflow.on_done_workflow)}</span>
              </div>
            )}
            {workflow.on_reject_workflow && (
              <div className="flex items-center gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-1.5 text-xs font-medium text-error">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span>On reject: {truncateId(workflow.on_reject_workflow)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pipeline View */}
      <div className="relative">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Pipeline
        </h2>
        <WorkflowPipeline workflow={workflow} />
      </div>

      {/* Associated Tasks */}
      {tasks.length > 0 && (
        <div className="relative">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Associated Tasks ({tasks.length})
          </h2>
          <div className="rounded-xl border border-border bg-bg-secondary">
            <ul className="divide-y divide-border">
              {tasks.map((task) => (
                <li key={task.id} className="group transition-colors hover:bg-bg-hover">
                  <Link
                    to={`/tasks?task=${task.id}`}
                    className="flex items-center justify-between p-4"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          task.status === 'done'
                            ? 'bg-success/10 text-success'
                            : task.status === 'in_progress'
                              ? 'bg-warning/10 text-warning'
                              : 'bg-bg-tertiary text-text-muted'
                        }`}
                      >
                        {task.status.replace('_', ' ')}
                      </span>
                      <span className="text-sm text-text-primary group-hover:text-primary">{task.title}</span>
                    </div>
                    <code className="font-mono text-xs text-text-muted">
                      {truncateId(task.id)}
                    </code>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
