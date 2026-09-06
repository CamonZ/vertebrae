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

/**
 * One daemon's safe metadata, scoped to the backend/account connection.
 * Unknown and foreign ids resolve to `null` without disclosure.
 */
export function useDaemonDetail(
  daemonId: string | null | undefined
): DaemonReadResult<Daemon | null> {
  const { identity } = useSacrumConnection();

  // GET_DAEMON selects the identical DaemonFields projection as LIST_FLEET,
  // so a daemon already present in the fleet cache seeds the detail query and
  // skips a redundant round-trip. Seeding is safe only under the same
  // identity: the fleet key is identity-scoped, and identity is null (no
  // seeding) until resolved. With the repository's infinite staleTime a
  // seeded query does not fetch; mutation invalidation handles refresh.
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

/**
 * One daemon's credential audit (enrollment metadata), scoped to the
 * backend/account connection. Carries no token material by contract.
 *
 * Deliberately not seeded from the fleet cache: the fleet document excludes
 * credential material, so the projections are not equivalent.
 */
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
