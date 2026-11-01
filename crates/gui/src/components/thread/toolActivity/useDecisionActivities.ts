import { useEffect, useState } from "react";
import { activityNames } from "./classification";
import { commands } from "../../../bindings";
import type { ActivityAnalysis } from "./types";

/** Only actual syntax-separated, unresolved invocations enter inference. */
export function decisionSources(rows: ActivityAnalysis[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.operations
          .filter(
            (op) =>
              op.decisionEligible &&
              new TextEncoder().encode(op.source).length <= 4096
          )
          .map((op) => op.source)
      )
    ),
  ].slice(0, 16);
}

export function applyDecisions(
  rows: ActivityAnalysis[],
  decisions: Record<string, string[]>
): ActivityAnalysis[] {
  return rows.map((row) => ({
    ...row,
    operations: row.operations.map((op) => {
      const value = Object.prototype.hasOwnProperty.call(decisions, op.source)
        ? decisions[op.source]
        : undefined;
      const inferredActivities =
        op.decisionEligible && Array.isArray(value)
          ? [
              ...new Set(
                value.filter(
                  (label) =>
                    activityNames.has(label) && !op.activities.includes(label)
                )
              ),
            ]
          : [];
      return inferredActivities.length
        ? {
            ...op,
            activities: [...op.activities, ...inferredActivities],
            inferredActivities,
          }
        : op;
    }),
  }));
}

/** The backend owns admission, batching, and decision cache identity.
 * Expansion requests enrichment; stale responses never change another scope.
 */
export function useDecisionActivities(
  rows: ActivityAnalysis[],
  sessionId: string | null,
  enabled: boolean
): ActivityAnalysis[] {
  const key = JSON.stringify({ sessionId, sources: decisionSources(rows) });
  const [state, setState] = useState<{
    key: string;
    decisions: Record<string, string[]>;
  }>();
  useEffect(() => {
    if (!enabled || !sessionId) return;
    setState(undefined);
    const { sources }: { sources: string[] } = JSON.parse(key);
    if (!sources.length) return;
    let alive = true;
    void commands
      .classifyToolOperations(sources)
      .then((result) => {
        if (
          alive &&
          result.status === "ok" &&
          result.data.length === sources.length
        )
          setState({
            key,
            decisions: Object.fromEntries(
              sources.map((source, i) => [source, result.data[i]])
            ),
          });
      })
      .catch(() => {
        /* Syntax and raw disclosure remain available. */
      });
    return () => {
      alive = false;
    };
  }, [key, enabled, sessionId]);
  return state?.key === key ? applyDecisions(rows, state.decisions) : rows;
}
