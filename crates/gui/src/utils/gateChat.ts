import type {
  JsonValue,
  LocalChatGateBinding,
  StepExecution,
  TaskRun,
} from "../bindings";
import { safeMs } from "../components/Traces/timeUtils";
import type { HumanInputGateContext } from "./humanInputGate";

const HIDDEN_TURN_OPEN = "<vertebrae-hidden-turn>";
const HIDDEN_TURN_CLOSE = "</vertebrae-hidden-turn>";

/**
 * Wrap a turn Vertebrae sends on the user's behalf. The agent reads it as a
 * user turn; transcript projection never shows it in the thread.
 */
export function hiddenTurn(text: string): string {
  return `${HIDDEN_TURN_OPEN}\n${text}\n${HIDDEN_TURN_CLOSE}`;
}

export function isHiddenTurn(text: string): boolean {
  return text.trimStart().startsWith(HIDDEN_TURN_OPEN);
}

/**
 * Opening turn of a gate chat, so the agent speaks first and addresses the
 * gate's question. The protocol itself lives in the hidden developer
 * instructions bound at session start.
 */
export const GATE_CHAT_KICKOFF = hiddenTurn(
  "The user opened this chat to resolve the human input gate. Address its question now."
);

/**
 * Binding for a gate chat, or null when the waiting execution cannot be
 * resolved by artifact: no execution ID, step name, or configured artifact.
 */
export function gateChatBinding(
  context: HumanInputGateContext
): LocalChatGateBinding | null {
  const { run, execution, stepName, artifact } = context;
  const executionId = execution?.id;
  if (!executionId || !stepName || !artifact || !artifact.trim()) return null;
  return {
    task_run_id: run.id,
    step_name: stepName,
    execution_id: executionId,
    artifact,
    instructions: context.prompt,
    output_schema: (context.outputSchema ?? null) as JsonValue | null,
  };
}

/** Gate chats are bound to a run's step, not to one execution of it. */
export function isSameGate(
  a: Pick<LocalChatGateBinding, "task_run_id" | "step_name">,
  b: Pick<LocalChatGateBinding, "task_run_id" | "step_name">
): boolean {
  return a.task_run_id === b.task_run_id && a.step_name === b.step_name;
}

export function gateChatLabel(stepName: string): string {
  return `Resolve ${stepName}`;
}

/**
 * Where a bound gate chat stands in its run:
 * - `drafting`: the gate waits for its first resolution.
 * - `rejected`: the review looped back and the gate waits for attempt n.
 * - `under_review`: a resolution was submitted; nothing waits to accept another.
 * - `accepted`: a route after the submission sent the run past the gate.
 * - `closed`: the run stopped, failed or finished.
 */
export type GateChatPhase =
  | "drafting"
  | "rejected"
  | "under_review"
  | "accepted"
  | "closed";

export interface GateChatStatus {
  phase: GateChatPhase;
  /** 1-based visit of the gate's step in the run. */
  attempt: number;
  /** The execution currently waiting at the gate, if any. */
  waitingExecutionId: string | null;
}

const CLOSED_RUN_STATUSES = new Set<TaskRun["status"]>([
  "stopping",
  "stopped",
  "failed",
  "completed",
]);

function startedMs(execution: StepExecution): number {
  return safeMs(execution.started_at) ?? Number.NEGATIVE_INFINITY;
}

/**
 * Derive a gate chat's phase from its run and the run's step executions.
 * Acceptance is read from the routing that follows the submission: once a
 * route completes after it, a later non-route execution of another step
 * means the review let the run move on, while a loop-back makes the gate
 * wait again. Without such a route the chat stays under review until the
 * run closes.
 */
export function deriveGateChatStatus(
  gate: Pick<LocalChatGateBinding, "task_run_id" | "step_name">,
  run: TaskRun,
  executions: readonly StepExecution[]
): GateChatStatus | null {
  if (run.id !== gate.task_run_id) return null;
  const runExecutions = executions
    .filter((execution) => (execution.task_run_id ?? run.id) === run.id)
    .sort((a, b) => startedMs(a) - startedMs(b));
  const attempts = runExecutions.filter(
    (execution) =>
      execution.step_name === gate.step_name &&
      execution.step_type === "human_input"
  );
  const latest = attempts[attempts.length - 1];
  if (!latest) return null;
  const attempt = attempts.length;

  if (CLOSED_RUN_STATUSES.has(run.status)) {
    return { phase: "closed", attempt, waitingExecutionId: null };
  }
  if (run.status === "waiting" && !latest.completed_at && latest.id) {
    return {
      phase: attempt > 1 ? "rejected" : "drafting",
      attempt,
      waitingExecutionId: latest.id,
    };
  }

  const submittedMs = safeMs(latest.completed_at);
  if (submittedMs !== null) {
    const route = runExecutions.find(
      (execution) =>
        execution.step_type === "route" &&
        startedMs(execution) >= submittedMs &&
        safeMs(execution.completed_at) !== null
    );
    const routedMs = route ? safeMs(route.completed_at) : null;
    const movedOn =
      routedMs !== null &&
      runExecutions.some(
        (execution) =>
          execution.step_name !== gate.step_name &&
          execution.step_type !== "route" &&
          startedMs(execution) >= routedMs
      );
    if (movedOn) {
      return { phase: "accepted", attempt, waitingExecutionId: null };
    }
  }
  return { phase: "under_review", attempt, waitingExecutionId: null };
}

export function isSameGateChatStatus(
  a: GateChatStatus | null | undefined,
  b: GateChatStatus | null | undefined
): boolean {
  return (
    a?.phase === b?.phase &&
    a?.attempt === b?.attempt &&
    a?.waitingExecutionId === b?.waitingExecutionId
  );
}

/**
 * Whether a gate chat should start bound to its gate. A chat whose gate is
 * no longer waiting starts as a plain chat; re-entry rebinds it live.
 */
export function gateChatAcceptsSubmission(
  status: GateChatStatus | null | undefined
): boolean {
  return !status || status.phase === "drafting" || status.phase === "rejected";
}
