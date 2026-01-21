import type { Workflow, Step } from "../../bindings";
import { ResizablePanel } from "../ResizablePanel";

interface WorkflowDetailPanelProps {
  workflow: Workflow | null;
  steps?: Step[];
  taskCount?: number;
  onClose?: () => void;
}

/**
 * Detail row component for displaying key-value pairs
 */
function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="flex-shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="text-right text-sm text-text-primary">{children}</span>
    </div>
  );
}

/**
 * Section header component
 */
function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
      {title}
    </h3>
  );
}

/**
 * Format a date string for display
 */
function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateString;
  }
}

/**
 * WorkflowDetailPanel displays workflow configuration in a side panel.
 * Shows workflow details including description, steps, metadata, and timestamps.
 */
export function WorkflowDetailPanel({
  workflow,
  steps = [],
  taskCount = 0,
  onClose,
}: WorkflowDetailPanelProps) {
  if (!workflow) {
    return null;
  }

  const initialStep = steps.find(
    (s) => s.id === workflow.initial_step || s.name === workflow.initial_step
  );

  return (
    <ResizablePanel
      storageKey="workflow-detail-panel-width"
      glowColor="from-primary/0 via-primary/30 to-primary/0"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
          Workflow Details
        </h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Close panel"
          >
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
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Workflow title */}
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-lg font-semibold text-text-primary">
          {workflow.name}
        </h3>
        <p className="mt-1 font-mono text-xs text-text-muted">{workflow.id}</p>
      </div>

      {/* Content */}
      <div className="flex-1 divide-y divide-border overflow-auto">
        {/* Description */}
        {workflow.description && (
          <div className="p-4">
            <SectionHeader title="Description" />
            <p className="text-sm leading-relaxed text-text-secondary">
              {workflow.description}
            </p>
          </div>
        )}

        {/* Overview */}
        <div className="p-4">
          <SectionHeader title="Overview" />
          <div className="space-y-1">
            <DetailRow label="Steps">{steps.length}</DetailRow>
            <DetailRow label="Tasks">{taskCount}</DetailRow>
            {initialStep && (
              <DetailRow label="Initial Step">
                <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
                  {initialStep.name}
                </code>
              </DetailRow>
            )}
          </div>
        </div>

        {/* Steps */}
        {steps.length > 0 && (
          <div className="p-4">
            <SectionHeader title={`Steps (${steps.length})`} />
            <div className="space-y-2">
              {steps
                .sort((a, b) => a.order - b.order)
                .map((step) => (
                  <div
                    key={step.id || step.name}
                    className="flex items-center gap-3 rounded-lg border border-border bg-bg-tertiary p-2"
                  >
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-primary/30 bg-primary/10 font-mono text-xs font-bold text-primary">
                      {step.order + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {step.name}
                      </p>
                      {step.goal && (
                        <p className="truncate text-xs text-text-muted">
                          {step.goal}
                        </p>
                      )}
                    </div>
                    <code className="flex-shrink-0 rounded bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                      {step.agent_config.model || "default"}
                    </code>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Metadata */}
        {Object.keys(workflow.metadata).length > 0 && (
          <div className="p-4">
            <SectionHeader title="Metadata" />
            <div className="space-y-1">
              {Object.entries(workflow.metadata).map(([key, value]) => (
                <DetailRow key={key} label={key}>
                  <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
                    {value}
                  </code>
                </DetailRow>
              ))}
            </div>
          </div>
        )}

        {/* Timeline */}
        <div className="p-4">
          <SectionHeader title="Timeline" />
          <div className="space-y-1">
            <DetailRow label="Created">
              {formatDate(workflow.created_at)}
            </DetailRow>
            <DetailRow label="Updated">
              {formatDate(workflow.updated_at)}
            </DetailRow>
          </div>
        </div>
      </div>
    </ResizablePanel>
  );
}
