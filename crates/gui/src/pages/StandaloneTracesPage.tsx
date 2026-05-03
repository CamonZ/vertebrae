import { useState } from "react";
import { useParams } from "react-router-dom";
import { TracesPage } from "./TracesPage";
import { WindowLayout } from "../components/WindowLayout";

/**
 * Standalone page rendered by the `/traces-window/:taskId` pop-out window.
 *
 * Unlike the task and chat pop-outs, we deliberately skip the localStorage
 * stash: subtree executions + session logs are large and change live, so a
 * brief fetch flash on open is acceptable. Websocket broadcasts cross
 * windows, so `useSubtreeExecutions` / `useSubtreeSessionLogs` resume
 * streaming as soon as the hook mounts in this window's JS context.
 *
 * Switching tasks via the rail picker updates local state in place so the
 * window URL/label (`traces-{rootTaskId}`) stays stable for the lifetime
 * of this webview.
 */
export function StandaloneTracesPage() {
  const { taskId: routeTaskId } = useParams<{ taskId: string }>();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    routeTaskId ?? null,
  );

  return (
    <WindowLayout>
      <TracesPage
        taskIdOverride={activeTaskId}
        onPickTask={setActiveTaskId}
        standalone
      />
    </WindowLayout>
  );
}
