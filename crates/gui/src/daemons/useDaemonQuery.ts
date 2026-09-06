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

export interface DaemonReadResult<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  errorKind: DaemonErrorKind | null;
  connectionId: string | null;
  refetch: () => void;
}

interface DaemonQueryOptions<
  TSnapshot extends { connection_id: string },
  TData,
> {
  queryKey: (connectionId: string) => readonly unknown[];
  enabled?: boolean;
  invoke: (captured: string) => Promise<TSnapshot>;
  project: (snapshot: TSnapshot) => TData;
}

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
    queryFn: async () => {
      const captured = identity;
      if (!captured) {
        throw new Error(NO_BACKEND_ERROR);
      }
      const snapshot = await options.invoke(captured);
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
    errorKind: noBackend
      ? "no_backend"
      : query.error
        ? daemonErrorKind(query.error)
        : null,
    connectionId: identity,
    refetch: () => void query.refetch(),
  };
}
