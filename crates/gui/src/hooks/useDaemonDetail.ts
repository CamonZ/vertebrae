import { useMemo } from "react";
import {
  commands,
  type Daemon,
  type DaemonEnrollmentMetadata,
} from "../bindings";
import {
  useDaemonQuery,
  type DaemonReadResult,
} from "../daemons/useDaemonQuery";
import { queryClient, queryKeys, unwrapCommand } from "../query";
import { useSacrumConnection } from "./useSacrumConnection";

export function useDaemonDetail(
  daemonId: string | null | undefined
): DaemonReadResult<Daemon | null> {
  const { identity } = useSacrumConnection();

  const initialData = useMemo(() => {
    if (!identity || !daemonId) {
      return undefined;
    }
    return queryClient
      .getQueryData<Daemon[]>(queryKeys.daemons.fleet(identity))
      ?.find((daemon) => daemon.id === daemonId);
  }, [identity, daemonId]);

  return useDaemonQuery({
    queryKey: (connectionId) =>
      queryKeys.daemons.detail(connectionId, daemonId ?? ""),
    enabled: Boolean(daemonId),
    invoke: () => unwrapCommand(commands.getDaemon(daemonId as string)),
    project: (snapshot) => snapshot.daemon,
    initialData,
  });
}

// Not seeded from the fleet cache: the fleet projection excludes credential data.
export function useDaemonEnrollmentMetadata(
  daemonId: string | null | undefined
): DaemonReadResult<DaemonEnrollmentMetadata | null> {
  return useDaemonQuery({
    queryKey: (connectionId) =>
      queryKeys.daemons.enrollment(connectionId, daemonId ?? ""),
    enabled: Boolean(daemonId),
    invoke: () =>
      unwrapCommand(commands.getDaemonEnrollmentMetadata(daemonId as string)),
    project: (snapshot) => snapshot.metadata,
  });
}
