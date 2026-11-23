import type { ChatMessage } from "../../stores/chatStore";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

/** Custom event name used to scroll a session's thread to a spawned-agent turn. */
export const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";

export type SpawnOutlineItem = {
  parentThreadId?: string;
  sessionId?: string;
  id: string;
  spawnId: string;
  threadId?: string;
  label: string;
  detail: string;
  isWorking?: boolean;
  depth?: number;
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

/** Build history lineage without loading any conversation messages. Missing
 * parents stay top-level; cycles are ignored so no session disappears. */
export function buildHistoryChildOutlines(
  sessions: LocalChatSessionSummary[]
): Map<string, SpawnOutlineItem[]> {
  const byThread = new Map(
    sessions
      .filter((s) => s.providerResumeId)
      .map((s) => [`${s.harness}:${s.providerResumeId}`, s])
  );

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const parentOf = (session: LocalChatSessionSummary) =>
    (session.parentChatId ? byId.get(session.parentChatId) : undefined) ??
    byThread.get(`${session.harness}:${session.providerParentResumeId}`);
  const children = new Map<string, LocalChatSessionSummary[]>();

  for (const session of sessions) {
    const parent = parentOf(session);
    if (!parent) continue;

    const seen = new Set([session.id]);
    let ancestor: LocalChatSessionSummary | undefined = parent;
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestor = parentOf(ancestor);
    }
    if (ancestor) continue;

    const siblings = children.get(parent.id) ?? [];
    siblings.push(session);
    children.set(parent.id, siblings);
  }

  const result = new Map<string, SpawnOutlineItem[]>();

  const visit = (id: string): SpawnOutlineItem[] => {
    const rows: SpawnOutlineItem[] = [];

    for (const child of (children.get(id) ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )) {
      rows.push({
        id: child.id,
        sessionId: child.id,
        spawnId: child.providerResumeId ?? child.id,
        threadId: child.providerResumeId ?? undefined,
        label: child.title || child.label,
        detail: "",
        depth: 0,
      });

      for (const row of visit(child.id))
        rows.push({ ...row, depth: (row.depth ?? 0) + 1 });
    }
    return rows;
  };

  for (const session of sessions) result.set(session.id, visit(session.id));

  return result;
}

/** Merge live discovery with persisted lineage without moving a child to a sibling branch. */
export function mergeChildOutlineGroups(
  discovered: SpawnOutlineItem[],
  history: SpawnOutlineItem[]
): SpawnOutlineItem[][] {
  type Node = { row: SpawnOutlineItem; children: Node[] };
  const roots: Node[] = [];
  for (const outline of [discovered, history]) {
    const ancestors: Node[] = [];
    for (const row of outline) {
      const depth = Math.min(row.depth ?? 0, ancestors.length);
      const siblings = ancestors[depth - 1]?.children ?? roots;
      let node = siblings.find(
        ({ row: existing }) =>
          existing.id === row.id ||
          (!!row.threadId && row.threadId === existing.threadId)
      );
      if (!node) {
        node = { row, children: [] };
        siblings.push(node);
      }
      ancestors.splice(depth, ancestors.length - depth, node);
    }
  }

  const flatten = (node: Node, depth: number): SpawnOutlineItem[] => [
    { ...node.row, depth },
    ...node.children.flatMap((child) => flatten(child, depth + 1)),
  ];
  return roots.map((root) => flatten(root, 0));
}

/**
 * One open session's child outline: live discovery merged with persisted
 * lineage, plus transcript spawns neither source knows, in transcript order.
 * Rows under a hidden thread stay hidden with it.
 */
export function buildSessionChildOutline(
  session: {
    harness: string;
    providerResumeId: string | null;
    messages: readonly ChatMessage[];
  },
  discovered: readonly SpawnOutlineItem[],
  history: SpawnOutlineItem[],
  hiddenThreads: ReadonlySet<string>
): SpawnOutlineItem[] {
  const hidden = (id?: string) =>
    !!id && hiddenThreads.has(`${session.harness}:${id}`);
  const blocked = new Set<string>();
  const visibleDiscovered = discovered.filter((row) => {
    if (
      !hidden(row.threadId) &&
      (!row.parentThreadId || !blocked.has(row.parentThreadId))
    )
      return true;
    if (row.threadId) blocked.add(row.threadId);
    return false;
  });
  // Discovery works even when the spawn is outside the loaded parent page.
  const groups = mergeChildOutlineGroups(visibleDiscovered, history);
  const childRows = groups.flat();

  for (const row of buildSpawnOutline(session.messages)) {
    if (row.threadId === session.providerResumeId || hidden(row.threadId))
      continue;
    if (
      !childRows.some(
        (child) =>
          (row.threadId && row.threadId === child.threadId) ||
          row.spawnId === child.spawnId
      )
    )
      groups.push([row]);
  }

  const positions = new Map(
    session.messages.flatMap((message, index) =>
      message.kind === "tool_call" ? [[message.toolId, index] as const] : []
    )
  );
  const position = (row: SpawnOutlineItem) =>
    positions.get(row.spawnId) ??
    (row.id.startsWith("local-chat-") ? Number.MAX_SAFE_INTEGER : -1);

  return groups
    .sort((left, right) => position(left[0]) - position(right[0]))
    .flat();
}
