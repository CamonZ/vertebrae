import {
  commands,
  type Daemon,
  type DaemonEnrollmentMetadata,
} from "../bindings";
import {
  useDaemonQuery,
  type DaemonReadResult,
} from "../daemons/useDaemonQuery";
import { queryKeys, unwrapCommand } from "../query";

export function useDaemonDetail(
  daemonId: string | null | undefined
): DaemonReadResult<Daemon | null> {
  return useDaemonQuery({
    queryKey: (connectionId) =>
      queryKeys.daemons.detail(connectionId, daemonId ?? ""),
    enabled: Boolean(daemonId),
    invoke: () => unwrapCommand(commands.getDaemon(daemonId as string)),
    project: (snapshot) => snapshot.daemon,
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
