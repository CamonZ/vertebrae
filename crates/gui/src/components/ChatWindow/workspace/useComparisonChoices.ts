import { useEffect, useState } from "react";
import {
  commands,
  type ComparisonChoice,
  type ComparisonEndpoint,
} from "../../../bindings";

/** A select value per endpoint: "head", "working", or the endpoint as JSON. */
function endpointKey(endpoint: ComparisonEndpoint): string {
  return endpoint.kind === "head"
    ? "head"
    : endpoint.kind === "working_tree"
      ? "working"
      : JSON.stringify(endpoint);
}

/**
 * The branches and commits a worktree can compare, reloaded whenever
 * `reloadToken` changes, with the mapping between endpoints and the
 * comparison selects' values.
 */
export function useComparisonChoices(
  worktreePath: string,
  reloadToken: number
) {
  const [choices, setChoices] = useState<ComparisonChoice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    commands
      .listComparisonChoices(worktreePath)
      .then((result) => {
        if (!current) return;
        if (result.status === "ok") setChoices(result.data);
        else setError(result.error.message);
      })
      .catch((error: unknown) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [worktreePath, reloadToken]);

  // Match a short ref such as "origin/master" to its full-name choice.
  const selectedKey = (endpoint: ComparisonEndpoint) => {
    const short = endpoint.kind === "ref" ? endpoint.value : null;
    const named =
      short &&
      choices.find(
        ({ endpoint: choice }) =>
          choice.kind === "ref" &&
          [short, `refs/heads/${short}`, `refs/remotes/${short}`].includes(
            choice.value
          )
      );
    return endpointKey(named ? named.endpoint : endpoint);
  };

  const endpointFor = (value: string): ComparisonEndpoint | undefined =>
    value === "head"
      ? { kind: "head" }
      : value === "working"
        ? { kind: "working_tree" }
        : choices.find((choice) => endpointKey(choice.endpoint) === value)
            ?.endpoint;

  return { choices, error, selectedKey, endpointFor };
}

export type ComparisonChoices = ReturnType<typeof useComparisonChoices>;
