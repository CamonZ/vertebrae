import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { commands, events } from "../bindings";
import { queryClient } from "../query";
import { queryKeys } from "../query/queryKeys";
import { useChatStore } from "../stores/chatStore";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  hydrateLocalChatSessionIndex,
  normalizeProjectPath,
} from "../utils/localChatPersistence";
import { localChatSessionTaskId } from "../utils/localChatSessionGroups";

const EMPTY_IDS: ReadonlySet<string> = new Set();

export interface LocalChatProjectHistoryView {
  /** Rows hidden from the selected project's history. */
  excludedIds: ReadonlySet<string>;
  /** Shown rows linked to completed tasks (only while completed are included). */
  completedIds: ReadonlySet<string>;
  isError: boolean;
  isFetching: boolean;
  retry: () => void;
}

/**
 * The selected project's chat history filter. Cached exclusions from the last
 * read hide completed chats until the visible project's read returns.
 */
export function useLocalChatProjectHistory({
  projectId,
  projectPath,
  visible,
  includeCompleted,
}: {
  projectId: string | null;
  projectPath: string | null;
  visible: boolean;
  includeCompleted: boolean;
}): LocalChatProjectHistoryView {
  const generation = useProjectScopeGeneration();
  const enabled = visible && !!projectId;

  const cached = useQuery(
    {
      queryKey: queryKeys.localChatProjectHistory.cachedExclusions(
        generation,
        projectId ?? ""
      ),
      enabled,
      staleTime: Infinity,
      gcTime: Infinity,
      queryFn: async () => {
        const result = await commands.loadCachedLocalChatProjectExclusions(
          projectId!
        );
        return result.status === "ok" ? new Set(result.data) : EMPTY_IDS;
      },
    },
    queryClient
  );

  const historyQuery = (completed: boolean) => ({
    queryKey: queryKeys.localChatProjectHistory.read(
      generation,
      projectId ?? "",
      completed
    ),
    staleTime: 0,
    // Reopening the sidebar keeps the last read while the next one runs.
    gcTime: Infinity,
    queryFn: () => readProjectHistory(generation, projectId!, completed),
  });
  // The active-only read also marks completed rows while they are shown.
  const active = useQuery({ ...historyQuery(false), enabled }, queryClient);
  const full = useQuery(
    { ...historyQuery(true), enabled: enabled && includeCompleted },
    queryClient
  );

  const activeExcluded = active.data ?? cached.data ?? EMPTY_IDS;
  const excludedIds = includeCompleted
    ? (full.data ?? activeExcluded)
    : activeExcluded;
  const completedIds = useMemo(
    () =>
      includeCompleted && full.data
        ? new Set([...activeExcluded].filter((id) => !full.data.has(id)))
        : EMPTY_IDS,
    [includeCompleted, full.data, activeExcluded]
  );
  const shown = includeCompleted ? full : active;
  const refetchShown = shown.refetch;
  const retry = useCallback(() => void refetchShown(), [refetchShown]);

  useEffect(() => {
    if (!projectId || !visible) return;
    const reads = queryKeys.localChatProjectHistory.reads(generation, projectId);
    const activeKey = queryKeys.localChatProjectHistory.read(
      generation,
      projectId,
      false
    );
    const cachedKey = queryKeys.localChatProjectHistory.cachedExclusions(
      generation,
      projectId
    );

    let disposed = false;
    let running = false;
    let dirty = false;
    // Coalesce bursts into at most one queued read. A read already in flight
    // may predate the change, so it is joined and then followed by a new read.
    const refresh = async () => {
      dirty = true;
      if (running) return;
      running = true;
      try {
        while (dirty && !disposed) {
          dirty = false;
          const stale = queryClient.isFetching({ queryKey: reads }) > 0;
          await queryClient.invalidateQueries(
            { queryKey: reads },
            { cancelRefetch: false }
          );
          if (stale && !disposed)
            await queryClient.invalidateQueries(
              { queryKey: reads },
              { cancelRefetch: false }
            );
        }
      } finally {
        running = false;
      }
    };

    const subscriptions = [
      listen<string>("websocket-state-changed", ({ payload }) => {
        if (payload === "connected") void refresh();
      }),
      events.taskChangedEvent.listen(({ payload }) => {
        const task = payload.task;
        if (!task || disposed) return;
        const hidden =
          queryClient.getQueryData<ReadonlySet<string>>(activeKey) ??
          queryClient.getQueryData<ReadonlySet<string>>(cachedKey);
        const stale = Object.values(
          useChatStore.getState().localSessionSummaries
        ).some(
          (session) =>
            normalizeProjectPath(session.projectPath) === projectPath &&
            localChatSessionTaskId(session) === payload.task_id &&
            (hidden?.has(session.id) ?? false) !== (task.completed_at !== null)
        );
        if (stale) void refresh();
      }),
    ].map((subscription) =>
      subscription.catch(() => {
        console.warn("[LocalChatProjectHistory] listener_failed");
        return () => {};
      })
    );

    return () => {
      disposed = true;
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten());
    };
  }, [generation, projectId, projectPath, visible]);

  return {
    excludedIds,
    completedIds,
    isError: shown.isError,
    isFetching: shown.isFetching,
    retry,
  };
}

async function readProjectHistory(
  generation: number,
  projectId: string,
  includeCompleted: boolean
): Promise<ReadonlySet<string>> {
  await hydrateLocalChatSessionIndex();
  const before = useChatStore.getState().localSessionSummaries;
  const result = await commands.loadLocalChatProjectHistory(
    projectId,
    includeCompleted
  );
  if (result.status !== "ok")
    throw new Error("Could not load project chat history");
  if (isCurrentProjectScopeGeneration(generation)) {
    const store = useChatStore.getState();
    // A newer incremental update or local edit wins over this read.
    store.applyCatalogEntries(
      result.data.sessions
        .filter(
          (session) =>
            store.localSessionSummaries[session.id] === before[session.id]
        )
        .map((session) => ({ id: session.id, session }))
    );
  }
  return new Set(result.data.excludedIds);
}
