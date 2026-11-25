import type { GithubFailure } from "../../../bindings";
import { retryWaitText } from "./githubFailure";

export function GhMissingText() {
  return (
    <>
      GitHub CLI (<code>gh</code>) not found · install <code>gh</code> and run{" "}
      <code>gh auth login</code> to connect PRs
    </>
  );
}

export function AuthExpiredText() {
  return (
    <>
      GitHub authentication expired · run <code>gh auth login</code> in your
      terminal
    </>
  );
}

export function GithubFailureText({ failure }: { failure: GithubFailure }) {
  switch (failure.kind) {
    case "gh_missing":
      return <GhMissingText />;
    case "auth_expired":
      return <AuthExpiredText />;
    case "rate_limited":
      return (
        <>
          GitHub rate limit reached · try again{" "}
          {retryWaitText(failure.retryAfterSecs)}
        </>
      );
    case "not_found":
    case "other":
      return <>{failure.message}</>;
    default: {
      const unreachable: never = failure.kind;
      return unreachable;
    }
  }
}
