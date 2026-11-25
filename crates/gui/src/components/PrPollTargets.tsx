import { useEffect, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { taskDetailQueryOptions } from "../hooks/useTask";
import { useChatStore } from "../stores/chatStore";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { setWatchedPrWorktrees } from "../stores/worktreePrChecksStore";
import { worktreePrKey } from "../stores/worktreePrStore";
import {
  chatPrTargets,
  isWatchedEntity,
  type ChatPrTarget,
} from "../utils/prPollTargets";

/**
 * Keeps the PR poller watching the worktrees of chats on unfinished
 * tickets, whether or not their chat is open.
 */
export function PrPollTargets() {
  const generation = useProjectScopeGeneration();
  // A string selection keeps the store subscription stable between renders.
  const selected = useChatStore((state) =>
    JSON.stringify(chatPrTargets(state))
  );
  const targets = useMemo(
    () => JSON.parse(selected) as ChatPrTarget[],
    [selected]
  );
  const entityIds = useMemo(
    () => [...new Set(targets.map((target) => target.entityId))],
    [targets]
  );
  const tasks = useQueries({
    queries: entityIds.map((id) => ({
      ...taskDetailQueryOptions(generation, id),
      retry: false,
    })),
    combine: (results) =>
      new Map(
        entityIds.map((id, i) => [
          id,
          { task: results[i]?.data, loading: results[i]?.isPending ?? true },
        ])
      ),
  });
  const watched = targets.filter((target) => {
    const entity = tasks.get(target.entityId);
    return isWatchedEntity(entity?.task, entity?.loading ?? true);
  });
  const signature = watched
    .map((target) => worktreePrKey(target.worktreePath, target.branch))
    .join("\n");

  useEffect(() => {
    setWatchedPrWorktrees(
      watched.map(({ worktreePath, branch }) => ({ worktreePath, branch }))
    );
    // `signature` captures every change to the watched set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(() => () => setWatchedPrWorktrees([]), []);
  return null;
}
