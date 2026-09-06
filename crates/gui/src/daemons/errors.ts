import { CommandResultError } from "../query/commandResult";
import { queryClient, queryKeys } from "../query";
import type { DaemonErrorKind } from "../bindings";

export class StaleDaemonConnectionError extends Error {
  readonly connectionId: string;

  constructor(connectionId: string) {
    super(
      `daemon payload arrived for a retired connection (${connectionId})`
    );
    this.name = "StaleDaemonConnectionError";
    this.connectionId = connectionId;
  }
}

export const NO_BACKEND_ERROR = "No Sacrum backend connection is active.";

export function assertCurrentDaemonSnapshot(
  captured: string,
  connectionId: string
): void {
  const currentIdentity =
    queryClient.getQueryData<string | null>(queryKeys.sacrumConnection()) ??
    null;
  if (connectionId !== captured || currentIdentity !== connectionId) {
    throw new StaleDaemonConnectionError(connectionId);
  }
}

const DAEMON_ERROR_KINDS = [
  "no_backend",
  "stale_connection",
  "ambiguous_transport",
  "malformed_response",
  "unavailable",
  "not_found",
  "terminal_state",
  "active_session",
  "ownership_unknown",
  "invalid_name",
  "invalid_input",
  "unknown_refusal",
] as const;

export function daemonErrorKind(error: unknown): DaemonErrorKind | null {
  if (
    error instanceof CommandResultError &&
    error.cause &&
    typeof error.cause === "object" &&
    "kind" in error.cause
  ) {
    const kind = (error.cause as { kind: unknown }).kind;
    if (
      typeof kind === "string" &&
      (DAEMON_ERROR_KINDS as readonly string[]).includes(kind)
    ) {
      return kind as DaemonErrorKind;
    }
  }
  return null;
}

/** Kinds that mean "the operation may have been applied; never auto-retry". */
export function isAmbiguousDaemonError(kind: DaemonErrorKind | null): boolean {
  return kind === "ambiguous_transport" || kind === "malformed_response";
}
