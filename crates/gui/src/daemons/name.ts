import type { DaemonNameUpdate } from "../bindings";

/** The server accepts trimmed daemon names from one through one hundred characters. */
export const DAEMON_NAME_MAX_LENGTH = 100;

export interface DaemonNameValidationOptions {
  allowEmpty?: boolean;
}

export function normalizeDaemonName(value: string): string {
  return value.trim();
}

/**
 * Keep registration and rename on the same client-side validation path. An
 * empty value is valid because registration may create an unnamed record and
 * rename may explicitly clear an existing name.
 */
export function validateDaemonName(
  value: string,
  { allowEmpty = true }: DaemonNameValidationOptions = {}
): string | null {
  const normalized = normalizeDaemonName(value);
  if (!allowEmpty && normalized.length === 0) {
    return "Daemon name cannot be empty.";
  }
  if (Array.from(normalized).length > DAEMON_NAME_MAX_LENGTH) {
    return `Daemon name must be ${DAEMON_NAME_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

export function daemonNameUpdate(value: string): DaemonNameUpdate {
  const normalized = normalizeDaemonName(value);
  return normalized.length === 0
    ? { kind: "clear" }
    : { kind: "set", value: normalized };
}
