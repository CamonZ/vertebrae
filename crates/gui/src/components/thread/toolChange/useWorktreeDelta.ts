import { useContext, useMemo } from "react";
import { useToolAnnotation } from "../../../hooks/useToolAnnotation";
import { ChatSessionContext } from "./ChatSessionContext";
import { parseWorktreeDelta, type WorktreeDelta } from "./worktreeDelta";

export type WorktreeDeltaState =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "ready"; delta: WorktreeDelta };

/** The recorded worktree delta for a chat tool call, if one exists. */
export function useWorktreeDelta(
  toolId: string | undefined
): WorktreeDeltaState {
  const sessionId = useContext(ChatSessionContext);
  const annotation = useToolAnnotation(sessionId, toolId, "worktree_delta");
  return useMemo(() => {
    if (!annotation) return { status: "none" };
    const delta = parseWorktreeDelta(annotation.payload);
    return delta ? { status: "ready", delta } : { status: "invalid" };
  }, [annotation]);
}

/** Load the diff chunk and start its highlighter workers in the background. */
export function preloadDiffRenderer(): void {
  if (typeof Worker === "undefined") return;
  void Promise.all([import("./PatchFiles"), import("./diffWorkerPool")]).then(
    ([, pool]) => pool.warmDiffRenderer(),
    () => undefined
  );
}
