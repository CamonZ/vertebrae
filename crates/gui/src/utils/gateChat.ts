import type { JsonValue, LocalChatGateBinding } from "../bindings";
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
