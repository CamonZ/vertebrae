import { CommandResultError } from "../query/commandResult";
import { isCurrentSacrumConnectionIdentity } from "../stores/sacrumConnectionStore";
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
  if (
    connectionId !== captured ||
    !isCurrentSacrumConnectionIdentity(connectionId)
  ) {
    throw new StaleDaemonConnectionError(connectionId);
  }
}

export function daemonErrorKind(error: unknown): DaemonErrorKind | null {
  if (
    error instanceof CommandResultError &&
    error.cause &&
    typeof error.cause === "object" &&
    "kind" in error.cause
  ) {
    const kind = (error.cause as { kind: unknown }).kind;
    return typeof kind === "string" ? (kind as DaemonErrorKind) : null;
  }
  return null;
}

/** Kinds that mean "the operation may have been applied; never auto-retry". */
export function isAmbiguousDaemonError(kind: DaemonErrorKind | null): boolean {
  return kind === "ambiguous_transport" || kind === "malformed_response";
}
