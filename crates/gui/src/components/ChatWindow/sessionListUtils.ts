import type { ChatMessage } from "../../stores/chatStore";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

/** Custom event name used to scroll a session's thread to a spawned-agent turn. */
export const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";

export type SpawnOutlineItem = {
  id: string;
  spawnId: string;
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

type AgentOutlineSource = {
  key: string;
  name: string;
  role: string;
  status: string;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(
  source: Record<string, unknown>,
  fields: readonly string[]
): string {
  for (const field of fields) {
    const value = stringValue(source[field]);
    if (value) return value;
  }
  return "";
}

function collectAgentRows(input: Record<string, unknown>): AgentOutlineSource[] {
  const rows = new Map<string, AgentOutlineSource>();
  const addRow = (source: Record<string, unknown>, fallbackKey: string) => {
    const threadId = stringField(source, [
      "thread_id",
      "threadId",
      "receiver_thread_id",
      "receiverThreadId",
    ]);
    const name = stringField(source, [
      "agent_nickname",
      "agentNickname",
      "new_agent_nickname",
      "newAgentNickname",
      "receiver_agent_nickname",
      "receiverAgentNickname",
      "nickname",
      "name",
    ]);
    const role = stringField(source, [
      "agent_role",
      "agentRole",
      "new_agent_role",
      "newAgentRole",
      "receiver_agent_role",
      "receiverAgentRole",
      "agent_type",
      "agentType",
      "role",
    ]);
    const statusValue = source.status;
    const status =
      typeof statusValue === "string"
        ? statusValue
        : stringField(recordValue(statusValue) ?? {}, ["status", "message"]);
    const key = threadId || name || role || fallbackKey;
    if (!rows.has(key)) {
      rows.set(key, { key, name, role, status });
      return;
    }
    const previous = rows.get(key);
    if (!previous) return;
    rows.set(key, {
      key,
      name: previous.name || name,
      role: previous.role || role,
      status: previous.status || status,
    });
  };

  for (const field of [
    "receiver_agents",
    "receiverAgents",
    "agent_statuses",
    "agentStatuses",
  ]) {
    const agents = input[field];
    if (!Array.isArray(agents)) continue;
    agents.forEach((agent, index) => {
      const record = recordValue(agent);
      if (record) addRow(record, `${field}-${index}`);
    });
  }

  const agentsStates =
    recordValue(input.agents_states) ?? recordValue(input.agentsStates);
  if (agentsStates) {
    for (const [threadId, state] of Object.entries(agentsStates)) {
      const stateRecord = recordValue(state);
      addRow(
        {
          ...(stateRecord ?? {}),
          thread_id: threadId,
          status: stringValue(state) || stateRecord?.status,
        },
        threadId
      );
    }
  }

  const receiverThreadIds =
    input.receiver_thread_ids ?? input.receiverThreadIds ?? [];
  if (Array.isArray(receiverThreadIds)) {
    receiverThreadIds.forEach((threadId, index) => {
      const value = stringValue(threadId);
      if (value) addRow({ thread_id: value }, `receiver-${index}`);
    });
  }

  const singleAgentName = stringField(input, [
    "agent_nickname",
    "agentNickname",
    "new_agent_nickname",
    "newAgentNickname",
    "receiver_agent_nickname",
    "receiverAgentNickname",
  ]);
  const singleAgentRole = stringField(input, [
    "agent_role",
    "agentRole",
    "new_agent_role",
    "newAgentRole",
    "receiver_agent_role",
    "receiverAgentRole",
  ]);
  if (singleAgentName || singleAgentRole) {
    addRow(
      {
        agent_nickname: singleAgentName,
        agent_role: singleAgentRole,
      },
      "agent"
    );
  }

  return Array.from(rows.values());
}

function shortThreadLabel(threadId: string): string {
  return threadId.length > 8 ? threadId.slice(-8) : threadId;
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
    .flatMap((message) => {
      const input = parseToolInput(message.input);
      const description = stringValue(input.description);
      const subagent = stringValue(input.subagent_type);
      const agents = collectAgentRows(input);
      if (agents.length === 0) {
        return [
          {
            id: message.toolId,
            spawnId: message.toolId,
            label: description || "Agent",
            detail: subagent || message.toolName,
          },
        ];
      }
      return agents.map((agent, index) => ({
        id: `${message.toolId}:${agent.key || index}`,
        spawnId: message.toolId,
        label:
          agent.name ||
          (agent.key ? `Agent ${shortThreadLabel(agent.key)}` : "Agent"),
        detail: agent.role || agent.status || subagent || message.toolName,
      }));
    });
}

export function scrollToSpawn(sessionId: string, spawnId: string): void {
  window.dispatchEvent(
    new CustomEvent(LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT, {
      detail: { sessionId, spawnId },
    })
  );
}
