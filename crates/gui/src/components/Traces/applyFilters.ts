/**
 * Pure helpers that apply a `TraceFilters` shape to executions and to merged
 * conversation events. Under the SINGLE-RUN model there is no cross-run
 * lineage, so the previous lineage-scope machinery is gone — filters narrow
 * the one run's executions/events directly.
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
  const seenExecutionIds = new Set<string>();
  return executions.filter((e) => {
    if (filters.status && e.status !== filters.status) return false;
    if (filters.stepName && e.step_name !== filters.stepName) return false;
    if (filters.model && e.model !== filters.model) return false;
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
    case "task_progress":
    case "task_started":
      return (
        ev.description.toLowerCase().includes(needle) ||
        (ev.subagentType ?? "").toLowerCase().includes(needle)
      );
    case "task_notification":
      return ev.message.toLowerCase().includes(needle);
    case "rate_limit":
      return (
        (ev.status ?? "").toLowerCase().includes(needle) ||
        (ev.rateLimitType ?? "").toLowerCase().includes(needle)
      );
    case "thinking_heartbeat":
      return String(ev.estimatedTokens).includes(needle);
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
