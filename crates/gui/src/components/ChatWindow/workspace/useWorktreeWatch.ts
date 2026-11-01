import { useEffect, useState } from "react";
import { commands, events } from "../../../bindings";

/** Own the native watch and listener together, including delayed setup. */
export function useWorktreeWatch(worktree: string, refresh: () => void) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let id: string | undefined;
    let unlisten: (() => void) | undefined;
    const releaseListener = () => {
      const release = unlisten;
      unlisten = undefined;
      try {
        release?.();
      } catch (error) {
        console.warn("Could not release worktree listener", error);
      }
    };
    const stop = async (watchId: string) => {
      try {
        const result = await commands.unwatchWorktree(watchId);
        if (result.status === "error") console.warn(result.error.message);
      } catch (error) {
        console.warn("Could not stop worktree watch", error);
      }
    };
    const setup = async () => {
      setError(null);
      unlisten = await events.worktreeChangedEvent.listen(({ payload }) => {
        if (!disposed && payload.watch_id === id) refresh();
      });
      if (disposed) {
        releaseListener();
        return;
      }
      const result = await commands.watchWorktree(worktree);
      if (result.status === "error") throw new Error(result.error.message);
      id = result.data;
      if (disposed) await stop(id);
      else refresh(); // Close the gap between initial read and registration.
    };
    void setup().catch((error: unknown) => {
      releaseListener();
      if (!disposed) setError(String(error));
    });
    return () => {
      disposed = true;
      releaseListener();
      if (id) void stop(id);
    };
  }, [worktree, refresh]);
  return error;
}
