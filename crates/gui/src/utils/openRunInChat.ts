import type { StepExecution, TaskRun } from "../bindings";
import { queryClient, taskRunsQueryOptions } from "../query";
import { sortRunsNewestFirst, selectActiveTaskRun } from "../hooks/useTaskRuns";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { useChatStore } from "../stores/chatStore";
import { useShellStore } from "../stores/shellStore";

export interface RunInChatTarget {
  taskId: string;
  runId: string;
  /** Scroll the run pane to this thread (a step execution or subagent id). */
  threadId?: string | null;
}

/** Open a TaskRun as a read-only pane in the maximized chat panel. */
export function openRunInChat({ taskId, runId, threadId }: RunInChatTarget) {
  useShellStore.getState().setChatPanelPresentation("expanded");
  return useChatStore
    .getState()
    .openRunPane({ taskId, runId }, { scrollToThreadId: threadId ?? null });
}

/**
 * Pick the run a task's "open in chat" entry shows: its active run, else its
 * newest run, else the newest run in its subtree (from loaded executions).
 */
export async function resolveTaskRunTarget(
  taskId: string,
  subtreeExecutions: readonly StepExecution[] = []
): Promise<RunInChatTarget | null> {
  const runs = await queryClient.fetchQuery<TaskRun[]>({
    ...taskRunsQueryOptions(getProjectScopeGeneration(), taskId),
    staleTime: 0,
  });
  const own = selectActiveTaskRun(runs) ?? sortRunsNewestFirst(runs)[0];
  if (own) return { taskId, runId: own.id };

  const newest = [...subtreeExecutions]
    .filter((execution) => execution.task_run_id && execution.task_id)
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0];
  return newest
    ? { taskId: newest.task_id!, runId: newest.task_run_id! }
    : null;
}
