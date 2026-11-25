import type { GithubFailure } from "../../../bindings";

export function retryWaitText(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "later";
  return seconds < 90 ? `in ${seconds}s` : `in ${Math.ceil(seconds / 60)} min`;
}

export function staleRefreshNote(failure: GithubFailure): string {
  switch (failure.kind) {
    case "gh_missing":
      return "gh not found";
    case "auth_expired":
      return "gh sign-in expired";
    case "rate_limited":
      return `rate limited · try again ${retryWaitText(failure.retryAfterSecs)}`;
    case "not_found":
      return "PR not found on GitHub";
    case "other":
      return failure.message;
    default: {
      const unreachable: never = failure.kind;
      return unreachable;
    }
  }
}

export function needsGhSetup(failure: GithubFailure): boolean {
  return failure.kind === "gh_missing" || failure.kind === "auth_expired";
}
