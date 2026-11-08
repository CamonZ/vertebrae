import { useMemo, useSyncExternalStore } from "react";
import { useQueries } from "@tanstack/react-query";
import { commands, type Task } from "../bindings";
import { queryClient, queryKeys, unwrapCommand } from "../query";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import {
  localChatSessionTaskId,
  type LocalChatSessionGroup,
} from "../utils/localChatSessionGroups";

/** Observe existing task records without copying list summaries into detail keys. */
function useCachedTasks(generation: number, enabled: boolean) {
  const store = useMemo(() => {
    let snapshot = new Map<string, Task>();
    const prefix = queryKeys.tasks.all(generation);

    return {
      subscribe: (notify: () => void) => {
        if (!enabled) return () => {};

        return queryClient.getQueryCache().subscribe((event) => {
          const key = event.query.queryKey;
          const isTaskQuery = prefix.every(
            (part, index) => key[index] === part
          );

          if (
            isTaskQuery &&
            ["added", "updated", "removed"].includes(event.type)
          ) {
            notify();
          }
        });
      },
      getSnapshot: () => {
        if (!enabled) return snapshot;

        const records = new Map<string, { task: Task; fetchedAt: number }>();
        const remember = (task: Task, fetchedAt: number) => {
          const previous = records.get(task.id);
          const updatedAt = Date.parse(task.updated_at ?? "") || fetchedAt;
          const previousUpdatedAt = previous
            ? Date.parse(previous.task.updated_at ?? "") || previous.fetchedAt
            : -Infinity;

          if (
            updatedAt > previousUpdatedAt ||
            (updatedAt === previousUpdatedAt &&
              fetchedAt >= (previous?.fetchedAt ?? 0))
          ) {
            records.set(task.id, { task, fetchedAt });
          }
        };

        for (const query of queryClient
          .getQueryCache()
          .findAll({ queryKey: prefix })) {
          if (query.state.status === "error") continue;

          const data = query.state.data;
          if (query.queryKey[3] === "list" && Array.isArray(data)) {
            for (const task of data as Task[])
              remember(task, query.state.dataUpdatedAt);
          } else if (query.queryKey[3] === "detail" && data) {
            remember(data as Task, query.state.dataUpdatedAt);
          }
        }

        const next = new Map([...records].map(([id, { task }]) => [id, task]));
        const unchanged =
          next.size === snapshot.size &&
          [...next].every(([id, task]) => snapshot.get(id) === task);

        if (!unchanged) snapshot = next;

        return snapshot;
      },
    };
  }, [generation, enabled]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * Reuse current-project task lists and details before fetching missing records.
 * Cache subscriptions receive realtime completion updates. getTask addresses
 * fallback reads by UUID without changing the selected backend project; polling
 * refreshes other saved projects, whose channels are not subscribed. Missing
 * metadata stays visible.
 */
export function useLocalChatCompletedSessions(group?: LocalChatSessionGroup) {
  const generation = useProjectScopeGeneration();
  const sessions = group?.allSessions ?? group?.sessions ?? [];

  const taskIds = [
    ...new Set((group?.projectId ? sessions : []).map(localChatSessionTaskId)),
  ].filter((id): id is string => id !== null);

  const cachedTasks = useCachedTasks(
    generation,
    group?.isCurrentProject === true
  );
  const missingTaskIds = taskIds.filter((id) => !cachedTasks.has(id));

  const queries = useQueries(
    {
      queries: missingTaskIds.map((id) => {
        const queryKey = group?.isCurrentProject
          ? queryKeys.tasks.detail(generation, id)
          : queryKeys.localChatCompletion(generation, group!.projectId!, id);

        return {
          queryKey,
          queryFn: async () => {
            const baseline = queryClient.getQueryData<Task>(queryKey);

            const fetched = await unwrapCommand(commands.getTask(id));

            const current = queryClient.getQueryData<Task>(queryKey);
            // A newer realtime projection wins over an in-flight snapshot.
            if (
              current &&
              current !== baseline &&
              (!current.updated_at ||
                !fetched.updated_at ||
                Date.parse(current.updated_at) >=
                  Date.parse(fetched.updated_at))
            ) {
              return current;
            }

            return fetched;
          },

          refetchInterval: group?.isCurrentProject ? (false as const) : 30_000,
          // Foreign projects have no live channel; refresh on revisiting them.
          refetchOnMount: group?.isCurrentProject
            ? (false as const)
            : ("always" as const),
        };
      }),
    },
    queryClient
  );

  const completedTasks = new Set([
    ...[...cachedTasks.values()]
      .filter((task) => task.completed_at)
      .map((task) => task.id),
    ...queries.flatMap((query) =>
      !query.isError && query.data?.completed_at ? [query.data.id] : []
    ),
  ]);

  return new Set(
    sessions
      .filter((session) => {
        const taskId = localChatSessionTaskId(session);

        return taskId !== null && completedTasks.has(taskId);
      })
      .map((session) => session.id)
  );
}
