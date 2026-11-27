import type { Ref } from "react";
import {
  PrAssociationBar,
  type PrBarHandle,
} from "../components/ChatWindow/workspace/PrAssociationBar";
import { useWorktreePr } from "../hooks/useWorktreePr";

/** The review bar of one worktree branch, as Changes mounts it. */
export function Bar({
  worktreePath,
  branch,
  handle,
}: {
  worktreePath: string;
  branch: string;
  handle?: Ref<PrBarHandle>;
}) {
  return (
    <PrAssociationBar ref={handle} pr={useWorktreePr(worktreePath, branch)} />
  );
}
