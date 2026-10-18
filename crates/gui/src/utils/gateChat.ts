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
  const attempt = context.attempt ?? 1;
  const revision =
    attempt > 1
      ? {
          attempt,
          verdict: handoffVerdict(context.execution?.handoff),
        }
      : null;
  return {
    task_run_id: run.id,
    step_name: stepName,
    execution_id: executionId,
    artifact,
    instructions: context.prompt,
    output_schema: jsonValue(context.outputSchema ?? null),
    revision,
  };
}

function handoffVerdict(handoff: string | null | undefined): JsonValue {
  if (!handoff) return null;
  try {
    const parsed: unknown = JSON.parse(handoff);
    return isJsonValue(parsed) ? parsed : handoff;
  } catch {
    return handoff;
  }
}

function jsonValue(value: unknown): JsonValue | null {
  return isJsonValue(value) ? value : null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

export interface GateResolutionSubmission {
  artifact: string;
  executionId: string;
  values: unknown;
}

export function parseGateResolutionSubmission(
  command: string,
  gate: LocalChatGateBinding
): GateResolutionSubmission | null {
  let words = shellWords(command);
  if (
    words.length >= 3 &&
    /^(?:\/.*\/)?(?:ba|z|a)sh$/.test(words[0]) &&
    (words[1] === "-c" || words[1] === "-lc")
  ) {
    words = shellWords(words.slice(2).join(" "));
  }
  const program = words[0] ?? "";
  if (!/(?:^|\/)vtb$/.test(program)) return null;
  if (words[1] !== "artifact" || words[2] !== "add") return null;

  let filename: string | null = null;
  let body: string | null = null;
  let subjectType: string | null = null;
  let subjectId: string | null = null;
  let logicalName: string | null = null;
  for (let index = 3; index < words.length; index++) {
    const word = words[index];
    if (word === "--json") continue;
    let flag = word;
    let value: string | null = null;
    if (flag.startsWith("--")) {
      const separator = flag.indexOf("=");
      if (separator > 0) {
        value = flag.slice(separator + 1);
        flag = flag.slice(2, separator);
      } else {
        value = words[++index] ?? null;
        flag = flag.slice(2);
      }
    } else {
      if (filename) return null;
      filename = word;
      continue;
    }
    if (value === null) return null;
    if (flag === "body") body = value;
    else if (flag === "subject-type") subjectType = value;
    else if (flag === "subject-id") subjectId = value;
    else if (flag === "logical-name") logicalName = value;
    else return null;
  }
  if (
    filename !== `${gate.artifact}.json` ||
    body === null ||
    subjectType !== "step_execution" ||
    !subjectId ||
    logicalName !== gate.artifact
  )
    return null;
  try {
    return {
      artifact: gate.artifact,
      executionId: subjectId,
      values: JSON.parse(body),
    };
  } catch {
    return null;
  }
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (quote === "'") current += char;
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === "'") {
      quote = "'";
      started = true;
      continue;
    }
    if (char === '"') {
      quote = '"';
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current || started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
  }
  if (quote || escaped) return [];
  if (current || started) words.push(current);
  return words;
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
