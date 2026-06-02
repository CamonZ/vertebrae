import { Link } from 'react-router-dom';
import type { Workflow } from '../../bindings';
import { ScanIdentifier } from '../shared/EntityId';

interface WorkflowCardProps {
  workflow: Workflow;
}

/**
 * WorkflowCard component displays a single workflow in the grid.
 * Shows workflow name and description.
 * Clicking navigates to the workflow detail page.
 */
export function WorkflowCard({ workflow }: WorkflowCardProps) {
  const workflowId = workflow.id ?? '';

  return (
    <Link
      to={`/workflow/${workflowId}`}
      className="group block rounded-lg border border-border bg-bg p-5 shadow-1 transition-all hover:border-border-focus hover:shadow-2 focus:outline-none focus:ring-2 focus:ring-border-focus"
      aria-label={`View workflow: ${workflow.name}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-fg group-hover:text-accent">
            {workflow.name}
          </h3>
          {workflow.is_default && (
            <span className="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-accent">
              Default
            </span>
          )}
          {workflow.is_final && (
            <span className="inline-flex items-center rounded-full bg-warn/15 px-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-warn">
              Final
            </span>
          )}
        </div>
        <ScanIdentifier
          id={workflowId}
          kind="workflow"
          copyable={false}
          testId="workflow-card-id"
        />
      </div>

      {workflow.description && (
        <p className="mt-2 line-clamp-2 text-sm text-fg-soft">
          {workflow.description}
        </p>
      )}

      <div className="mt-4 flex items-center gap-4">
        <div className="flex items-center gap-1.5 text-sm text-fg-mute">
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
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <span>
            {workflow.initial_step ? 'Active' : 'No steps configured'}
          </span>
        </div>
        {workflow.kanban_column && (
          <div className="flex items-center gap-1.5 text-sm text-fg-mute">
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
                d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7"
              />
            </svg>
            <span>{workflow.kanban_column}</span>
          </div>
        )}
      </div>
    </Link>
  );
}
