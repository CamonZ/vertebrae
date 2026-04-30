/**
 * Pure helpers that apply a `TraceFilters` shape uniformly to executions and
 * to merged conversation events. Used by THREAD, FLIGHT-STRIP and CORRIDOR
 * so all three modes narrow consistently from the same filter state.
 */

import type { StepExecution } from "../../bindings";
import type { TraceFilters } from "../../hooks/useTraceFilters";
import type { TaggedConversationEvent } from "../../types/conversation";

export interface FilterContext {
  rootTaskId: string;
}

/** Filter step executions by status / step / model / rootOnly. */
export function filterExecutions(
  executions: readonly StepExecution[],
  filters: TraceFilters,
  ctx: FilterContext
): StepExecution[] {
  return executions.filter((e) => {
    if (filters.status && e.status !== filters.status) return false;
    if (filters.stepName && e.step_name !== filters.stepName) return false;
    if (filters.model && e.model !== filters.model) return false;
    if (filters.rootOnly && e.task_id !== ctx.rootTaskId) return false;
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
