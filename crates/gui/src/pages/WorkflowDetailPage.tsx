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
 * WorkflowDetailPage displays a workflow's pipeline view with React Flow.
 * Shows workflow metadata, a visual pipeline of steps, and associated tasks.
 */
export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workflow: workflowWithTasks, isLoading, error, refetch } = useWorkflow(id);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-text-muted">Loading workflow...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-6 dark:border-red-800 dark:bg-red-950">
        <h2 className="mb-2 text-lg font-semibold text-red-800 dark:text-red-200">
          Error Loading Workflow
        </h2>
        <p className="mb-4 text-red-600 dark:text-red-300">{error}</p>
        <button
          onClick={refetch}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (!workflowWithTasks) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary p-6">
        <p className="text-text-muted">Workflow not found</p>
        <Link
          to="/workflows"
          className="mt-4 inline-block text-sm text-primary hover:underline"
        >
          Back to Workflows
        </Link>
      </div>
    );
  }

  const { workflow, tasks } = workflowWithTasks;
  const workflowId = workflow.id ?? '';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-lg border border-border bg-bg-primary p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <div className="mb-1 flex items-center gap-3">
              <Link
                to="/workflows"
                className="text-text-muted hover:text-text-primary"
                aria-label="Back to workflows"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 19l-7-7m0 0l7-7m-7 7h18"
                  />
                </svg>
              </Link>
              <h1 className="text-2xl font-bold text-text-primary">
                {workflow.name}
              </h1>
            </div>
            <span className="font-mono text-sm text-text-muted">
              {truncateId(workflowId)}
            </span>
          </div>

          <div className="flex items-center gap-4 text-sm text-text-secondary">
            <div className="flex items-center gap-1.5">
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 6h16M4 12h16M4 18h7"
                />
              </svg>
              <span>
                {workflow.steps.length}{' '}
                {workflow.steps.length === 1 ? 'step' : 'steps'}
              </span>
            </div>

            {tasks.length > 0 && (
              <div className="flex items-center gap-1.5">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
                <span>
                  {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
                </span>
              </div>
            )}
          </div>
        </div>

        {workflow.description && (
          <p className="mt-4 text-text-secondary">{workflow.description}</p>
        )}

        {/* Chain indicators */}
        {(workflow.on_done_workflow || workflow.on_reject_workflow) && (
          <div className="mt-4 flex gap-4">
            {workflow.on_done_workflow && (
              <div className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 7l5 5m0 0l-5 5m5-5H6"
                  />
                </svg>
                <span>On done: {truncateId(workflow.on_done_workflow)}</span>
              </div>
            )}
            {workflow.on_reject_workflow && (
              <div className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
                <span>On reject: {truncateId(workflow.on_reject_workflow)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pipeline View */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-text-primary">
          Pipeline
        </h2>
        <WorkflowPipeline workflow={workflow} />
      </div>

      {/* Associated Tasks */}
      {tasks.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-text-primary">
            Associated Tasks ({tasks.length})
          </h2>
          <div className="rounded-lg border border-border bg-bg-primary">
            <ul className="divide-y divide-border">
              {tasks.map((task) => (
                <li key={task.id} className="p-4 hover:bg-bg-secondary">
                  <Link
                    to={`/?task=${task.id}`}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          task.status === 'done'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : task.status === 'in_progress'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                              : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
                        }`}
                      >
                        {task.status.replace('_', ' ')}
                      </span>
                      <span className="text-text-primary">{task.title}</span>
                    </div>
                    <span className="font-mono text-xs text-text-muted">
                      {truncateId(task.id)}
                    </span>
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
