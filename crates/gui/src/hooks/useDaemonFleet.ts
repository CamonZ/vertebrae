import { commands, type Daemon, type DaemonErrorKind } from "../bindings";
import { useDaemonQuery } from "../daemons/useDaemonQuery";
import { queryKeys, unwrapCommand } from "../query";

const NO_DAEMONS: Daemon[] = [];

interface DaemonFleet {
  daemons: Daemon[];
  isLoading: boolean;
  error: string | null;
  errorKind: DaemonErrorKind | null;
  connectionId: string | null;
  refetch: () => void;
}

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
