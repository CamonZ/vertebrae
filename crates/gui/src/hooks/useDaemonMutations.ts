import { useCallback, useState } from "react";
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
  unwrapCommand,
  type DaemonInvalidationScope,
} from "../query";
import { getSacrumConnectionIdentity } from "../stores/sacrumConnectionStore";

interface DaemonMutationState {
  isBusy: boolean;
  error: string | null;
  errorKind: DaemonErrorKind | null;
}

const IDLE: DaemonMutationState = { isBusy: false, error: null, errorKind: null };

interface DaemonMutations extends DaemonMutationState {
  /** Provision a daemon; the returned bootstrap carries a one-time token. */
  createDaemon: (name: string | null) => Promise<DaemonBootstrap | null>;
  /** Rename through the server's shared naming policy. */
  renameDaemon: (
    daemonId: string,
    name: DaemonNameUpdate
  ) => Promise<Daemon | null>;
  /** Terminal, idempotent revocation. */
  revokeDaemon: (daemonId: string) => Promise<Daemon | null>;
  /** Soft-tombstone unregister; refused conservatively by the server. */
  unregisterDaemon: (daemonId: string) => Promise<Daemon | null>;
  /** Invalidate prior credentials and issue a fresh one-time bootstrap. */
  rotateDaemonCredentials: (daemonId: string) => Promise<DaemonBootstrap | null>;
  /** Clear the surfaced error after the UI has handled recovery. */
  reset: () => void;
}

/**
 * Daemon fleet mutations with the fleet's cache-invalidation contract.
 *
 * Two behavioral rules are enforced here:
 *
 * 1. **No automatic duplicate mutations.** After network ambiguity
 *    (`ambiguous_transport`/`malformed_response`) the mutation is never
 *    retried from this hook; safe fleet metadata is refreshed instead and the
 *    error is surfaced so the UI can offer explicit recovery (rotation,
 *    re-checking the fleet).
 * 2. **No late application across connections.** The connection identity is
 *    captured when the mutation starts; a result from a retired connection
 *    (including its one-time token) is discarded before any cache write.
 */
export function useDaemonMutations(): DaemonMutations {
  const [state, setState] = useState<DaemonMutationState>(IDLE);

  const runMutation = useCallback(
    async <T extends { connection_id: string }>(
      invoke: () => Promise<T>,
      scope: DaemonInvalidationScope
    ): Promise<T | null> => {
      const connectionId = getSacrumConnectionIdentity();
      if (!connectionId) {
        setState({
          isBusy: false,
          error: NO_BACKEND_ERROR,
          errorKind: "no_backend",
        });
        return null;
      }
      setState({ isBusy: true, error: null, errorKind: null });
      try {
        const result = await invoke();
        assertCurrentDaemonSnapshot(connectionId, result.connection_id);
        invalidateDaemonQueries(connectionId, scope);
        setState(IDLE);
        return result;
      } catch (error) {
        const kind = daemonErrorKind(error);
        if (isAmbiguousDaemonError(kind)) {
          // The operation may have been applied. Refresh safe metadata so the
          // UI can reconcile, and surface the error for explicit recovery.
          // Never re-invoke the mutation from here; "all" keeps the broad
          // refresh guarantee after ambiguity.
          invalidateDaemonQueries(connectionId);
        }
        setState({ isBusy: false, error: errorMessage(error), errorKind: kind });
        return null;
      }
    },
    []
  );

  const createDaemon = useCallback(
    async (name: string | null): Promise<DaemonBootstrap | null> => {
      // The list gains one record; existing daemons are unaffected.
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
      // A name is not credential metadata; the enrollment audit is unaffected.
      const result = await runMutation(
        () => unwrapCommand(commands.renameDaemon(daemonId, name)),
        { daemonId }
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const revokeDaemon = useCallback(
    async (daemonId: string): Promise<Daemon | null> => {
      // Revocation invalidates every credential, so the audit changes too.
      const result = await runMutation(
        () => unwrapCommand(commands.revokeDaemon(daemonId)),
        { daemonId, enrollment: true }
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const unregisterDaemon = useCallback(
    async (daemonId: string): Promise<Daemon | null> => {
      const result = await runMutation(
        () => unwrapCommand(commands.unregisterDaemon(daemonId)),
        { daemonId, enrollment: true }
      );
      return result?.daemon ?? null;
    },
    [runMutation]
  );

  const rotateDaemonCredentials = useCallback(
    async (daemonId: string): Promise<DaemonBootstrap | null> => {
      // Rotation issues a fresh credential, so the audit changes too.
      const result = await runMutation(
        () => unwrapCommand(commands.rotateDaemonCredentials(daemonId)),
        { daemonId, enrollment: true }
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
