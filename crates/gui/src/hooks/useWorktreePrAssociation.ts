import { useCallback, useEffect, useMemo } from "react";
import { useChatStore } from "../stores/chatStore";
import {
  chatBranchOf,
  chatPrLinkOf,
  newerLink,
  type BranchLink,
} from "../stores/prLinks";
import {
  acceptNewerWorktreePr,
  acquireWorktreePr,
  dismissNewerWorktreePr,
  linkWorktreePr,
  listWorktreeOpenPrs,
  refreshWorktreePr,
  unlinkWorktreePr,
} from "../stores/prSync";
import {
  IDLE_PR_ENTRY,
  associationView,
  isPrBusy,
  useWorktreePrStore,
  worktreePrKey,
} from "../stores/worktreePrStore";

type Sessions = ReturnType<typeof useChatStore.getState>["sessions"];

/** The newest link among the chats on the branch. */
export function branchLinkOf(
  sessions: Sessions,
  worktreePath: string,
  branch: string
): BranchLink {
  let link: BranchLink;
  for (const session of Object.values(sessions)) {
    const at = chatBranchOf(session);
    if (at?.worktreePath === worktreePath && at.branch === branch)
      link = newerLink(link, chatPrLinkOf(session));
  }
  return link;
}

export function useWorktreePrAssociation(
  worktreePath: string | null | undefined,
  branch: string | null | undefined
) {
  const key =
    worktreePath && branch ? worktreePrKey(worktreePath, branch) : null;
  const entry = useWorktreePrStore((state) =>
    key ? (state.entries[key] ?? IDLE_PR_ENTRY) : IDLE_PR_ENTRY
  );
  const link = useChatStore((state) =>
    worktreePath && branch
      ? branchLinkOf(state.sessions, worktreePath, branch)
      : undefined
  );
  const association = useMemo(
    () => (key ? associationView(entry, link) : null),
    [key, entry, link]
  );

  useEffect(
    () =>
      worktreePath && branch
        ? acquireWorktreePr(worktreePath, branch)
        : undefined,
    [worktreePath, branch]
  );

  const at = useCallback(
    <T>(run: (path: string, name: string) => T, otherwise: T) =>
      worktreePath && branch ? run(worktreePath, branch) : otherwise,
    [worktreePath, branch]
  );
  const refresh = useCallback(
    () => at(refreshWorktreePr, Promise.resolve(false)),
    [at]
  );
  const linkPr = useCallback(
    (prNumber: number, repo: string | null) =>
      at(
        (path, name) => linkWorktreePr(path, name, prNumber, repo),
        Promise.resolve(false)
      ),
    [at]
  );
  const unlinkPr = useCallback(
    () => at(unlinkWorktreePr, Promise.resolve(false)),
    [at]
  );
  const acceptNewer = useCallback(
    () => at(acceptNewerWorktreePr, Promise.resolve(false)),
    [at]
  );
  const dismissNewer = useCallback(
    () => at(dismissNewerWorktreePr, undefined),
    [at]
  );
  const listOpenPrs = useCallback(
    () => at(listWorktreeOpenPrs, Promise.resolve([])),
    [at]
  );

  return {
    phase: entry.phase,
    association,
    lookupFailure: entry.lookupFailure,
    error: entry.error,
    newer: entry.newer,
    busy: isPrBusy(entry.phase),
    refresh,
    linkPr,
    unlinkPr,
    acceptNewer,
    dismissNewer,
    listOpenPrs,
  };
}
