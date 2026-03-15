import { useState, useCallback, useMemo } from "react";
import type { Step, Task, StepExecutionStatus } from "../../bindings";
import { commands } from "../../bindings";
import { useStep, useStepChangeListener, useExpandedNodes } from "../../hooks";
import { DeleteConfirmation } from "../DeleteConfirmation";
import { EditableList } from "../EditableList";
import { ResizablePanel } from "../ResizablePanel";
import { InlineEditField } from "../TaskDetail/InlineEditField";
import { Toggle } from "../Toggle";
import type { ViewMode } from "../TaskList";
import { TaskList, TaskTreeView } from "../TaskList";
import { buildTreeFromTasks } from "../../utils/buildTreeFromTasks";

interface StepDetailPanelProps {
  stepId: string | null;
  allSteps: Step[];
  tasks?: Task[];
  onTaskSelect?: (taskId: string) => void;
  selectedTaskId?: string | null;
  onClose?: () => void;
  onUpdated?: () => void;
  onDeleted?: () => void;
  taskExecutionStates?: Map<string, { status: StepExecutionStatus; stepName: string }>;
  onBack?: () => void;
}

type TabType = "config" | "tasks";

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
  tasks = [],
  onTaskSelect,
  selectedTaskId = null,
  onClose,
  onUpdated,
  onDeleted,
  taskExecutionStates,
  onBack,
}: StepDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>("config");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("tree");

  // Fetch step data and listen for changes
  const { step, refetch } = useStep(stepId);

  // Use expanded nodes hook for task tree
  const expandedNodes = useExpandedNodes();

  // Build task hierarchy
  const taskHierarchy = useMemo(() => {
    const filtered = search
      ? tasks.filter(
          (t) =>
            t.title.toLowerCase().includes(search.toLowerCase()) ||
            t.id.toLowerCase().includes(search.toLowerCase())
        )
      : tasks;
    return buildTreeFromTasks(filtered);
  }, [tasks, search]);

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
      prompt?: string | null;
      eval_prompt?: string | null;
      agents?: string[];
      skills?: string[];
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
        eval_prompt: updates.eval_prompt ?? null,
        agents: updates.agents ?? null,
        skills: updates.skills ?? null,
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

  // Render tab bar button
  function TabButton({ tab, label }: { tab: TabType; label: string }) {
    const isActive = activeTab === tab;
    return (
      <button
        type="button"
        onClick={() => setActiveTab(tab)}
        className={`flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors ${
          isActive
            ? "border-b-2 border-primary text-primary"
            : "border-b-2 border-transparent text-text-muted hover:text-text-primary"
        }`}
      >
        {label}
        {tab === "tasks" && (
          <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary/20 px-2 py-0.5 text-xs font-semibold text-primary">
            {tasks.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <ResizablePanel
      storageKey="step-detail-panel-width"
      glowColor="from-info/0 via-info/30 to-info/0"
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
            Step Configuration
          </h2>
        </div>
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

      {/* Tab bar */}
      <div className="border-b border-border px-4">
        <div className="flex gap-1">
          <TabButton tab="config" label="Configuration" />
          <TabButton tab="tasks" label="Tasks" />
        </div>
      </div>

      {/* Delete error */}
      {deleteError && (
        <div className="border-b border-border px-4 py-3 bg-error/5">
          <p className="text-xs text-error">{deleteError}</p>
        </div>
      )}

      {/* Configuration Tab Content */}
      {activeTab === "config" && (
        <>
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

            {/* Prompt - inline editable */}
            <div className="mt-3">
              <SectionHeader title="Prompt" />
              <InlineEditField
                value={step.prompt || ""}
                placeholder="Click to add prompt..."
                multiline
                rows={4}
                onSave={async (value) => {
                  await handleUpdateField({ prompt: value || null });
                }}
              />
            </div>

            {/* Eval Prompt - inline editable with warning styling */}
            <div className="mt-3">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-warning">
                Eval Prompt
              </h3>
              <InlineEditField
                value={step.eval_prompt || ""}
                placeholder="Click to add eval prompt..."
                multiline
                rows={4}
                onSave={async (value) => {
                  await handleUpdateField({ eval_prompt: value || null });
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
        </>
      )}

      {/* Tasks Tab Content */}
      {activeTab === "tasks" && (
        <>
          {/* Search and view toggle */}
          <div className="border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              {/* Search input */}
              <div className="relative flex-1 min-w-0">
                <input
                  type="text"
                  placeholder="Search..."
                  value={search ?? ""}
                  onChange={(e) =>
                    setSearch(e.target.value || null)
                  }
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 pl-7 text-xs text-text-primary placeholder:text-text-muted transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  aria-label="Search tasks"
                />
                <svg
                  className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>

              {/* View mode toggle */}
              <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/50 p-0.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setViewMode("tree")}
                  className={`flex items-center rounded-md px-2 py-1 text-xs font-medium transition-all ${
                    viewMode === "tree"
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                  aria-label="Tree view"
                  aria-pressed={viewMode === "tree"}
                >
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={`flex items-center rounded-md px-2 py-1 text-xs font-medium transition-all ${
                    viewMode === "list"
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                  aria-label="List view"
                  aria-pressed={viewMode === "list"}
                >
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M4 6h16M4 10h16M4 14h16M4 18h16"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* Task list/tree section */}
          <div className="flex-1 overflow-auto">
            {tasks.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-text-muted">No tasks assigned to this step</p>
              </div>
            ) : viewMode === "tree" ? (
              <TaskTreeView
                hierarchy={taskHierarchy}
                isLoading={false}
                error={null}
                selectedTaskId={selectedTaskId}
                onTaskSelect={(task) => onTaskSelect?.(task.id)}
                expandedNodes={expandedNodes}
                hideStatus
                taskExecutionStates={taskExecutionStates}
              />
            ) : (
              <TaskList
                tasks={tasks}
                isLoading={false}
                error={null}
                selectedTaskId={selectedTaskId}
                onTaskSelect={(task) => onTaskSelect?.(task.id)}
                hideStatus
                taskExecutionStates={taskExecutionStates}
              />
            )}
          </div>
        </>
      )}
    </ResizablePanel>
  );
}
