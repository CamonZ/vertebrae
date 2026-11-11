export interface ActivityInput {
  name: string;
  input: Record<string, unknown>;
}
export interface Operation {
  /** Literal syntax only. Execution/success must be established separately. */
  literalCommand?: { name: string; args: string[] };
  source: string;
  activities: string[];
  targets?: string[];
  /** Syntax relationships describe requests, never observed execution. */
  relationships: string[];
  unresolved?: string;
  /** A syntax-separated invocation; opaque wrappers and parse failures are excluded. */
  decisionEligible?: boolean;
  inferredActivities?: string[];
}
export interface ActivityAnalysis {
  failure?: WorkerFailure;
  analysisState?: "loading" | "unavailable";
  operations: Operation[];
}
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

export function unavailableAnalysis(
  reason: string,
  failure?: WorkerFailure
): ActivityAnalysis {
  return {
    ...fallbackAnalysis,
    failure,
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

export interface WorkerFailure {
  phase: "initialization" | "analysis" | "runtime";
  retryable: boolean;
  message: string;
}
export type WorkerResponse =
  | { kind: "result"; id: number; analysis: ActivityAnalysis }
  | { kind: "error"; id: number; error: WorkerFailure };
