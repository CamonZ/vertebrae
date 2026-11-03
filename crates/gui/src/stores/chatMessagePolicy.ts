import type { ChatMessage } from "./chatStore";

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  return typeof value === "string" ? [value] : [];
}

function toolCallReferencesThread(
  message: Extract<ChatMessage, { kind: "tool_call" }>,
  threadId: string
): boolean {
  const input = parseJsonObjectInput(message.input);
  if (!input) return false;

  const directThreadIds = [
    ...stringArrayValue(input.receiver_thread_ids),
    ...stringArrayValue(input.receiverThreadIds),
    ...stringArrayValue(input.thread_id),
    ...stringArrayValue(input.threadId),
    ...stringArrayValue(input.agent_path),
    ...stringArrayValue(input.agentPath),
  ];
  if (directThreadIds.includes(threadId)) return true;

  const receiverAgents =
    Array.isArray(input.receiver_agents) || Array.isArray(input.receiverAgents)
      ? (input.receiver_agents ?? input.receiverAgents)
      : [];

  return Array.isArray(receiverAgents)
    ? receiverAgents.some((agent) => {
        if (!agent || typeof agent !== "object") return false;

        const record = agent as Record<string, unknown>;
        return [
          ...stringArrayValue(record.thread_id),
          ...stringArrayValue(record.threadId),
          ...stringArrayValue(record.agent_path),
          ...stringArrayValue(record.agentPath),
        ].includes(threadId);
      })
    : false;
}

function isAgentSpawnToolName(toolName: string): boolean {
  return ["agent", "task"].includes(toolName.trim().toLowerCase());
}

export function isSelfProviderAgentToolCall(
  message: ChatMessage,
  providerResumeId: string | null | undefined
): boolean {
  return (
    !!providerResumeId &&
    message.kind === "tool_call" &&
    !message.parentToolUseId &&
    isAgentSpawnToolName(message.toolName) &&
    toolCallReferencesThread(message, providerResumeId)
  );
}

export function sanitizeSessionMessages(
  messages: ChatMessage[],
  providerResumeId: string | null | undefined
): ChatMessage[] {
  const askUserQuestionToolIds = new Set(
    messages
      .filter(
        (message): message is Extract<ChatMessage, { kind: "tool_call" }> =>
          message.kind === "tool_call" && message.toolName === "AskUserQuestion"
      )
      .map((message) => message.toolId)
  );
  const selfAgentToolIds = new Set<string>();

  const filtered = messages.filter((message) => {
    if (
      (message.kind === "tool_call" || message.kind === "tool_result") &&
      askUserQuestionToolIds.has(message.toolId)
    ) {
      return false;
    }

    if (
      providerResumeId &&
      message.kind === "tool_call" &&
      isSelfProviderAgentToolCall(message, providerResumeId)
    ) {
      selfAgentToolIds.add(message.toolId);
      return false;
    }

    if (
      (message.kind === "tool_result" ||
        message.kind === "assistant" ||
        message.kind === "tool_call") &&
      message.parentToolUseId &&
      selfAgentToolIds.has(message.parentToolUseId)
    ) {
      return false;
    }

    if (
      message.kind === "tool_result" &&
      selfAgentToolIds.has(message.toolId)
    ) {
      return false;
    }

    return true;
  });

  return filtered.length === messages.length ? messages : filtered;
}

export function parseJsonObjectInput(
  input: string
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep non-JSON tool inputs unchanged.
  }

  return null;
}
