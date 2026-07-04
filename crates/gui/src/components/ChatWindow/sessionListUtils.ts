import type { ChatMessage } from "../../stores/chatStore";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

/** Custom event name used to scroll a session's thread to a spawned-agent turn. */
export const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";

export type SpawnOutlineItem = {
  id: string;
  spawnId: string;
  threadId?: string;
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

type SpawnOutlineCandidate = SpawnOutlineItem & {
  agentKey: string;
  isSpawn: boolean;
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

function collectAgentRows(
  input: Record<string, unknown>
): AgentOutlineSource[] {
  const rows = new Map<string, AgentOutlineSource>();
  const receiverThreadIds =
    input.receiver_thread_ids ?? input.receiverThreadIds ?? [];
  const receiverThreadIdAt = (index: number): string => {
    if (!Array.isArray(receiverThreadIds)) return "";
    return stringValue(receiverThreadIds[index]);
  };

  const addRow = (source: Record<string, unknown>, fallbackKey: string) => {
    const threadId = stringField(source, [
      "thread_id",
      "threadId",
      "receiver_thread_id",
      "receiverThreadId",
      "agent_id",
      "agentId",
      "agent_path",
      "agentPath",
      "path",
      "id",
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
    const existingKey = findMergeKey(rows, { key, name, threadId });
    if (!existingKey) {
      rows.set(key, { key, name, role, status });
      return;
    }
    const previous = rows.get(existingKey);
    if (!previous) return;
    rows.delete(existingKey);
    rows.set(threadId || previous.key || key, {
      key: threadId || previous.key || key,
      name: previous.name || name,
      role: previous.role || role,
      status: status || previous.status,
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
      if (record) {
        addRow(
          {
            thread_id:
              stringField(record, ["thread_id", "threadId"]) ||
              receiverThreadIdAt(index),
            ...record,
          },
          `${field}-${index}`
        );
      }
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
        thread_id: receiverThreadIdAt(0),
        agent_nickname: singleAgentName,
        agent_role: singleAgentRole,
      },
      "agent"
    );
  }

  return Array.from(rows.values());
}

function findMergeKey(
  rows: Map<string, AgentOutlineSource>,
  incoming: { key: string; name: string; threadId: string }
): string | null {
  if (rows.has(incoming.key)) return incoming.key;
  for (const [key, row] of rows) {
    if (incoming.name && row.name === incoming.name) return key;
    if (incoming.threadId && row.key === incoming.threadId) return key;
  }
  if (rows.size !== 1) return null;
  const [[key, row]] = Array.from(rows.entries());
  if (incoming.name && !row.name) return key;
  if (incoming.threadId && row.name && !incoming.name) return key;
  return null;
}

function shortThreadLabel(threadId: string): string {
  return threadId.length > 8 ? threadId.slice(-8) : threadId;
}

export function buildSpawnOutline(
  messages: readonly ChatMessage[]
): SpawnOutlineItem[] {
  const byAgent = new Map<string, SpawnOutlineCandidate>();

  messages.forEach((message) => {
    if (
      message.kind !== "tool_call" ||
      message.parentToolUseId ||
      !isAgentSpawnTool(message.toolName)
    ) {
      return;
    }

    const input = parseToolInput(message.input);
    const isSpawn = isSpawnAgentCall(input);
    const description = stringValue(input.description);
    const subagent = stringValue(input.subagent_type);
    const agents = collectAgentRows(input);
    if (agents.length === 0) {
      if (isSpawn) {
        mergeSpawnCandidate(byAgent, {
          agentKey: message.toolId,
          isSpawn,
          id: message.toolId,
          spawnId: message.toolId,
          threadId: undefined,
          label: description || "Agent",
          detail: subagent || message.toolName,
        });
      }
      return;
    }

    agents.forEach((agent, index) => {
      mergeSpawnCandidate(byAgent, {
        agentKey: agent.key || `${message.toolId}:${index}`,
        isSpawn,
        id: `${message.toolId}:${agent.key || index}`,
        spawnId: message.toolId,
        threadId: agent.key || undefined,
        label:
          agent.name ||
          (agent.key ? `Agent ${shortThreadLabel(agent.key)}` : "Agent"),
        detail: agent.status || agent.role || subagent || message.toolName,
      });
    });
  });

  return Array.from(byAgent.values())
    .filter((candidate) => candidate.isSpawn)
    .map((candidate) => ({
      id: candidate.id,
      spawnId: candidate.spawnId,
      ...(candidate.threadId ? { threadId: candidate.threadId } : {}),
      label: candidate.label,
      detail: candidate.detail,
    }));
}

function isSpawnAgentCall(input: Record<string, unknown>): boolean {
  const collabTool = stringValue(input.collab_tool ?? input.collabTool);
  return !collabTool || collabTool === "spawnAgent";
}

function mergeSpawnCandidate(
  byAgent: Map<string, SpawnOutlineCandidate>,
  candidate: SpawnOutlineCandidate
): void {
  const mergeKey = findCandidateMergeKey(byAgent, candidate);
  const previous = mergeKey ? byAgent.get(mergeKey) : undefined;
  if (!previous) {
    byAgent.set(candidate.agentKey, candidate);
    return;
  }

  byAgent.delete(previous.agentKey);
  byAgent.set(candidate.agentKey || previous.agentKey, {
    agentKey: candidate.agentKey || previous.agentKey,
    isSpawn: previous.isSpawn || candidate.isSpawn,
    id: previous.isSpawn ? previous.id : candidate.id,
    spawnId: previous.isSpawn ? previous.spawnId : candidate.spawnId,
    threadId: candidate.threadId ?? previous.threadId,
    label: betterLabel(previous.label, candidate.label),
    detail: betterDetail(previous.detail, candidate.detail),
  });
}

function findCandidateMergeKey(
  byAgent: Map<string, SpawnOutlineCandidate>,
  candidate: SpawnOutlineCandidate
): string | null {
  if (byAgent.has(candidate.agentKey)) return candidate.agentKey;
  const candidateSuffix = shortThreadLabel(candidate.agentKey);
  for (const [key, previous] of byAgent) {
    const previousSuffix = shortThreadLabel(key);
    if (candidateSuffix && previous.label === `Agent ${candidateSuffix}`) {
      return key;
    }
    if (previousSuffix && candidate.label === `Agent ${previousSuffix}`) {
      return key;
    }
    if (
      candidateSuffix &&
      previousSuffix &&
      candidateSuffix === previousSuffix
    ) {
      return key;
    }
  }
  return null;
}

function betterLabel(previous: string, next: string): string {
  if (!previous || /^Agent(?:\s|$)/.test(previous)) return next || previous;
  if (next && !/^Agent(?:\s|$)/.test(next)) return next;
  return previous;
}

function betterDetail(previous: string, next: string): string {
  if (!next) return previous;
  if (isLifecycleStatus(next)) return formatLifecycleStatus(next);
  if (isLifecycleStatus(previous)) return formatLifecycleStatus(previous);
  return next || previous;
}

function isLifecycleStatus(value: string): boolean {
  return /^(pending_?init|running|completed|failed|cancelled|canceled|timed_?out|error)$/i.test(
    value.trim()
  );
}

function formatLifecycleStatus(value: string): string {
  return value.trim().replace(/_/g, " ");
}

export function scrollToSpawn(sessionId: string, spawnId: string): void {
  window.dispatchEvent(
    new CustomEvent(LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT, {
      detail: { sessionId, spawnId },
    })
  );
}
