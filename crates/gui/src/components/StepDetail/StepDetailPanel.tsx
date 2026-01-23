import { useState, useCallback } from "react";
import type { Step } from "../../bindings";
import { commands } from "../../bindings";
import { useStep, useStepChangeListener } from "../../hooks";
import { DeleteConfirmation } from "../DeleteConfirmation";
import { EditableList } from "../EditableList";
import { ResizablePanel } from "../ResizablePanel";
import { InlineEditField } from "../TaskDetail/InlineEditField";
import { Toggle } from "../Toggle";

interface StepDetailPanelProps {
  stepId: string | null;
  allSteps: Step[];
  onClose?: () => void;
  onUpdated?: () => void;
  onDeleted?: () => void;
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
 * StepDetailPanel displays and allows editing workflow step configuration.
 * Self-fetches step data by ID and listens for change events.
 */
export function StepDetailPanel({
  stepId,
  allSteps,
  onClose,
  onUpdated,
  onDeleted,
}: StepDetailPanelProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);

  // Fetch step data and listen for changes
  const { step, refetch } = useStep(stepId);

  // Listen for step change events
  useStepChangeListener(stepId, {
    onStepChange: () => {
      void refetch();
    },
  });

  // Handle field updates
  const handleUpdateField = useCallback(
    async (updates: {
      name?: string;
      goal?: string | null;
      agents?: string[];
      skills?: string[];
      order?: number;
      is_final?: boolean;
      transitions_to?: string[];
    }) => {
      if (!step || !step.id) return;

      const result = await commands.updateStep(
        step.id,
        updates.name ?? null,
        updates.goal ?? null,
        updates.agents ?? null,
        updates.skills ?? null,
        updates.order ?? null,
        updates.is_final ?? null,
        updates.transitions_to ?? null
      );

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
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
          Step Configuration
        </h2>
        <div className="flex items-center gap-2">
          {/* Delete button */}
          <button
            type="button"
            onClick={handleShowDeleteConfirmation}
            disabled={isDeleting || showDeleteConfirmation}
            className="cursor-pointer flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-error bg-error/10 text-error hover:bg-error/20 hover:shadow-glow-sm disabled:opacity-50"
            aria-label="Delete step"
            title="Delete this step"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A1 1 0 0016.138 21H7.862a1 1 0 00-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span>Delete</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Close panel"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Delete error */}
      {deleteError && (
        <div className="border-b border-border px-4 py-3 bg-error/5">
          <p className="text-xs text-error">{deleteError}</p>
        </div>
      )}

      {/* Step title */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 font-mono text-sm font-bold text-primary">
            {step.order + 1}
          </span>
          <div className="min-w-0 flex-1">
            <InlineEditField
              value={step.name}
              placeholder="Step name..."
              onSave={async (value) => {
                await handleUpdateField({ name: value });
              }}
            />
          </div>
        </div>

        {/* Goal - inline editable */}
        <div className="mt-3">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Goal
          </h3>
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
      </div>

      {/* Content */}
      <div className="flex-1 divide-y divide-border overflow-auto">
        {/* Overview */}
        <div className="p-4">
          <SectionHeader title="Overview" />
          <div className="space-y-1">
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
                className="w-20 rounded border border-border bg-bg-tertiary px-2 py-1 font-mono text-xs text-right focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </DetailRow>
            <DetailRow label="Final Step">
              <Toggle
                checked={step.is_final}
                onChange={handleToggleIsFinal}
                label={`Final step: ${step.is_final ? "enabled" : "disabled"}`}
              />
            </DetailRow>
          </div>
        </div>

        {/* Agents */}
        <div className="p-4">
          <SectionHeader title={`Agents (${(step.agents || []).length})`} />
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
          <SectionHeader title={`Skills (${(step.skills || []).length})`} />
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
            title={`Transitions (${step.transitions_to.length})`}
          />
          {step.transitions_to.length === 0 ? (
            <p className="text-xs italic text-text-muted">No transitions</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {step.transitions_to.map((targetId, index) => {
                const targetStep = allSteps.find((s) => s.id === targetId);
                return (
                  <span
                    key={`${targetId}-${index}`}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary"
                  >
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    {targetStep?.name || targetId.replace(/^step:/, "")}
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
              {step.agent_config.model ? (
                <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
                  {step.agent_config.model}
                </code>
              ) : (
                <span className="text-xs italic text-text-muted">Default</span>
              )}
            </DetailRow>
            {step.agent_config.fallback_model && (
              <DetailRow label="Fallback">
                <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
                  {step.agent_config.fallback_model}
                </code>
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

        {/* Delete Confirmation Section */}
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
      </div>
    </ResizablePanel>
  );
}
