import { useQuery } from "@tanstack/react-query";
import type { DaemonErrorKind } from "../bindings";
import { useSacrumConnection } from "../hooks/useSacrumConnection";
import { errorMessage } from "../query";
import { queryKeys } from "../query/queryKeys";
import {
  NO_BACKEND_ERROR,
  assertCurrentDaemonSnapshot,
  daemonErrorKind,
} from "./errors";

/** Shared read shape returned by every daemon read hook. */
export interface DaemonReadResult<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  errorKind: DaemonErrorKind | null;
  /** Connection identity the current cache is scoped to. */
  connectionId: string | null;
  refetch: () => void;
}

interface DaemonQueryOptions<
  TSnapshot extends { connection_id: string },
  TData,
> {
  /** Daemon-subtree query key for the given connection identity. */
  queryKey: (connectionId: string) => readonly unknown[];
  /**
   * Extra enabled gate beyond identity resolution (for example, a daemon id
   * being present). The identity gate itself is always applied.
   */
  enabled?: boolean;
  /** Invokes the Tauri command; must return a connection-tagged snapshot. */
  invoke: (captured: string) => Promise<TSnapshot>;
  /** Projects a verified snapshot into the cached value. */
  project: (snapshot: TSnapshot) => TData;
  /**
   * Optional seed from an equivalent cached projection (see
   * `useDaemonDetail`). `undefined` means fetch. The repository queryClient
   * uses an infinite staleTime, so a seeded query does not fetch while
   * seeded; invalidation after mutations handles refresh.
   */
  initialData?: TData;
}

/**
 * Internal skeleton shared by the daemon read hooks: capture the connection
 * identity, invoke the Tauri command, discard late responses from a retired
 * connection (the Tauri command performs the same check authoritatively;
 * this is the frontend guard), and expose the common
 * loading/error/connection plumbing.
 *
 * The public hooks (`useDaemonFleet`, `useDaemonDetail`,
 * `useDaemonEnrollmentMetadata`) wrap this and own their exported shapes;
 * keep those signatures stable for downstream consumers.
 */
export function useDaemonQuery<
  TSnapshot extends { connection_id: string },
  TData,
>(options: DaemonQueryOptions<TSnapshot, TData>): DaemonReadResult<TData> {
  const { identity, isLoading: connectionLoading } = useSacrumConnection();

  const query = useQuery({
    queryKey: options.queryKey(
      identity ?? queryKeys.daemons.unresolved
    ),
    enabled: identity !== null && (options.enabled ?? true),
    initialData: options.initialData,
    queryFn: async () => {
      const captured = identity;
      if (!captured) {
        throw new Error(NO_BACKEND_ERROR);
      }
      const snapshot = await options.invoke(captured);
      // The account may have changed while the request was in flight; a
      // payload from a retired scope is discarded before it can be cached.
      assertCurrentDaemonSnapshot(captured, snapshot.connection_id);
      return options.project(snapshot);
    },
  });

  const noBackend = identity === null && !connectionLoading;

  return {
    data: query.data ?? null,
    isLoading: !noBackend && (connectionLoading || query.isLoading),
    error: noBackend
      ? NO_BACKEND_ERROR
      : query.error
        ? errorMessage(query.error)
        : null,
    errorKind: query.error ? daemonErrorKind(query.error) : null,
    connectionId: identity,
    refetch: () => void query.refetch(),
  };
}
