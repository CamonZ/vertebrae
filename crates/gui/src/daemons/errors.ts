import { CommandResultError } from "../query/commandResult";
import { isCurrentSacrumConnectionIdentity } from "../stores/sacrumConnectionStore";
import type { DaemonErrorKind } from "../bindings";

/**
 * A daemon payload arrived for a backend/account connection that is no longer
 * current. The payload (which may include a one-time enrollment token
 * belonging to the previous account) must be discarded, never cached or
 * displayed. The Tauri layer already rejects most of these; this class backs
 * the frontend's defense-in-depth guard.
 */
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

/**
 * Error message surfaced whenever a daemon read or mutation cannot run
 * because no Sacrum backend connection is active.
 */
export const NO_BACKEND_ERROR = "No Sacrum backend connection is active.";

/**
 * Verify that a daemon snapshot still belongs to the connection it was
 * requested under, discarding it otherwise.
 *
 * A snapshot is stale when its `connectionId` differs from the identity
 * captured when the request started, or when that identity is no longer
 * current (the account switched while the request was in flight). Stale
 * snapshots throw [`StaleDaemonConnectionError`] so the payload — which may
 * carry a one-time enrollment token belonging to the previous account — is
 * never cached or displayed. The captured id is passed explicitly because
 * imperative callers capture it outside a queryFn.
 */
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

/**
 * Structured kind of a daemon command failure, or null when the error is not
 * a command-level daemon error (for example a stale-connection guard throw).
 *
 * The kind drives recovery behavior: `ambiguous_transport` and
 * `malformed_response` mean the operation may have been applied and must not
 * be retried automatically.
 */
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
