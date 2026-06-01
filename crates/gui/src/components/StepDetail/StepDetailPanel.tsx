import { useState, useCallback, type ReactNode } from "react";
import type { Step, StepType, JsonValue } from "../../bindings";
import { commands } from "../../bindings";
import { useStep, useStepChangeListener } from "../../hooks";
import { DeleteConfirmation } from "../DeleteConfirmation";
import { EditableList } from "../EditableList";
import { ResizablePanel } from "../ResizablePanel";
import { InlineEditField } from "../TaskDetail/InlineEditField";
import { Toggle } from "../Toggle";
import { formatAgentModelLabel } from "../../utils/agentConfigLabel";
import { LiquidHighlight } from "./LiquidHighlight";
import { IdentityBadge } from "../shared/EntityId";
import { Text } from "../atoms/Text";
import { Chip } from "../atoms/Chip";
import { Badge } from "../atoms/Badge";

interface StepDetailPanelProps {
  stepId: string | null;
  allSteps: Step[];
  onClose?: () => void;
  onUpdated?: () => void;
  onDeleted?: () => void;
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
 * section labels. Every top-level section (Goal, Prompt, Overview, …) uses it;
 * the muted eyebrow (`color="tertiary"`) is reserved for DetailRow keys. An
 * optional `count` renders as a neutral Badge, mirroring the Task panel's
 * collapsible section counts.
 */
function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <Text variant="eyebrow" color="accent" as="h3">
        {title}
      </Text>
      {count !== undefined && <Badge count={count} intent="neutral" bordered />}
    </div>
  );
}

/** Neutral icon button matching the Hearth detail-panel header affordance. */
function IconButton({
  onClick,
  ariaLabel,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className="cursor-pointer rounded-[var(--radius-sm)] p-1.5 text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// Step type → Hearth token vocabulary. Step *types* (execute/evaluate/...) are a
// distinct vocabulary from workflow/execution states, so they keep their own map
// rather than reusing StatusBadge/StepBadge.
const STEP_TYPE_STYLES: Record<Extract<StepType, string>, string> = {
  execute:
    "border-[var(--color-line-strong)] bg-[var(--color-bg-2)] text-[var(--color-fg-soft)]",
  evaluate:
    "border-[color-mix(in_oklch,var(--color-info)_35%,transparent)] bg-[var(--color-info-wash)] text-[var(--color-info)]",
  route:
    "border-[color-mix(in_oklch,var(--color-warn)_35%,transparent)] bg-[var(--color-warn-wash)] text-[var(--color-warn)]",
  wait_children:
    "border-[color-mix(in_oklch,var(--color-accent)_45%,transparent)] bg-[var(--color-accent-wash)] text-[var(--color-accent)]",
  human_input:
    "border-[color-mix(in_oklch,var(--color-ok)_35%,transparent)] bg-[var(--color-ok-wash)] text-[var(--color-ok)]",
};

function formatStepType(stepType: StepType) {
  if (typeof stepType === "string") return stepType;
  return `unsupported:${stepType.unsupported}`;
}

function StepTypeBadge({ stepType }: { stepType: StepType }) {
  const style =
    typeof stepType === "string"
      ? STEP_TYPE_STYLES[stepType]
      : "border-[color-mix(in_oklch,var(--color-err)_40%,transparent)] bg-[var(--color-err-wash)] text-[var(--color-err)]";
  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius-sm)] border px-2 py-0.5 font-mono text-xs ${style}`}
      data-testid="step-type-badge"
    >
      {formatStepType(stepType)}
    </span>
  );
}

// JSON Schema type → color mapping
const SCHEMA_TYPE_COLORS: Record<string, string> = {
  string: "text-[var(--color-ok)]",
  number: "text-[var(--color-info)]",
  integer: "text-[var(--color-info)]",
  boolean: "text-[var(--color-warn)]",
  object: "text-[var(--color-accent)]",
  array: "text-[var(--color-accent)]",
  null: "text-[var(--color-fg-mute)]",
};

function SchemaTypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`font-mono text-xs ${SCHEMA_TYPE_COLORS[type] ?? "text-[var(--color-fg-soft)]"}`}
    >
      {type}
    </span>
  );
}

function SchemaNode({
  name,
  schema,
  required = false,
  depth = 0,
  isLast = true,
}: {
  name?: string;
  schema: Record<string, unknown>;
  required?: boolean;
  depth?: number;
  isLast?: boolean;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  const type = schema.type as string | undefined;
  const description = schema.description as string | undefined;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const requiredFields = (schema.required as string[]) ?? [];
  const items = schema.items as Record<string, unknown> | undefined;
  const title = schema.title as string | undefined;

  const isExpandable = type === "object" && properties && Object.keys(properties).length > 0;
  const propertyEntries = properties ? Object.entries(properties) : [];

  // Format type display: arrays show itemType[]
  let typeDisplay: ReactNode;
  if (type === "array" && items) {
    const itemType = (items.type as string) ?? "any";
    typeDisplay = (
      <>
        <SchemaTypeBadge type={itemType} />
        <span className="font-mono text-xs text-[var(--color-fg-mute)]">
          {"[]"}
        </span>
      </>
    );
  } else {
    typeDisplay = <SchemaTypeBadge type={type ?? "any"} />;
  }

  // Tree connector characters
  const connector = depth > 0 ? (isLast ? "└─ " : "├─ ") : "";

  return (
    <div data-testid={name ? `schema-node-${name}` : "schema-root"}>
      {/* Node row */}
      <div className="flex items-baseline gap-1 py-px">
        {depth > 0 && (
          <span className="select-none whitespace-pre font-mono text-xs text-[var(--color-fg-faint)]">
            {connector}
          </span>
        )}

        {/* Expand/collapse toggle for objects */}
        {isExpandable ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex cursor-pointer items-center text-[var(--color-fg-mute)] hover:text-[var(--color-fg)]"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <svg
              className={`h-3 w-3 transition-transform duration-[var(--t-base)] ease-[var(--ease-default)] ${expanded ? "rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : depth > 0 ? (
          <span className="inline-block w-3" />
        ) : null}

        {/* Property name */}
        {name && (
          <span className="font-mono text-xs font-medium text-[var(--color-fg)]">
            {name}
          </span>
        )}
        {name && (
          <span className="font-mono text-xs text-[var(--color-fg-mute)]">:</span>
        )}

        {/* Type */}
        {typeDisplay}

        {/* Required marker */}
        {required && (
          <span
            className="font-mono text-2xs text-[var(--color-err)]"
            title="required"
          >
            *
          </span>
        )}

        {/* Root title */}
        {title && depth === 0 && (
          <span className="ml-1 text-xs text-[var(--color-fg-mute)]">
            — {title}
          </span>
        )}
      </div>

      {/* Description */}
      {description && depth > 0 && (
        <div className="ml-8 pl-1">
          <span className="text-2xs italic leading-tight text-[var(--color-fg-mute)]">
            {description}
          </span>
        </div>
      )}

      {/* Nested properties */}
      {isExpandable && expanded && (
        <div className={depth > 0 ? "ml-4" : "ml-1"}>
          {propertyEntries.map(([key, value], index) => (
            <SchemaNode
              key={key}
              name={key}
              schema={value}
              required={requiredFields.includes(key)}
              depth={depth + 1}
              isLast={index === propertyEntries.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SchemaTree({ schema }: { schema: Record<string, unknown> }) {
  return (
    <div
      className="overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-2)] p-3"
      data-testid="schema-tree"
    >
      <SchemaNode schema={schema} />
    </div>
  );
}

/**
 * StepDetailPanel displays and allows editing workflow step configuration.
 * Self-fetches step data by ID and listens for change events.
 */
export function StepDetailPanel({
  stepId,
  allSteps,
  onClose,
  onUpdated,
  onDeleted,
  onBack,
}: StepDetailPanelProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);

  // Fetch step data on mount; applyUpdate lets us apply WS payloads without a round-trip
  const { step, applyUpdate } = useStep(stepId);

  // Apply WS payloads directly — no round-trip needed since the payload is the full entity
  useStepChangeListener({
    onUpdated: useCallback(
      (updatedStep: Step) => {
        if (updatedStep.id === stepId) applyUpdate(updatedStep);
      },
      [stepId, applyUpdate]
    ),
    onDeleted: useCallback(
      (deletedId: string) => {
        if (deletedId === stepId) onClose?.();
      },
      [stepId, onClose]
    ),
  });

  // Handle field updates
  const handleUpdateField = useCallback(
    async (updates: {
      name?: string;
      goal?: string | null;
      prompt?: string | null;
      agents?: string[];
      skills?: string[];
      step_type?: StepType;
      output_schema?: JsonValue | null;
      order?: number;
      is_final?: boolean;
      transitions_to?: string[];
    }) => {
      if (!step || !step.id) return;

      const result = await commands.updateStep({
        step_id: step.id,
        name: updates.name ?? null,
        goal: updates.goal ?? null,
        prompt: updates.prompt ?? null,
        agents: updates.agents ?? null,
        skills: updates.skills ?? null,
        step_type: updates.step_type ?? null,
        output_schema: updates.output_schema ?? null,
        order: updates.order ?? null,
        is_final: updates.is_final ?? null,
        transitions_to: updates.transitions_to ?? null,
      });

      if (result.status === "error") {
        throw new Error(result.error.message);
      }

      onUpdated?.();
    },
    [step, onUpdated]
  );

  // Handle adding an agent
  const handleAddAgent = useCallback(
    async (agent: string) => {
      if (!step) return;
      const newAgents = [...(step.agents || []), agent];
      await handleUpdateField({ agents: newAgents });
    },
    [step, handleUpdateField]
  );

  // Handle editing an agent
  const handleEditAgent = useCallback(
    async (index: number, value: string) => {
      if (!step) return;
      const newAgents = [...(step.agents || [])];
      newAgents[index] = value;
      await handleUpdateField({ agents: newAgents });
    },
    [step, handleUpdateField]
  );

  // Handle deleting an agent
  const handleDeleteAgent = useCallback(
    (index: number) => {
      if (!step) return;
      const newAgents = (step.agents || []).filter((_, i) => i !== index);
      void handleUpdateField({ agents: newAgents });
    },
    [step, handleUpdateField]
  );

  // Handle adding a skill
  const handleAddSkill = useCallback(
    async (skill: string) => {
      if (!step) return;
      const newSkills = [...(step.skills || []), skill];
      await handleUpdateField({ skills: newSkills });
    },
    [step, handleUpdateField]
  );

  // Handle editing a skill
  const handleEditSkill = useCallback(
    async (index: number, value: string) => {
      if (!step) return;
      const newSkills = [...(step.skills || [])];
      newSkills[index] = value;
      await handleUpdateField({ skills: newSkills });
    },
    [step, handleUpdateField]
  );

  // Handle deleting a skill
  const handleDeleteSkill = useCallback(
    (index: number) => {
      if (!step) return;
      const newSkills = (step.skills || []).filter((_, i) => i !== index);
      void handleUpdateField({ skills: newSkills });
    },
    [step, handleUpdateField]
  );

  // Handle toggling is_final
  const handleToggleIsFinal = useCallback(async (value: boolean) => {
    if (!step) return;
    await handleUpdateField({ is_final: value });
  }, [step, handleUpdateField]);

  // Handle order change
  const handleOrderChange = useCallback(
    async (newOrder: number) => {
      await handleUpdateField({ order: newOrder });
    },
    [handleUpdateField]
  );

  // Handle delete step
  const handleShowDeleteConfirmation = useCallback(() => {
    setShowDeleteConfirmation(true);
    setDeleteError(null);
  }, []);

  const handleCancelDelete = useCallback(() => {
    setShowDeleteConfirmation(false);
    setDeleteError(null);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!step || !step.id) return;

    setIsDeleting(true);
    setDeleteError(null);

    const result = await commands.deleteStep(step.id);

    if (result.status === "error") {
      setDeleteError(result.error.message);
      setIsDeleting(false);
    } else {
      setShowDeleteConfirmation(false);
      onDeleted?.();
    }
  }, [step, onDeleted]);

  // Early return if step is not loaded
  if (!step) {
    return null;
  }

  return (
    <ResizablePanel
      storageKey="step-detail-panel-width"
      glowColor="from-info/0 via-info/30 to-info/0"
      testId="step-detail-panel"
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
            Step Configuration
          </Text>
        </div>
        <div className="flex items-center gap-2">
          {/* Delete button */}
          <IconButton
            onClick={handleShowDeleteConfirmation}
            disabled={isDeleting || showDeleteConfirmation}
            ariaLabel="Delete step"
            title="Delete this step"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A1 1 0 0116.138 21H7.862a1 1 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </IconButton>
          {onClose && (
            <IconButton onClick={onClose} ariaLabel="Close panel">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </IconButton>
          )}
        </div>
      </div>

      {/* Delete confirmation — rendered at the top so it stays visible,
          matching the Task detail panel. */}
      {showDeleteConfirmation && (
        <DeleteConfirmation
          itemType="Step"
          itemName={step.name}
          isDeleting={isDeleting}
          error={deleteError}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}

      {/* Step configuration */}
      <div
        className="flex-1 divide-y divide-[var(--color-line)] overflow-auto"
        data-testid="step-config-scroll"
      >
        {/* Step title + Goal + Prompt scroll with the rest of the config. */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-accent)_30%,transparent)] bg-[var(--color-accent-wash)] font-mono text-sm font-bold text-[var(--color-accent)]">
                {(step.order ?? 0) + 1}
              </span>
              <div className="min-w-0 flex-1">
                <InlineEditField
                  value={step.name}
                  placeholder="Step name..."
                  onSave={async (value) => {
                    await handleUpdateField({ name: value });
                  }}
                />
                <IdentityBadge
                  id={step.id}
                  kind="step"
                  className="mt-1 text-xs text-[var(--color-fg-mute)]"
                  testId="step-detail-id"
                />
              </div>
            </div>

            {/* Goal - inline editable */}
            <div className="mt-3">
              <SectionHeader title="Goal" />
              <InlineEditField
                value={step.goal || ""}
                placeholder="Click to add goal..."
                multiline
                rows={3}
                onSave={async (value) => {
                  await handleUpdateField({ goal: value || null });
                }}
              />
            </div>

            {/* Prompt */}
            <div className="mt-3">
              <SectionHeader title="Prompt" />
              <div className="rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-2)] p-3">
                <InlineEditField
                  value={step.prompt || ""}
                  placeholder="Click to add prompt..."
                  multiline
                  rows={12}
                  resize="vertical"
                  monospace
                  renderDisplay={(value) => (
                    <LiquidHighlight source={value} data-testid="prompt-liquid-display" />
                  )}
                  onSave={async (value) => {
                    await handleUpdateField({ prompt: value || null });
                  }}
                />
              </div>
            </div>
          </div>

          {/* Overview */}
          <div className="p-4">
            <SectionHeader title="Overview" />
            <div className="space-y-1">
              <DetailRow label="Type">
                <StepTypeBadge stepType={step.step_type ?? "execute"} />
              </DetailRow>
              <DetailRow label="Order">
                <input
                  type="number"
                  value={step.order}
                  onChange={(e) => {
                    const newOrder = parseInt(e.target.value, 10);
                    if (!isNaN(newOrder)) {
                      void handleOrderChange(newOrder);
                    }
                  }}
                  className="w-20 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-2 py-1 font-mono text-xs text-right text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                />
              </DetailRow>
              <DetailRow label="Final Step">
                <Toggle
                  checked={step.is_final ?? false}
                  onChange={handleToggleIsFinal}
                  label={`Final step: ${step.is_final ? "enabled" : "disabled"}`}
                />
              </DetailRow>
            </div>
          </div>

          {/* Output Schema */}
          {step.output_schema && (
            <div className="p-4">
              <SectionHeader title="Output Schema" />
              <SchemaTree schema={step.output_schema as Record<string, unknown>} />
            </div>
          )}

          {/* Agents */}
          <div className="p-4">
            <SectionHeader title="Agents" count={(step.agents || []).length} />
            <EditableList
              items={step.agents || []}
              emptyText="No agents"
              placeholder="Add agent (e.g., .claude/agents/reviewer.md)..."
              onAdd={handleAddAgent}
              onEdit={handleEditAgent}
              onDelete={handleDeleteAgent}
              monospace
            />
          </div>

          {/* Skills */}
          <div className="p-4">
            <SectionHeader title="Skills" count={(step.skills || []).length} />
            <EditableList
              items={step.skills || []}
              emptyText="No skills"
              placeholder="Add skill (e.g., code-review)..."
              onAdd={handleAddSkill}
              onEdit={handleEditSkill}
              onDelete={handleDeleteSkill}
              monospace
            />
          </div>

          {/* Transitions */}
          <div className="p-4">
            <SectionHeader
              title="Transitions"
              count={(step.transitions_to ?? []).length}
            />
            {(step.transitions_to ?? []).length === 0 ? (
              <p className="text-xs italic text-[var(--color-fg-mute)]">
                No transitions
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(step.transitions_to ?? []).map((targetId, index) => {
                  const targetStep = allSteps.find((s) => s.id === targetId);
                  return (
                    <span
                      key={`${targetId}-${index}`}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-[color-mix(in_oklch,var(--color-accent)_45%,transparent)] bg-[var(--color-accent-wash)] px-2 py-1 font-mono text-2xs font-medium text-[var(--color-accent)]"
                      title={targetStep?.name || targetId.replace(/^step:/, "")}
                    >
                      <svg
                        className="h-3 w-3 flex-shrink-0 opacity-70"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                      <span className="truncate">
                        {targetStep?.name || targetId.replace(/^step:/, "")}
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Model Configuration */}
          <div className="p-4">
            <SectionHeader title="Model" />
            <div className="space-y-1">
              <DetailRow label="Primary">
                {step.agent_config?.model ? (
                  <Chip variant="static" className="font-mono">
                    {formatAgentModelLabel(step.agent_config)}
                  </Chip>
                ) : (
                  <span className="text-xs italic text-[var(--color-fg-mute)]">
                    Default
                  </span>
                )}
              </DetailRow>
              {step.agent_config?.fallback_model && (
                <DetailRow label="Fallback">
                  <Chip variant="static" className="font-mono">
                    {step.agent_config.fallback_model}
                  </Chip>
                </DetailRow>
              )}
            </div>
          </div>

          {/* Timeline */}
          <div className="p-4">
            <SectionHeader title="Timeline" />
            <div className="space-y-1">
              <DetailRow label="Created">
                {step.created_at
                  ? new Date(step.created_at).toLocaleString()
                  : "—"}
              </DetailRow>
              <DetailRow label="Updated">
                {step.updated_at
                  ? new Date(step.updated_at).toLocaleString()
                  : "—"}
              </DetailRow>
            </div>
          </div>

        </div>
    </ResizablePanel>
  );
}
