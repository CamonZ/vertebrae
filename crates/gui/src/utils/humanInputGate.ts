import type { StepExecution, TaskRun } from "../bindings";
import { safeMs } from "../components/Traces/timeUtils";
import { executionHumanInput } from "./stepConfig";

const WAIT_CHILDREN_STEP_TYPE = "wait_children";

export type WaitingGateKind = "human_input" | "wait_children";

export interface HumanInputGateContext {
  run: TaskRun;
  execution: StepExecution | null;
  stepName: string | null;
  /** Rendered gate instructions from the waiting execution's config. */
  prompt: string | null;
  outputSchema: unknown | null;
  /** Logical name of the artifact that resolves the gate. */
  artifact: string | null;
  /** 1-based visit of this gate step in the run. */
  attempt?: number;
}

export function pickLatestExecution(
  run: TaskRun,
  executions: readonly StepExecution[]
): StepExecution | null {
  if (run.latest_step_execution_id) {
    const match = executions.find((e) => e.id === run.latest_step_execution_id);
    if (match) return match;
  }
  let latest: StepExecution | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const exec of executions) {
    if (exec.task_run_id && exec.task_run_id !== run.id) continue;
    const ts = safeMs(exec.started_at);
    if (ts !== null && ts > latestMs) {
      latestMs = ts;
      latest = exec;
    }
  }
  return latest;
}

export function classifyWaitingRun(
  execution: StepExecution | null
): WaitingGateKind {
  if (execution?.step_type === WAIT_CHILDREN_STEP_TYPE) {
    return "wait_children";
  }
  return "human_input";
}

export function resolveHumanInputGate(
  run: TaskRun | null | undefined,
  executions: readonly StepExecution[]
): HumanInputGateContext | null {
  if (!run || run.status !== "waiting") return null;
  const execution = pickLatestExecution(run, executions);
  if (classifyWaitingRun(execution) !== "human_input") return null;
  const config = executionHumanInput(execution);
  const attempt =
    executions.filter(
      (candidate) =>
        (candidate.task_run_id ?? run.id) === run.id &&
        candidate.step_name === execution?.step_name &&
        candidate.step_type === "human_input"
    ).length || 1;
  return {
    run,
    execution,
    stepName: execution?.step_name ?? null,
    prompt: config?.instructions ?? null,
    outputSchema: config?.output_schema ?? null,
    artifact: config?.artifact ?? null,
    attempt,
  };
}
