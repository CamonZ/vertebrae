import { useCallback, useRef, useState } from "react";
import {
  commands,
  type Daemon,
  type DaemonBootstrap,
  type DaemonErrorKind,
  type DaemonNameUpdate,
} from "../bindings";
import {
  NO_BACKEND_ERROR,
  assertCurrentDaemonSnapshot,
  daemonErrorKind,
  isAmbiguousDaemonError,
  daemonActionErrorMessage,
} from "../daemons/errors";
import {
  errorMessage,
  invalidateDaemonQueries,
  queryClient,
  queryKeys,
  removeDaemonFromQueryCache,
  updateDaemonInQueryCache,
  unwrapCommand,
  type DaemonInvalidationScope,
} from "../query";

interface DaemonMutationState {
  isBusy: boolean;
  error: string | null;
  errorKind: DaemonErrorKind | null;
}

const IDLE: DaemonMutationState = {
  isBusy: false,
  error: null,
  errorKind: null,
};

interface DaemonMutations extends DaemonMutationState {
  createDaemon: (name: string | null) => Promise<DaemonBootstrap | null>;
  renameDaemon: (
    daemonId: string,
    name: DaemonNameUpdate
  ) => Promise<Daemon | null>;
  setDaemonMaxConcurrency: (
    daemonId: string,
    maxConcurrency: number
  ) => Promise<Daemon | null>;
  clearDaemonMaxConcurrency: (daemonId: string) => Promise<Daemon | null>;
  unregisterDaemon: (daemonId: string) => Promise<Daemon | null>;
  rotateDaemonCredentials: (
    daemonId: string
  ) => Promise<DaemonBootstrap | null>;
  reset: () => void;
}

export function useDaemonMutations(): DaemonMutations {
  const [state, setState] = useState<DaemonMutationState>(IDLE);
  const inFlight = useRef(0);

  const runMutation = useCallback(
    async <T extends { connection_id: string }>(
      invoke: (connectionId: string) => Promise<T>,
      scope: DaemonInvalidationScope,
      daemonId?: string,
      onSuccess?: (result: T) => void
    ): Promise<T | null> => {
      const connectionId =
        queryClient.getQueryData<string | null>(queryKeys.sacrumConnection()) ??
        null;
      if (!connectionId) {
        setState({
          isBusy: inFlight.current > 0,
          error: NO_BACKEND_ERROR,
          errorKind: "no_backend",
        });
        return null;
      }
      inFlight.current += 1;
      setState({ isBusy: true, error: null, errorKind: null });
      try {
        const result = await invoke(connectionId);
        assertCurrentDaemonSnapshot(connectionId, result.connection_id);
        onSuccess?.(result);
        invalidateDaemonQueries(connectionId, scope, daemonId);
        inFlight.current -= 1;
        setState({
          isBusy: inFlight.current > 0,
          error: null,
          errorKind: null,
        });
        return result;
      } catch (error) {
        const kind = daemonErrorKind(error);
        if (isAmbiguousDaemonError(kind)) {
          // Never auto-retry: refresh safe metadata and surface explicit recovery.
          invalidateDaemonQueries(connectionId);
        } else if (
          kind === "not_found" ||
          kind === "terminal_state" ||
          kind === "active_session" ||
          kind === "ownership_unknown"
        ) {
          // A refusal can confirm that the cached lifecycle snapshot is stale,
          // but it is never a reason to make the row disappear optimistically.
          invalidateDaemonQueries(connectionId);
        }
        inFlight.current -= 1;
        setState({
          isBusy: inFlight.current > 0,
          error: daemonActionErrorMessage(kind, errorMessage(error)),
          errorKind: kind,
        });
        return null;
      }
    },
    []
  );

  const createDaemon = useCallback(
    async (name: string | null): Promise<DaemonBootstrap | null> => {
      const result = await runMutation(
        (connectionId) =>
          unwrapCommand(commands.createDaemon(connectionId, name)),
        "fleet"
      );
      return result?.bootstrap ?? null;
    },
    [runMutation]
  );

  const renameDaemon = useCallback(
    async (
      daemonId: string,
      name: DaemonNameUpdate
    ): Promise<Daemon | null> => {
      const result = await runMutation(
        (connectionId) =>
          unwrapCommand(commands.renameDaemon(connectionId, daemonId, name)),
        "daemon",
        daemonId,
        (mutation) =>
          updateDaemonInQueryCache(mutation.connection_id, mutation.daemon)
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const unregisterDaemon = useCallback(
    async (daemonId: string): Promise<Daemon | null> => {
      const result = await runMutation(
        (connectionId) =>
          unwrapCommand(commands.unregisterDaemon(connectionId, daemonId)),
        "daemonEnrollment",
        daemonId,
        (mutation) =>
          removeDaemonFromQueryCache(mutation.connection_id, daemonId)
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const setDaemonMaxConcurrency = useCallback(
    async (
      daemonId: string,
      maxConcurrency: number
    ): Promise<Daemon | null> => {
      const result = await runMutation(
        (connectionId) =>
          unwrapCommand(
            commands.setDaemonMaxConcurrency(
              connectionId,
              daemonId,
              maxConcurrency
            )
          ),
        "daemon",
        daemonId,
        (mutation) =>
          updateDaemonInQueryCache(mutation.connection_id, mutation.daemon)
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const clearDaemonMaxConcurrency = useCallback(
    async (daemonId: string): Promise<Daemon | null> => {
      const result = await runMutation(
        (connectionId) =>
          unwrapCommand(
            commands.clearDaemonMaxConcurrency(connectionId, daemonId)
          ),
        "daemon",
        daemonId,
        (mutation) =>
          updateDaemonInQueryCache(mutation.connection_id, mutation.daemon)
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const rotateDaemonCredentials = useCallback(
    async (daemonId: string): Promise<DaemonBootstrap | null> => {
      const result = await runMutation(
        (connectionId) =>
          unwrapCommand(
            commands.rotateDaemonCredentials(connectionId, daemonId)
          ),
        "daemonEnrollment",
        daemonId
      );
      return result?.bootstrap ?? null;
    },
    [runMutation]
  );

  const reset = useCallback(() => setState(IDLE), []);

  return {
    ...state,
    createDaemon,
    renameDaemon,
    setDaemonMaxConcurrency,
    clearDaemonMaxConcurrency,
    unregisterDaemon,
    rotateDaemonCredentials,
    reset,
  };
}
