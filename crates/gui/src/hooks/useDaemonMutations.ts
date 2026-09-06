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
} from "../daemons/errors";
import {
  errorMessage,
  invalidateDaemonQueries,
  queryClient,
  queryKeys,
  unwrapCommand,
  type DaemonInvalidationScope,
} from "../query";

interface DaemonMutationState {
  isBusy: boolean;
  error: string | null;
  errorKind: DaemonErrorKind | null;
}

const IDLE: DaemonMutationState = { isBusy: false, error: null, errorKind: null };

interface DaemonMutations extends DaemonMutationState {
  createDaemon: (name: string | null) => Promise<DaemonBootstrap | null>;
  renameDaemon: (
    daemonId: string,
    name: DaemonNameUpdate
  ) => Promise<Daemon | null>;
  revokeDaemon: (daemonId: string) => Promise<Daemon | null>;
  unregisterDaemon: (daemonId: string) => Promise<Daemon | null>;
  rotateDaemonCredentials: (daemonId: string) => Promise<DaemonBootstrap | null>;
  reset: () => void;
}

export function useDaemonMutations(): DaemonMutations {
  const [state, setState] = useState<DaemonMutationState>(IDLE);
  const inFlight = useRef(0);

  const runMutation = useCallback(
    async <T extends { connection_id: string }>(
      invoke: () => Promise<T>,
      scope: DaemonInvalidationScope,
      daemonId?: string
    ): Promise<T | null> => {
      const connectionId =
        queryClient.getQueryData<string | null>(
          queryKeys.sacrumConnection()
        ) ?? null;
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
        const result = await invoke();
        assertCurrentDaemonSnapshot(connectionId, result.connection_id);
        invalidateDaemonQueries(connectionId, scope, daemonId);
        inFlight.current -= 1;
        setState({ isBusy: inFlight.current > 0, error: null, errorKind: null });
        return result;
      } catch (error) {
        const kind = daemonErrorKind(error);
        if (isAmbiguousDaemonError(kind)) {
          // Never auto-retry: refresh safe metadata and surface explicit recovery.
          invalidateDaemonQueries(connectionId);
        }
        inFlight.current -= 1;
        setState({
          isBusy: inFlight.current > 0,
          error: errorMessage(error),
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
        () => unwrapCommand(commands.createDaemon(name)),
        "fleet"
      );
      return result?.bootstrap ?? null;
    },
    [runMutation]
  );

  const renameDaemon = useCallback(
    async (daemonId: string, name: DaemonNameUpdate): Promise<Daemon | null> => {
      const result = await runMutation(
        () => unwrapCommand(commands.renameDaemon(daemonId, name)),
        "daemon",
        daemonId
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const revokeDaemon = useCallback(
    async (daemonId: string): Promise<Daemon | null> => {
      const result = await runMutation(
        () => unwrapCommand(commands.revokeDaemon(daemonId)),
        "daemonEnrollment",
        daemonId
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const unregisterDaemon = useCallback(
    async (daemonId: string): Promise<Daemon | null> => {
      const result = await runMutation(
        () => unwrapCommand(commands.unregisterDaemon(daemonId)),
        "daemonEnrollment",
        daemonId
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const rotateDaemonCredentials = useCallback(
    async (daemonId: string): Promise<DaemonBootstrap | null> => {
      const result = await runMutation(
        () => unwrapCommand(commands.rotateDaemonCredentials(daemonId)),
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
    revokeDaemon,
    unregisterDaemon,
    rotateDaemonCredentials,
    reset,
  };
}
