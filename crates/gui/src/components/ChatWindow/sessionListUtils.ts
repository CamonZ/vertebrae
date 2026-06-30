import type { ChatMessage } from "../../stores/chatStore";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

/** Custom event name used to scroll a session's thread to a spawned-agent turn. */
export const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";

export type SpawnOutlineItem = {
  id: string;
  label: string;
  detail: string;
};

export function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function formatSessionModel(session: LocalChatSessionSummary): string {
  const model = session.model?.trim() || session.selectedModelId?.trim();
  return model ? model.replace(/^claude-/i, "") : "Chat";
}

export function isAgentSpawnTool(toolName: string): boolean {
  return /^(agent|task)$/i.test(toolName);
}

export function parseToolInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty input.
  }
  return {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildSpawnOutline(
  messages: readonly ChatMessage[]
): SpawnOutlineItem[] {
  return messages
    .filter(
      (message): message is Extract<ChatMessage, { kind: "tool_call" }> =>
        message.kind === "tool_call" &&
        !message.parentToolUseId &&
        isAgentSpawnTool(message.toolName)
    )
    .map((message) => {
      const input = parseToolInput(message.input);
      const description = stringValue(input.description);
      const subagent = stringValue(input.subagent_type);
      return {
        id: message.toolId,
        label: description || "Agent",
        detail: subagent || message.toolName,
      };
    });
}

export function scrollToSpawn(sessionId: string, spawnId: string): void {
  window.dispatchEvent(
    new CustomEvent(LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT, {
      detail: { sessionId, spawnId },
    })
  );
}
