import type { StepExecution, TaskRun } from "../bindings";
import { safeMs } from "../components/Traces/timeUtils";

const WAIT_CHILDREN_STEP_TYPE = "wait_children";

export type WaitingGateKind = "human_input" | "wait_children";

export interface HumanInputGateContext {
  run: TaskRun;
  execution: StepExecution | null;
  stepName: string | null;
  prompt: string | null;
  outputSchema: unknown | null;
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
  executions: readonly StepExecution[],
  options: { outputSchema?: unknown | null } = {}
): HumanInputGateContext | null {
  if (!run || run.status !== "waiting") return null;
  const execution = pickLatestExecution(run, executions);
  if (classifyWaitingRun(execution) !== "human_input") return null;
  return {
    run,
    execution,
    stepName: execution?.step_name ?? null,
    prompt: execution?.prompt ?? null,
    outputSchema: options.outputSchema ?? null,
  };
}
