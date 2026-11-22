import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import type { Task, TaskRun } from "../../bindings";
import { taskDetailQueryOptions } from "../../hooks/useTask";
import { queryClient, taskRunsQueryOptions } from "../../query";
import { useChatStore, type ChatSession } from "../../stores/chatStore";
import {
  chatAttentionRecord,
  useChatAttentionStore,
} from "../../stores/chatAttentionStore";
import {
  isRunPane,
  type ChatPane,
  type RunChatPane,
} from "../../stores/chatWorkspace";
import { useProjectScopeGeneration } from "../../stores/projectScopedStores";
import {
  chatAttentionJumpOrder,
  deriveChatAttention,
  type ChatAttention,
} from "../../utils/chatAttention";
import { runAttention, type ChatTabModel } from "./chatTabs";

interface LocalChatStatus {
  id: string;
  sessionId: string;
  title: string;
  attention: ChatAttention;
}

const sameStatus = (a: LocalChatStatus, b: LocalChatStatus) =>
  a.id === b.id &&
  a.sessionId === b.sessionId &&
  a.title === b.title &&
  a.attention.state === b.attention.state &&
  a.attention.reason === b.attention.reason &&
  a.attention.since === b.attention.since;

function localStatus(
  pane: ChatPane,
  session: ChatSession | undefined,
  attention: Parameters<typeof chatAttentionRecord>[0]
): LocalChatStatus[] {
  if (isRunPane(pane) || !session) return [];
  return [
    {
      id: pane.id,
      sessionId: session.id,
      title: session.title?.trim() || session.label,
      attention: deriveChatAttention(
        session,
        chatAttentionRecord(attention, session.id)
      ),
    },
  ];
}

/**
 * Title and attention of each open local chat. The selector keeps the
 * previous array while every field is equal, so streaming text that leaves
 * all states unchanged does not re-render the strip (TSSTORE-002).
 */
function useLocalChatStatuses(order: readonly ChatPane[]) {
  const attention = useChatAttentionStore(
    useShallow((state) => ({
      decisions: state.decisions,
      viewed: state.viewed,
    }))
  );
  const select = useMemo(() => {
    let last: LocalChatStatus[] = [];
    return (state: { sessions: Record<string, ChatSession> }) => {
      const next = order.flatMap((pane) =>
        localStatus(
          pane,
          isRunPane(pane) ? undefined : state.sessions[pane.sessionId],
          attention
        )
      );
      const same =
        next.length === last.length &&
        next.every((status, index) => sameStatus(status, last[index]));
      if (!same) last = next;
      return last;
    };
  }, [order, attention]);
  return useChatStore(select);
}

/** Module-level so TanStack keeps the combined array while results hold. */
function dataOf<T>(results: readonly { data: T | undefined }[]) {
  return results.map((result) => result.data);
}

/** Each run entry's task and run, from the shared query cache. */
function useRunEntries(order: readonly ChatPane[]) {
  const generation = useProjectScopeGeneration();
  const runPanes = useMemo(() => order.filter(isRunPane), [order]);
  const tasks = useQueries(
    {
      queries: runPanes.map((pane) =>
        taskDetailQueryOptions(generation, pane.taskId)
      ),
      combine: dataOf,
    },
    queryClient
  );
  const runs = useQueries(
    {
      queries: runPanes.map((pane) =>
        taskRunsQueryOptions(generation, pane.taskId)
      ),
      combine: dataOf,
    },
    queryClient
  );
  return useMemo(
    () =>
      new Map<string, { task?: Task; run?: TaskRun }>(
        runPanes.map((pane: RunChatPane, index) => [
          pane.id,
          {
            task: tasks[index],
            run: runs[index]?.find((run) => run.id === pane.runId),
          },
        ])
      ),
    [runPanes, tasks, runs]
  );
}

/**
 * Every open chat as the tab strip, switcher and counter read it, in strip
 * order. Runs carry their run status, so a failed run needs the user too.
 */
export function useChatTabs(
  order: readonly ChatPane[],
  projectLabelBySessionId: ReadonlyMap<string, string> | undefined
): ChatTabModel[] {
  const locals = useLocalChatStatuses(order);
  const runs = useRunEntries(order);
  return useMemo(() => {
    const byId = new Map(locals.map((status) => [status.id, status]));
    return order.flatMap((pane): ChatTabModel[] => {
      if (isRunPane(pane)) {
        const { task, run } = runs.get(pane.id) ?? {};
        return [
          {
            id: pane.id,
            title: task?.title ?? pane.taskId.slice(0, 8),
            attention: runAttention(run?.status),
            isRun: true,
            project: null,
          },
        ];
      }
      const status = byId.get(pane.id);
      if (!status) return [];
      return [
        {
          id: pane.id,
          title: status.title,
          attention: status.attention,
          isRun: false,
          project: projectLabelBySessionId?.get(status.sessionId) ?? null,
        },
      ];
    });
  }, [order, locals, runs, projectLabelBySessionId]);
}

/**
 * Open chats needing the user (blocked, error, needs-you; failed runs
 * included) as entry ids in jump order. Its length is the strip counter.
 */
export function chatsNeedingYou(tabs: readonly ChatTabModel[]): string[] {
  return chatAttentionJumpOrder(tabs).map((tab) => tab.id);
}
