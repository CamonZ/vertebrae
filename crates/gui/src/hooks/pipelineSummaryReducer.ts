import type {
  PipelineStep,
  PipelineSummary,
  PipelineWorkflow,
  PipelineWorkflowTransition,
  Step,
  StepTransitionChangedEvent,
  TaskChangedEvent,
  TaskLevel,
  TaskRunStepChangedEvent,
  TaskStepChangedEvent,
  Workflow,
  WorkflowTransitionChangedEvent,
} from "../bindings";
import { isActiveRunStatus } from "../utils/runState";

export const PIPELINE_LEVELS: readonly TaskLevel[] = ["epic", "ticket", "task"];

/**
 * Apply a delta to a single `(step_id, level)` bucket, plus an active-run
 * delta to that step. Returns a new `PipelineSummary` with only the touched
 * workflow + step cloned (structural sharing), or `null` if the step was not
 * found or both deltas were zero.
 */
function applyStepDelta(
  summary: PipelineSummary,
  stepId: string,
  level: TaskLevel,
  taskDelta: number,
  activeDelta: number,
): PipelineSummary | null {
  if (taskDelta === 0 && activeDelta === 0) return null;

  for (let wi = 0; wi < summary.workflows.length; wi++) {
    const wf = summary.workflows[wi];
    for (let si = 0; si < wf.workflow_steps.length; si++) {
      const step = wf.workflow_steps[si];
      if (step.id !== stepId) continue;

      const nextStep: PipelineStep = {
        ...step,
        task_counts: {
          ...step.task_counts,
          [level]: Math.max(0, step.task_counts[level] + taskDelta),
        },
        pipeline_counts: {
          ...step.pipeline_counts,
          [level]: Math.max(0, step.pipeline_counts[level] + taskDelta),
          active: Math.max(0, step.pipeline_counts.active + activeDelta),
        },
        active_count: Math.max(0, step.active_count + activeDelta),
      };

      const nextSteps = wf.workflow_steps.slice();
      nextSteps[si] = nextStep;
      const nextWorkflows = summary.workflows.slice();
      nextWorkflows[wi] = { ...wf, workflow_steps: nextSteps };
      return { ...summary, workflows: nextWorkflows };
    }
  }
  return null;
}

/**
 * `task_created`: bump the step bucket by +1 if the task is placed on a step
 * and not archived.
 */
export function applyTaskCreated(
  summary: PipelineSummary,
  task: { current_step_id: string | null; level: TaskLevel | null; archived?: boolean | null },
): PipelineSummary {
  const { current_step_id, level } = task;
  const archived = task.archived ?? false;
  if (!current_step_id || !level || archived) return summary;
  const next = applyStepDelta(summary, current_step_id, level, +1, 0);
  return next ?? summary;
}

/**
 * Apply archive and level changes from Sacrum's sparse before-image bucket
 * identity. Dedicated step-change events remain the sole owners of step
 * movement so the entity projection and semantic delta cannot double-count.
 */
export function applyTaskUpdated(
  summary: PipelineSummary,
  event: TaskChangedEvent,
): PipelineSummary {
  const { task, previous } = event;
  if (!task || !previous) return summary;

  const stepId = task.current_step_id;
  const beforeLevel =
    previous.level === undefined ? task.level : previous.level;
  const beforeArchived = previous.archived ?? task.archived ?? false;
  const afterLevel = task.level;
  const afterArchived = task.archived ?? false;

  if (beforeLevel === afterLevel && beforeArchived === afterArchived) {
    return summary;
  }

  let current = summary;
  if (stepId && beforeLevel && !beforeArchived) {
    current =
      applyStepDelta(current, stepId, beforeLevel, -1, 0) ?? current;
  }
  if (stepId && afterLevel && !afterArchived) {
    current = applyStepDelta(current, stepId, afterLevel, +1, 0) ?? current;
  }
  return current;
}

/**
 * `task_deleted`: Sacrum's tombstone carries the before-image fields needed
 * to identify the bucket. If the task was off-step or archived at deletion
 * time, there is nothing to decrement.
 */
export function applyTaskDeleted(
  summary: PipelineSummary,
  event: TaskChangedEvent,
): PipelineSummary {
  const { current_step_id, level, archived } = event;
  if (!current_step_id || !level || archived) return summary;
  const next = applyStepDelta(summary, current_step_id, level, -1, 0);
  return next ?? summary;
}

/**
 * `task_step_changed`: a manual (agent-driven) move. Decrement the `from`
 * bucket, increment the `to` bucket.
 *
 * Disjoint from `task_run_step_changed`: this event only fires when no run
 * is active on the task.
 */
export function applyTaskStepChanged(
  summary: PipelineSummary,
  event: TaskStepChangedEvent,
): PipelineSummary {
  const { from_step_id, to_step_id, level } = event;
  let current = summary;

  if (from_step_id) {
    const next = applyStepDelta(current, from_step_id, level, -1, 0);
    if (next) current = next;
  }
  if (to_step_id) {
    const next = applyStepDelta(current, to_step_id, level, +1, 0);
    if (next) current = next;
  }

  return current;
}

/**
 * `task_run_step_changed`: an orchestrator-driven step transition, carrying
 * the run's status. Applies move semantics (-1 from / +1 to) AND an active
 * count delta on the destination based on whether the run status is active.
 *
 * Run-end shape (`to_step_id == null`): the task itself stays at
 * `from_step_id`; only the active count decrements (we never -1 the task
 * count on run end).
 */
export function applyTaskRunStepChanged(
  summary: PipelineSummary,
  event: TaskRunStepChangedEvent,
): PipelineSummary {
  const { from_step_id, to_step_id, status, level } = event;
  let current = summary;

  if (from_step_id && !to_step_id) {
    const next = applyStepDelta(current, from_step_id, level, 0, -1);
    return next ?? current;
  }

  if (from_step_id) {
    const next = applyStepDelta(current, from_step_id, level, -1, -1);
    if (next) current = next;
  }
  if (to_step_id) {
    const activeDelta = isActiveRunStatus(status) ? 1 : 0;
    const next = applyStepDelta(current, to_step_id, level, +1, activeDelta);
    if (next) current = next;
  }

  return current;
}

// ---------------------------------------------------------------------------
// Topology reducers
// ---------------------------------------------------------------------------

function insertSorted<T>(
  items: readonly T[],
  next: T,
  keyOf: (item: T) => number,
): T[] {
  const out = items.slice();
  const key = keyOf(next);
  let i = 0;
  while (i < out.length && keyOf(out[i]) <= key) i++;
  out.splice(i, 0, next);
  return out;
}

function pipelineWorkflowFromWorkflow(workflow: Workflow): PipelineWorkflow {
  return {
    id: workflow.id ?? "",
    name: workflow.name,
    description: workflow.description ?? null,
    initial_step_id: workflow.initial_step ?? null,
    kanban_column: workflow.kanban_column ?? null,
    factory_name: workflow.factory_name ?? null,
    is_default: workflow.is_default ?? false,
    display_order: workflow.display_order ?? 0,
    workflow_steps: [],
    transitions: [],
  };
}

function pipelineStepFromStep(step: Step): PipelineStep {
  return {
    id: step.id ?? "",
    name: step.name,
    workflow_id: step.workflow_id,
    goal: step.goal ?? null,
    step_order: step.order ?? 0,
    step_type:
      typeof step.step_type === "string" ? step.step_type : null,
    transitions_to: step.transitions_to ?? [],
    task_counts: { epic: 0, ticket: 0, task: 0 },
    pipeline_counts: { epic: 0, ticket: 0, task: 0, active: 0 },
    active_count: 0,
  };
}

export function applyWorkflowCreated(
  summary: PipelineSummary,
  workflow: Workflow,
): PipelineSummary {
  const id = workflow.id;
  if (!id) return summary;
  if (summary.workflows.some((wf) => wf.id === id)) return summary;
  const next = pipelineWorkflowFromWorkflow(workflow);
  return {
    ...summary,
    workflows: insertSorted(
      summary.workflows,
      next,
      (wf) => wf.display_order,
    ),
  };
}

export function applyWorkflowUpdated(
  summary: PipelineSummary,
  workflow: Workflow,
): PipelineSummary {
  const id = workflow.id;
  if (!id) return summary;
  const idx = summary.workflows.findIndex((wf) => wf.id === id);
  if (idx < 0) return applyWorkflowCreated(summary, workflow);

  const existing = summary.workflows[idx];
  const updated: PipelineWorkflow = {
    ...existing,
    name: workflow.name,
    description: workflow.description ?? null,
    initial_step_id: workflow.initial_step ?? null,
    kanban_column: workflow.kanban_column ?? null,
    factory_name: workflow.factory_name,
    is_default: workflow.is_default ?? existing.is_default,
    display_order: workflow.display_order ?? existing.display_order,
  };

  // Drop existing position so the sorted insert reinserts in the right slot
  // when `display_order` changed.
  const without = summary.workflows.slice();
  without.splice(idx, 1);
  return {
    ...summary,
    workflows: insertSorted(without, updated, (wf) => wf.display_order),
  };
}

export function applyWorkflowDeleted(
  summary: PipelineSummary,
  workflowId: string,
): PipelineSummary {
  const idx = summary.workflows.findIndex((wf) => wf.id === workflowId);
  if (idx < 0) return summary;
  const without = summary.workflows.slice();
  without.splice(idx, 1);
  return { ...summary, workflows: without };
}

export function applyStepCreated(
  summary: PipelineSummary,
  step: Step,
): PipelineSummary {
  const stepId = step.id;
  if (!stepId) return summary;
  const wfIdx = summary.workflows.findIndex(
    (wf) => wf.id === step.workflow_id,
  );
  if (wfIdx < 0) return summary;
  const wf = summary.workflows[wfIdx];
  if (wf.workflow_steps.some((s) => s.id === stepId)) return summary;

  const nextStep = pipelineStepFromStep(step);
  const nextSteps = insertSorted(
    wf.workflow_steps,
    nextStep,
    (s) => s.step_order,
  );
  const nextWorkflows = summary.workflows.slice();
  nextWorkflows[wfIdx] = { ...wf, workflow_steps: nextSteps };
  return { ...summary, workflows: nextWorkflows };
}

export function applyStepUpdated(
  summary: PipelineSummary,
  step: Step,
): PipelineSummary {
  const stepId = step.id;
  if (!stepId) return summary;
  for (let wi = 0; wi < summary.workflows.length; wi++) {
    const wf = summary.workflows[wi];
    const si = wf.workflow_steps.findIndex((s) => s.id === stepId);
    if (si < 0) continue;

    const existing = wf.workflow_steps[si];
    const updated: PipelineStep = {
      ...existing,
      name: step.name,
      goal: step.goal ?? null,
      step_order: step.order ?? existing.step_order,
      step_type:
        typeof step.step_type === "string" ? step.step_type : existing.step_type,
      // Counts are preserved — they live in `pipeline_summary.workflow_steps`
      // and aren't carried by the Step payload.
    };

    const without = wf.workflow_steps.slice();
    without.splice(si, 1);
    const nextSteps = insertSorted(without, updated, (s) => s.step_order);
    const nextWorkflows = summary.workflows.slice();
    nextWorkflows[wi] = { ...wf, workflow_steps: nextSteps };
    return { ...summary, workflows: nextWorkflows };
  }
  return summary;
}

export function applyStepDeleted(
  summary: PipelineSummary,
  stepId: string,
  workflowId: string,
): PipelineSummary {
  const wfIdx = summary.workflows.findIndex((wf) => wf.id === workflowId);
  if (wfIdx < 0) return summary;
  const wf = summary.workflows[wfIdx];
  const si = wf.workflow_steps.findIndex((s) => s.id === stepId);
  if (si < 0) return summary;

  const nextSteps = wf.workflow_steps
    .filter((s) => s.id !== stepId)
    .map((s) =>
      s.transitions_to.includes(stepId)
        ? { ...s, transitions_to: s.transitions_to.filter((id) => id !== stepId) }
        : s,
    );
  const nextWorkflows = summary.workflows.slice();
  nextWorkflows[wfIdx] = { ...wf, workflow_steps: nextSteps };
  return { ...summary, workflows: nextWorkflows };
}

function mutateStepTransitionsTo(
  summary: PipelineSummary,
  fromStepId: string,
  apply: (current: string[]) => string[],
): PipelineSummary | null {
  for (let wi = 0; wi < summary.workflows.length; wi++) {
    const wf = summary.workflows[wi];
    const si = wf.workflow_steps.findIndex((s) => s.id === fromStepId);
    if (si < 0) continue;
    const step = wf.workflow_steps[si];
    const nextTransitions = apply(step.transitions_to);
    if (nextTransitions === step.transitions_to) return null;
    const nextSteps = wf.workflow_steps.slice();
    nextSteps[si] = { ...step, transitions_to: nextTransitions };
    const nextWorkflows = summary.workflows.slice();
    nextWorkflows[wi] = { ...wf, workflow_steps: nextSteps };
    return { ...summary, workflows: nextWorkflows };
  }
  return null;
}

export function applyStepTransitionCreated(
  summary: PipelineSummary,
  event: StepTransitionChangedEvent,
): PipelineSummary {
  const { from_step_id, to_step_id } = event;
  if (!from_step_id || !to_step_id) return summary;

  const next = mutateStepTransitionsTo(summary, from_step_id, (current) =>
    current.includes(to_step_id) ? current : [...current, to_step_id],
  );
  return next ?? summary;
}

export function applyStepTransitionDeleted(
  summary: PipelineSummary,
  event: StepTransitionChangedEvent,
): PipelineSummary {
  const { from_step_id, to_step_id } = event;
  if (!from_step_id || !to_step_id) return summary;

  const next = mutateStepTransitionsTo(summary, from_step_id, (current) =>
    current.includes(to_step_id)
      ? current.filter((id) => id !== to_step_id)
      : current,
  );
  return next ?? summary;
}

export function applyWorkflowTransitionCreated(
  summary: PipelineSummary,
  event: WorkflowTransitionChangedEvent,
): PipelineSummary {
  const {
    transition_id,
    from_workflow_id,
    to_workflow_id,
    target_step_id,
    label,
  } = event;
  if (!from_workflow_id || !to_workflow_id) return summary;

  const wfIdx = summary.workflows.findIndex((wf) => wf.id === from_workflow_id);
  if (wfIdx < 0) return summary;
  const wf = summary.workflows[wfIdx];
  if (wf.transitions.some((t) => t.id === transition_id)) return summary;

  const nextTransition: PipelineWorkflowTransition = {
    id: transition_id,
    from_workflow_id,
    to_workflow_id,
    target_step_id: target_step_id ?? null,
    label: label ?? "",
  };

  const nextWorkflows = summary.workflows.slice();
  nextWorkflows[wfIdx] = {
    ...wf,
    transitions: [...wf.transitions, nextTransition],
  };
  return { ...summary, workflows: nextWorkflows };
}

export function applyWorkflowTransitionDeleted(
  summary: PipelineSummary,
  event: WorkflowTransitionChangedEvent,
): PipelineSummary {
  const { transition_id, from_workflow_id } = event;
  // When `from_workflow_id` is available we know exactly where to look. If
  // not, scan all workflows for the transition id.
  if (from_workflow_id) {
    const wfIdx = summary.workflows.findIndex(
      (wf) => wf.id === from_workflow_id,
    );
    if (wfIdx < 0) return summary;
    const wf = summary.workflows[wfIdx];
    const idx = wf.transitions.findIndex((t) => t.id === transition_id);
    if (idx < 0) return summary;
    const nextTransitions = wf.transitions.slice();
    nextTransitions.splice(idx, 1);
    const nextWorkflows = summary.workflows.slice();
    nextWorkflows[wfIdx] = { ...wf, transitions: nextTransitions };
    return { ...summary, workflows: nextWorkflows };
  }

  for (let wi = 0; wi < summary.workflows.length; wi++) {
    const wf = summary.workflows[wi];
    const idx = wf.transitions.findIndex((t) => t.id === transition_id);
    if (idx < 0) continue;
    const nextTransitions = wf.transitions.slice();
    nextTransitions.splice(idx, 1);
    const nextWorkflows = summary.workflows.slice();
    nextWorkflows[wi] = { ...wf, transitions: nextTransitions };
    return { ...summary, workflows: nextWorkflows };
  }
  return summary;
}
