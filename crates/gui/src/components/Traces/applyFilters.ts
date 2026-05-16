/**
 * Pure helpers that apply a `TraceFilters` shape uniformly to executions and
 * to merged conversation events. Used by THREAD, FLIGHT-STRIP and CORRIDOR
 * so all three modes narrow consistently from the same filter state.
 */

import type { StepExecution, TaskRun } from "../../bindings";
import type { TraceFilters } from "../../hooks/useTraceFilters";
import type { TraceLineageScope } from "../../hooks/useTraceFilters";
import type { TaggedConversationEvent } from "../../types/conversation";

export interface FilterContext {
  rootTaskId: string;
  scopedRunIds?: ReadonlySet<string> | null;
}

export function defaultLineageScopeForRun(
  selectedRun: TaskRun | null | undefined
): TraceLineageScope {
  if (!selectedRun) return "lineage";
  const rootRunId = selectedRun.root_task_run_id ?? selectedRun.id;
  const hasParentLineage =
    selectedRun.parent_task_run_id !== null || rootRunId !== selectedRun.id;
  return hasParentLineage ? "descendants" : "lineage";
}

export function resolveLineageScope(
  filters: Pick<TraceFilters, "lineageScope">,
  selectedRun: TaskRun | null | undefined
): TraceLineageScope {
  return filters.lineageScope ?? defaultLineageScopeForRun(selectedRun);
}

export function scopedRunIdsForLineage(
  runs: readonly TaskRun[],
  selectedRunId: string | null,
  scope: TraceLineageScope
): ReadonlySet<string> | null {
  if (scope === "lineage" || !selectedRunId) return null;
  if (scope === "selected") return new Set([selectedRunId]);

  const childrenByParent = new Map<string, TaskRun[]>();
  for (const run of runs) {
    const parentId = run.parent_task_run_id;
    if (!parentId) continue;
    const children = childrenByParent.get(parentId);
    if (children) children.push(run);
    else childrenByParent.set(parentId, [run]);
  }

  const ids = new Set<string>([selectedRunId]);
  const pending = [...(childrenByParent.get(selectedRunId) ?? [])];
  while (pending.length > 0) {
    const run = pending.pop()!;
    if (ids.has(run.id)) continue;
    ids.add(run.id);
    const children = childrenByParent.get(run.id);
    if (children) {
      pending.push(...children);
    }
  }
  return ids;
}

/** Filter step executions by status / step / model / rootOnly. */
export function filterExecutions(
  executions: readonly StepExecution[],
  filters: TraceFilters,
  ctx: FilterContext
): StepExecution[] {
  const seenExecutionIds = new Set<string>();
  return executions.filter((e) => {
    if (filters.status && e.status !== filters.status) return false;
    if (filters.stepName && e.step_name !== filters.stepName) return false;
    if (filters.model && e.model !== filters.model) return false;
    const taskRunId = e.task_run_id ?? null;
    if (ctx.scopedRunIds && (!taskRunId || !ctx.scopedRunIds.has(taskRunId))) {
      return false;
    }
    if (filters.rootOnly && e.task_id !== ctx.rootTaskId) return false;
    if (e.id) {
      if (seenExecutionIds.has(e.id)) return false;
      seenExecutionIds.add(e.id);
    }
    return true;
  });
}

/** Determine if the given tagged event matches the current free-text search. */
export function matchesSearch(
  tagged: TaggedConversationEvent,
  search: string
): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  const ev = tagged.event;
  switch (ev.kind) {
    case "thinking":
      return ev.text.toLowerCase().includes(needle);
    case "tool_call":
      return (
        ev.toolName.toLowerCase().includes(needle) ||
        ev.summary.toLowerCase().includes(needle) ||
        JSON.stringify(ev.input).toLowerCase().includes(needle)
      );
    case "tool_result":
      return ev.result.toLowerCase().includes(needle);
    case "session_start":
      return ev.model.toLowerCase().includes(needle);
    case "session_end":
      return false;
    default:
      return false;
  }
}

/** Filter tagged events by all relevant filter axes. */
export function filterTaggedEvents(
  events: readonly TaggedConversationEvent[],
  filters: TraceFilters,
  executionIds: ReadonlySet<string>
): TaggedConversationEvent[] {
  return events.filter((t) => {
    if (!executionIds.has(t.executionId)) return false;
    if (filters.search && !matchesSearch(t, filters.search)) return false;
    return true;
  });
}
