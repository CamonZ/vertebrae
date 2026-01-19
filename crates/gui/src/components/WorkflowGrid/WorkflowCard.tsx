import { Link } from 'react-router-dom';
import type { Workflow } from '../../bindings';

interface WorkflowCardProps {
  workflow: Workflow;
}

/**
 * Truncate workflow ID for display (show first 6 characters)
 */
function truncateId(id: string): string {
  return id.slice(0, 6);
}

/**
 * WorkflowCard component displays a single workflow in the grid.
 * Shows workflow name, description, and step count.
 * Clicking navigates to the workflow detail page.
 */
export function WorkflowCard({ workflow }: WorkflowCardProps) {
  const stepCount = workflow.steps.length;
  const workflowId = workflow.id ?? '';

  return (
    <Link
      to={`/workflow/${workflowId}`}
      className="group block rounded-lg border border-border bg-bg-primary p-5 shadow-sm transition-all hover:border-border-focus hover:shadow-md focus:outline-none focus:ring-2 focus:ring-border-focus"
      aria-label={`View workflow: ${workflow.name}`}
    >
      <div className="flex items-start justify-between">
        <h3 className="text-base font-semibold text-text-primary group-hover:text-primary">
          {workflow.name}
        </h3>
        <span className="font-mono text-xs text-text-muted">
          {truncateId(workflowId)}
        </span>
      </div>

      {workflow.description && (
        <p className="mt-2 line-clamp-2 text-sm text-text-secondary">
          {workflow.description}
        </p>
      )}

      <div className="mt-4 flex items-center gap-4">
        <div className="flex items-center gap-1.5 text-sm text-text-muted">
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 6h16M4 12h16M4 18h7"
            />
          </svg>
          <span>
            {stepCount} {stepCount === 1 ? 'step' : 'steps'}
          </span>
        </div>
      </div>
    </Link>
  );
}
