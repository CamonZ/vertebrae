import { useCallback, useEffect } from "react";
import {
  events,
  type DaemonChangedEvent,
  type DaemonMetricsEvent,
} from "../bindings";
import { useSacrumConnection } from "./useSacrumConnection";
import {
  mergeDaemonMetricsInQueryCache,
  removeDaemonFromQueryCache,
  upsertDaemonInQueryCache,
} from "../query";

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

  const handleMetrics = useCallback(
    ({ payload }: { payload: DaemonMetricsEvent }) => {
      if (!identity || payload.connection_id !== identity) return;
      mergeDaemonMetricsInQueryCache(
        identity,
        payload.daemon_id,
        payload.metrics
      );
    },
    [identity]
  );

  useEffect(() => {
    const changed = events.daemonChangedEvent.listen(handleChanged);
    const metrics = events.daemonMetricsEvent.listen(handleMetrics);
    return () => {
      void Promise.all([changed, metrics]).then((stops) =>
        stops.forEach((stop) => stop())
      );
    };
  }, [handleChanged, handleMetrics]);
}
