import { useCallback, useEffect, useState } from "react";
import type { Workflow, Step } from "../../bindings";
import { commands } from "../../bindings";
import { ResizablePanel } from "../ResizablePanel";
import { OpenChatButton } from "../OpenChatButton";
import { Toggle } from "../Toggle";

interface WorkflowDetailPanelProps {
  workflow: Workflow | null;
  steps?: Step[];
  taskCount?: number;
  onClose?: () => void;
  onStepSelect?: (step: Step) => void;
  onStepCreated?: () => void;
  onBack?: () => void;
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
  onStepSelect,
  onStepCreated,
  onBack,
}: WorkflowDetailPanelProps) {
  const [isFinalError, setIsFinalError] = useState<string | null>(null);

  useEffect(() => {
    setIsFinalError(null);
  }, [workflow?.id]);

  const currentIsFinal = workflow?.is_final ?? false;
  const handleToggleIsFinal = useCallback(
    async (value: boolean) => {
      if (!workflow?.id || value === currentIsFinal) return;
      setIsFinalError(null);
      const result = await commands.updateWorkflow({
        workflow_id: workflow.id,
        name: null,
        description: null,
        auto_advance: null,
        order: null,
        is_default: null,
        is_final: value,
        kanban_column: null,
      });
      if (result.status === "error") {
        setIsFinalError(result.error.message);
      }
    },
    [workflow?.id, currentIsFinal]
  );

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
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Go back"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <h2 className="font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
            Workflow Details
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <OpenChatButton
            scope="workflow"
            entityId={workflow.id}
            label={workflow.name}
          />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
            {workflow.is_default && (
              <DetailRow label="Default">
                <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                  Yes
                </span>
              </DetailRow>
            )}
            {workflow.kanban_column && (
              <DetailRow label="Kanban Column">
                <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
                  {workflow.kanban_column}
                </code>
              </DetailRow>
            )}
            <DetailRow label="Steps">{steps.length}</DetailRow>
            <DetailRow label="Tasks">{taskCount}</DetailRow>
            {initialStep && (
              <DetailRow label="Initial Step">
                <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
                  {initialStep.name}
                </code>
              </DetailRow>
            )}
            <DetailRow label="Final">
              <Toggle
                checked={workflow.is_final ?? false}
                onChange={handleToggleIsFinal}
                label={`Final workflow: ${workflow.is_final ? "enabled" : "disabled"}`}
              />
            </DetailRow>
            {isFinalError && (
              <p className="mt-1 text-right text-xs text-error">{isFinalError}</p>
            )}
          </div>
        </div>

        {/* Steps */}
        {steps.length > 0 && (
          <div className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <SectionHeader title={`Steps (${steps.length})`} />
              {onStepCreated && (
                <button
                  type="button"
                  onClick={() => {
                    // Create a new step with the next order number
                    const nextOrder = Math.max(...steps.map((s) => s.order ?? 0), -1) + 1;
                    const workflowId = workflow?.id || "";
                    void commands
                      .createStep({
                        workflow_id: workflowId,
                        name: "",
                        goal: null,
                        agents: [],
                        skills: [],
                        order: nextOrder,
                        is_final: false,
                        transitions_to: [],
                        step_type: "execute",
                        output_schema: null,
                      })
                      .then((result) => {
                        if (result.status === "ok") {
                          onStepCreated();
                          if (result.data && onStepSelect) {
                            onStepSelect(result.data);
                          }
                        }
                      });
                  }}
                  className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-success focus:outline-none focus-visible:ring-2 focus-visible:ring-success"
                  aria-label="Create step"
                  title="Create new step"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              )}
            </div>
            <div className="space-y-2">
              {steps
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                .map((step) => (
                  <div
                    key={step.id || step.name}
                    onClick={() => onStepSelect?.(step)}
                    className={`flex items-center gap-3 rounded-lg border border-border bg-bg-tertiary p-2 transition-colors ${
                      onStepSelect
                        ? "cursor-pointer hover:border-primary/50 hover:bg-bg-hover"
                        : ""
                    }`}
                  >
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-primary/30 bg-primary/10 font-mono text-xs font-bold text-primary">
                      {(step.order ?? 0) + 1}
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
                      {step.agent_config?.model || "default"}
                    </code>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Metadata */}
        {Object.keys(workflow.metadata ?? {}).length > 0 && (
          <div className="p-4">
            <SectionHeader title="Metadata" />
            <div className="space-y-1">
              {Object.entries(workflow.metadata ?? {}).map(([key, value]) => (
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
