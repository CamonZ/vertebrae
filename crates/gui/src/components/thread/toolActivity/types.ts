import type { ActivityAnalysis as ParsedActivity } from "../../../bindings";

export type { ActivityInput } from "../../../bindings";
export type ActivityAnalysis = ParsedActivity & {
  analysisState?: "loading" | "unavailable";
};

export const fallbackAnalysis: ActivityAnalysis = {
  analysisState: "unavailable",
  operations: [
    {
      source: "Tool invocation",
      activities: [],
      relationships: [],
      unresolved: "Activity unavailable; inspect raw call",
    },
  ],
};

export function unavailableAnalysis(reason: string): ActivityAnalysis {
  return {
    ...fallbackAnalysis,
    operations: [{ ...fallbackAnalysis.operations[0], unresolved: reason }],
  };
}
export const loadingAnalysis: ActivityAnalysis = {
  ...fallbackAnalysis,
  analysisState: "loading",
  operations: [
    {
      ...fallbackAnalysis.operations[0],
      unresolved: "Analyzing tool activity",
    },
  ],
};
