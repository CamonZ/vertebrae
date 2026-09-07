import type { DaemonCommandError, DaemonErrorKind } from "../bindings";
import { CommandResultError } from "../query/commandResult";
import { queryClient, queryKeys } from "../query";

export const NO_BACKEND_ERROR = "No Sacrum backend connection is active.";

export const STALE_CONNECTION_MESSAGE =
  "The Sacrum connection changed while the request was in flight; the response was discarded.";

const STALE_CONNECTION_ERROR: DaemonCommandError = {
  kind: "stale_connection",
  message: STALE_CONNECTION_MESSAGE,
};

const DAEMON_ERROR_KINDS: Record<DaemonErrorKind, true> = {
  no_backend: true,
  stale_connection: true,
  ambiguous_transport: true,
  malformed_response: true,
  unavailable: true,
  not_found: true,
  terminal_state: true,
  active_session: true,
  ownership_unknown: true,
  invalid_name: true,
  invalid_input: true,
  unknown_refusal: true,
};

let previousSacrumIdentity: string | null = null;

export function retireDaemonQueriesForIdentity(identity: string | null): void {
  if (
    identity !== null &&
    previousSacrumIdentity !== null &&
    previousSacrumIdentity !== identity
  ) {
    queryClient.removeQueries({
      queryKey: queryKeys.daemons.all(previousSacrumIdentity),
    });
  }
  if (identity !== null) {
    previousSacrumIdentity = identity;
  }
}

export function resetDaemonConnectionScope(): void {
  previousSacrumIdentity = null;
}

export function assertCurrentDaemonSnapshot(
  captured: string,
  connectionId: string
): void {
  const currentIdentity =
    queryClient.getQueryData<string | null>(queryKeys.sacrumConnection()) ??
    null;
  if (connectionId !== captured || currentIdentity !== connectionId) {
    throw new CommandResultError(
      STALE_CONNECTION_MESSAGE,
      STALE_CONNECTION_ERROR
    );
  }
}

function isDaemonCommandError(cause: unknown): cause is DaemonCommandError {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if (!("kind" in cause) || !("message" in cause)) {
    return false;
  }
  return (
    typeof cause.kind === "string" &&
    typeof cause.message === "string" &&
    Object.prototype.hasOwnProperty.call(DAEMON_ERROR_KINDS, cause.kind)
  );
}

export function daemonErrorKind(error: unknown): DaemonErrorKind | null {
  if (
    !(error instanceof CommandResultError) ||
    !isDaemonCommandError(error.cause)
  ) {
    return null;
  }
  return error.cause.kind;
}

/** Kinds that mean "the operation may have been applied; never auto-retry". */
export function isAmbiguousDaemonError(kind: DaemonErrorKind | null): boolean {
  return kind === "ambiguous_transport" || kind === "malformed_response";
}
