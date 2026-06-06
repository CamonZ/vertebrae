import { useCallback, useEffect, useState } from "react";
import type { Workflow, Step } from "../../bindings";
import { commands } from "../../bindings";
import { isEditableElementFocused } from "../../utils/isEditableElementFocused";
import { FloatingDetailPanel } from "../panels";
import { Toggle } from "../Toggle";
import { IdChip } from "../shared/HearthPrimitives";
import { Text } from "../atoms/Text";
import { Chip } from "../atoms/Chip";
import { Badge } from "../atoms/Badge";

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
      <Text variant="eyebrow" color="tertiary" className="flex-shrink-0">
        {label}
      </Text>
      <span className="text-right text-sm text-[var(--color-fg)]">
        {children}
      </span>
    </div>
  );
}

/**
 * Section-level header. Accent-colored to match the Task detail panel's
 * section labels; the muted eyebrow (`color="tertiary"`) is reserved for
 * sub-headings and DetailRow keys.
 */
function SectionHeader({ title }: { title: string }) {
  return (
    <Text variant="eyebrow" color="accent" as="h3" className="mb-2 block">
      {title}
    </Text>
  );
}

/** Neutral icon button matching the Hearth detail-panel header affordance. */
function IconButton({
  onClick,
  ariaLabel,
  title,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className="cursor-pointer rounded-[var(--radius-sm)] p-1.5 text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      {children}
    </button>
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
    <FloatingDetailPanel
      panelId="workflow-detail"
      widthStorageKey="workflow-detail-panel-width"
      onClose={onClose}
      shouldHandleEscape={() => !isEditableElementFocused()}
      testId="workflow-detail-panel"
    >
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-[var(--color-line)] px-4">
        <div className="flex items-center gap-2">
          {onBack && (
            <IconButton onClick={onBack} ariaLabel="Go back">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
              </svg>
            </IconButton>
          )}
          <Text variant="eyebrow" color="tertiary" as="h2">
            Workflow Details
          </Text>
        </div>
        <div className="flex items-center gap-2">
          {onClose && (
            <IconButton onClick={onClose} ariaLabel="Close panel">
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
            </IconButton>
          )}
        </div>
      </div>

      {/* Workflow title */}
      <div className="border-b border-[var(--color-line)] px-4 py-3">
        <h3 className="font-serif text-lg leading-snug text-[var(--color-fg)]">
          {workflow.name}
        </h3>
        <IdChip
          id={workflow.id}
          kind="workflow"
          className="mt-1"
          testId="workflow-detail-id"
        />
      </div>

      {/* Content */}
      <div className="flex-1 divide-y divide-[var(--color-line)] overflow-auto">
        {/* Description */}
        {workflow.description && (
          <div className="p-4">
            <SectionHeader title="Description" />
            <p className="text-sm leading-relaxed text-[var(--color-fg-soft)]">
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
                <Badge intent="accent">Yes</Badge>
              </DetailRow>
            )}
            {workflow.kanban_column && (
              <DetailRow label="Kanban Column">
                <Chip variant="static" className="font-mono">
                  {workflow.kanban_column}
                </Chip>
              </DetailRow>
            )}
            <DetailRow label="Steps">{steps.length}</DetailRow>
            <DetailRow label="Tasks">{taskCount}</DetailRow>
            {initialStep && (
              <DetailRow label="Initial Step">
                <Chip variant="static" className="font-mono">
                  {initialStep.name}
                </Chip>
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
              <p className="mt-1 text-right text-xs text-[var(--color-err)]">
                {isFinalError}
              </p>
            )}
          </div>
        </div>

        {/* Steps */}
        {steps.length > 0 && (
          <div className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <SectionHeader title={`Steps (${steps.length})`} />
              {onStepCreated && (
                <IconButton
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
                  ariaLabel="Create step"
                  title="Create new step"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                </IconButton>
              )}
            </div>
            <div className="space-y-2">
              {steps
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                .map((step) => {
                  return (
                    <div
                      key={step.id || step.name}
                      onClick={() => onStepSelect?.(step)}
                      className={`flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-1)] p-2 transition-[border-color,background-color] duration-[var(--t-base)] ease-[var(--ease-default)] ${
                        onStepSelect
                          ? "cursor-pointer hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-2)]"
                          : ""
                      }`}
                    >
                      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[color-mix(in_oklch,var(--color-accent)_30%,transparent)] bg-[var(--color-accent-wash)] font-mono text-xs font-bold text-[var(--color-accent)]">
                        {(step.order ?? 0) + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                          {step.name}
                        </p>
                        {step.goal && (
                          <p className="truncate text-xs text-[var(--color-fg-mute)]">
                            {step.goal}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
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
                  <Chip variant="static" className="font-mono">
                    {value}
                  </Chip>
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
    </FloatingDetailPanel>
  );
}
