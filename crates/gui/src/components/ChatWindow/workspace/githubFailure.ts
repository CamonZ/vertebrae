import type { GithubFailure } from "../../../bindings";

export function retryWaitText(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "later";
  return seconds < 90 ? `in ${seconds}s` : `in ${Math.ceil(seconds / 60)} min`;
}

export function needsGhSetup(failure: GithubFailure): boolean {
  return failure.kind === "gh_missing" || failure.kind === "auth_expired";
}
