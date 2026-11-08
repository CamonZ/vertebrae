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
export function useLocalChatSessionMetadata(group?: LocalChatSessionGroup) {
  const generation = useProjectScopeGeneration();
  const sessions = group?.allSessions ?? group?.sessions ?? [];

  const associatedSessions = group?.projectId ? sessions : [];
  const associatedTaskIds = associatedSessions.map(localChatSessionTaskId);
  const uniqueTaskIds = [...new Set(associatedTaskIds)];
  const taskIds = uniqueTaskIds.filter((id): id is string => id !== null);

  const cachedTasks = useCachedTasks(
    generation,
    group?.isCurrentProject === true
  );
  const direct = useResolvedTasks(taskIds, cachedTasks, generation, group);

  const parentIds = (tasks: ReadonlyMap<string, Task>) => {
    const taskRecords = [...tasks.values()];
    const ids = taskRecords.flatMap((task) =>
      task.parent_id ? [task.parent_id] : []
    );

    return [...new Set(ids)];
  };

  const directParentIds = parentIds(direct);
  const parents = useResolvedTasks(
    directParentIds,
    cachedTasks,
    generation,
    group
  );

  // A task can have a ticket parent and epic grandparent. No new root fetches
  // are needed beyond these two ancestor levels in the entity hierarchy.
  const grandparentIds = parentIds(parents);
  const grandparents = useResolvedTasks(
    grandparentIds,
    cachedTasks,
    generation,
    group
  );
  const tasks = new Map([...direct, ...parents, ...grandparents]);

  const completedTaskRecords = [...tasks.values()].filter(
    (task) => task.completed_at
  );
  const completedTaskIds = completedTaskRecords.map((task) => task.id);
  const completedTasks = new Set(completedTaskIds);

  const completedSessions = sessions.filter((session) => {
    const taskId = localChatSessionTaskId(session);

    return taskId !== null && completedTasks.has(taskId);
  });
  const completedIds = completedSessions.map((session) => session.id);
  const completedSessionIds = new Set(completedIds);

  return { tasks, completedSessionIds };
}

function useResolvedTasks(
  ids: string[],
  cachedTasks: ReadonlyMap<string, Task>,
  generation: number,
  group?: LocalChatSessionGroup
) {
  const missingTaskIds = ids.filter((id) => !cachedTasks.has(id));

  const taskQueries = missingTaskIds.map((id) => {
    const queryKey = group?.isCurrentProject
      ? queryKeys.tasks.detail(generation, id)
      : queryKeys.localChatCompletion(generation, group!.projectId!, id);

    return {
      queryKey,
      queryFn: async () => {
        const baseline = queryClient.getQueryData<Task>(queryKey);

        const request = commands.getTask(id);
        const fetched = await unwrapCommand(request);

        const current = queryClient.getQueryData<Task>(queryKey);

        // A newer realtime projection wins over an in-flight snapshot.
        if (
          current &&
          current !== baseline &&
          (!current.updated_at ||
            !fetched.updated_at ||
            Date.parse(current.updated_at) >= Date.parse(fetched.updated_at))
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
  });

  const queries = useQueries({ queries: taskQueries }, queryClient);

  const cachedRecords = [...cachedTasks].filter(([id]) => ids.includes(id));
  const fetchedRecords = queries.flatMap((query): [string, Task][] =>
    !query.isError && query.data ? [[query.data.id, query.data]] : []
  );

  return new Map([...cachedRecords, ...fetchedRecords]);
}

export function useLocalChatCompletedSessions(group?: LocalChatSessionGroup) {
  const metadata = useLocalChatSessionMetadata(group);

  return metadata.completedSessionIds;
}
