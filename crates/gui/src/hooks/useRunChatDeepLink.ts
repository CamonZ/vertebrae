import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { openRunInChat, resolveTaskRunTarget } from "../utils/openRunInChat";

export interface RunChatDeepLink {
  taskId: string;
  runId: string | null;
  threadId: string | null;
}

/** `#task=<id>[&run=<id>][&exec=<threadId>]` → a run to open in the chat. */
export function parseRunChatHash(hash: string): RunChatDeepLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const taskId = params.get("task");
  if (!taskId) return null;
  return {
    taskId,
    runId: params.get("run") || null,
    threadId: params.get("exec") || null,
  };
}

/**
 * Open the run named by the URL hash in the maximized chat on any page, then
 * drop the hash so it applies once. Without `run`, the task's active or
 * newest run opens; `exec` scrolls to that step execution or subagent.
 */
export function useRunChatDeepLink() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const link = parseRunChatHash(location.hash);
    if (!link) return;

    navigate(
      { pathname: location.pathname, search: location.search, hash: "" },
      { replace: true }
    );

    // Clearing the hash re-runs this effect, so the open is not cancelled.
    void (async () => {
      const target = link.runId
        ? { taskId: link.taskId, runId: link.runId }
        : await resolveTaskRunTarget(link.taskId).catch(() => null);
      if (target) openRunInChat({ ...target, threadId: link.threadId });
    })();
  }, [location.hash, location.pathname, location.search, navigate]);
}
