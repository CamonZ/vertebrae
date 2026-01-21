import { useState, useCallback } from "react";
import type { Workflow, Step } from "../../bindings";
import { commands } from "../../bindings";
import { ResizablePanel } from "../ResizablePanel";

interface WorkflowDetailPanelProps {
  workflow: Workflow | null;
  steps?: Step[];
  taskCount?: number;
  tasks?: { id: string; title: string }[];
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
  tasks = [],
  onClose,
}: WorkflowDetailPanelProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [runProgress, setRunProgress] = useState({ current: 0, total: 0 });
  const [runError, setRunError] = useState<string | null>(null);

  // Handle running workflow for all tasks
  const handleRunAll = useCallback(async () => {
    if (isRunning || tasks.length === 0) return;

    setIsRunning(true);
    setRunError(null);
    setRunProgress({ current: 0, total: tasks.length });

    for (let i = 0; i < tasks.length; i++) {
      setRunProgress({ current: i + 1, total: tasks.length });
      const task = tasks[i];
      try {
        const result = await commands.runWorkflow(task.id);
        if (result.status === "error") {
          setRunError(`${task.id} "${task.title}": ${result.error.message}`);
          break;
        }
      } catch (err) {
        setRunError(
          `${task.id} "${task.title}": ${err instanceof Error ? err.message : "Failed"}`
        );
        break;
      }
    }

    setIsRunning(false);
  }, [isRunning, tasks]);

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
        <div className="flex items-center gap-2">
          {/* Run All Button - only show if there are tasks */}
          {tasks.length > 0 && (
            <button
              type="button"
              onClick={handleRunAll}
              disabled={isRunning}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                isRunning
                  ? "cursor-not-allowed bg-primary/20 text-primary/50"
                  : "bg-primary/10 text-primary hover:bg-primary/20 hover:shadow-glow-sm"
              }`}
              aria-label={isRunning ? "Running workflows..." : "Run all tasks"}
              title={
                isRunning
                  ? `Running ${runProgress.current}/${runProgress.total}...`
                  : `Run workflow for all ${tasks.length} tasks`
              }
            >
              {isRunning ? (
                <>
                  <svg
                    className="h-3.5 w-3.5 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span>
                    {runProgress.current}/{runProgress.total}
                  </span>
                </>
              ) : (
                <>
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span>Run All</span>
                </>
              )}
            </button>
          )}
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
      </div>

      {/* Run error banner */}
      {runError && (
        <div className="border-b border-error/20 bg-error/5 px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-error">{runError}</p>
            <button
              type="button"
              onClick={() => setRunError(null)}
              className="rounded p-0.5 text-error/60 hover:bg-error/10 hover:text-error"
              aria-label="Dismiss error"
            >
              <svg
                className="h-3 w-3"
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
            </button>
          </div>
        </div>
      )}

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
