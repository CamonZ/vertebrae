import { commands, type Daemon, type DaemonErrorKind } from "../bindings";
import { useDaemonQuery } from "../daemons/useDaemonQuery";
import { queryKeys, unwrapCommand } from "../query";

const NO_DAEMONS: Daemon[] = [];
export const DAEMON_FLEET_POLL_INTERVAL_MS = 30_000;

interface DaemonFleet {
  daemons: Daemon[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  errorKind: DaemonErrorKind | null;
  connectionId: string | null;
  refetch: () => void;
}

export function useDaemonFleet(): DaemonFleet {
  const read = useDaemonQuery({
    queryKey: queryKeys.daemons.fleet,
    refetchInterval: DAEMON_FLEET_POLL_INTERVAL_MS,
    invoke: (captured) => unwrapCommand(commands.listDaemonFleet(captured)),
    project: (snapshot) => snapshot.daemons,
  });

  return {
    daemons: read.data ?? NO_DAEMONS,
    isLoading: read.isLoading,
    isRefreshing: read.isRefreshing,
    error: read.error,
    errorKind: read.errorKind,
    connectionId: read.connectionId,
    refetch: read.refetch,
  };
}
