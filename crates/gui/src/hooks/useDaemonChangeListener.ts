import { useCallback, useEffect } from "react";
import { events, type DaemonChangedEvent } from "../bindings";
import { useSacrumConnection } from "./useSacrumConnection";
import { removeDaemonFromQueryCache, upsertDaemonInQueryCache } from "../query";

/** Applies account-scoped daemon CDC events to the existing fleet projections. */
export function useDaemonChangeListener() {
  const { identity } = useSacrumConnection();

  const handleChanged = useCallback(
    ({ payload }: { payload: DaemonChangedEvent }) => {
      if (!identity || payload.connection_id !== identity) return;

      if (payload.change_type === "Deleted") {
        removeDaemonFromQueryCache(identity, payload.daemon_id);
      } else if (payload.daemon) {
        upsertDaemonInQueryCache(identity, payload.daemon);
      }
    },
    [identity]
  );

  useEffect(() => {
    const unlisten = events.daemonChangedEvent.listen(handleChanged);
    return () => void unlisten.then((stop) => stop());
  }, [handleChanged]);
}
