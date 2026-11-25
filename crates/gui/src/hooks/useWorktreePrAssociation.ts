import { useCallback, useEffect } from "react";
import {
  IDLE_PR_ENTRY,
  acquireWorktreePr,
  isPrBusy,
  linkWorktreePr,
  listWorktreeOpenPrs,
  refreshWorktreePr,
  unlinkWorktreePr,
  useWorktreePrStore,
  worktreePrKey,
} from "../stores/worktreePrStore";

export function useWorktreePrAssociation(
  worktreePath: string | null | undefined,
  branch: string | null | undefined
) {
  const key =
    worktreePath && branch ? worktreePrKey(worktreePath, branch) : null;
  const entry = useWorktreePrStore((state) =>
    key ? (state.entries[key] ?? IDLE_PR_ENTRY) : IDLE_PR_ENTRY
  );

  useEffect(
    () =>
      worktreePath && branch
        ? acquireWorktreePr(worktreePath, branch)
        : undefined,
    [worktreePath, branch]
  );

  const refresh = useCallback(
    () =>
      worktreePath && branch
        ? refreshWorktreePr(worktreePath, branch)
        : Promise.resolve(false),
    [worktreePath, branch]
  );
  const linkPr = useCallback(
    (prNumber: number, repo: string | null) =>
      worktreePath && branch
        ? linkWorktreePr(worktreePath, branch, prNumber, repo)
        : Promise.resolve(false),
    [worktreePath, branch]
  );
  const unlinkPr = useCallback(
    () =>
      worktreePath && branch
        ? unlinkWorktreePr(worktreePath, branch)
        : Promise.resolve(false),
    [worktreePath, branch]
  );
  const listOpenPrs = useCallback(
    () =>
      worktreePath && branch
        ? listWorktreeOpenPrs(worktreePath, branch)
        : Promise.resolve([]),
    [worktreePath, branch]
  );

  return {
    ...entry,
    busy: isPrBusy(entry.phase),
    refresh,
    linkPr,
    unlinkPr,
    listOpenPrs,
  };
}
