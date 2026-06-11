import type { CommandError, Result } from "../bindings";

export class CommandResultError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CommandResultError";
    this.cause = cause;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export async function unwrapCommand<T, E extends CommandError = CommandError>(
  promise: Promise<Result<T, E>>
): Promise<T> {
  const result = await promise;
  if (result.status === "ok") return result.data;
  throw new CommandResultError(result.error.message, result.error);
}
