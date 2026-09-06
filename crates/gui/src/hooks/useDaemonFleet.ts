import { commands, type Daemon, type DaemonErrorKind } from "../bindings";
import { useDaemonQuery } from "../daemons/useDaemonQuery";
import { queryKeys, unwrapCommand } from "../query";

const NO_DAEMONS: Daemon[] = [];

interface DaemonFleet {
  daemons: Daemon[];
  isLoading: boolean;
  error: string | null;
  errorKind: DaemonErrorKind | null;
  /** Connection identity the current fleet cache is scoped to. */
  connectionId: string | null;
  refetch: () => void;
}

/**
 * Owner's active daemon fleet, scoped to the backend/account connection
 * identity rather than the selected project.
 *
 * A late response from a retired connection is rejected before it can be
 * cached or displayed (the Tauri command performs the same check
 * authoritatively; this is the frontend guard).
 */
export function useDaemonFleet(): DaemonFleet {
  const read = useDaemonQuery({
    queryKey: queryKeys.daemons.fleet,
    invoke: () => unwrapCommand(commands.listDaemonFleet()),
    project: (snapshot) => snapshot.daemons,
  });

  return {
    daemons: read.data ?? NO_DAEMONS,
    isLoading: read.isLoading,
    error: read.error,
    errorKind: read.errorKind,
    connectionId: read.connectionId,
    refetch: read.refetch,
  };
}
