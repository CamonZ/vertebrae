import type {
  ChatMessage,
  ChatScope,
  ChatSession,
  LocalChatLifecycle,
} from "../stores/chatStore";

const STORAGE_KEY = "local-chat-sessions:v1";
const CLEARED_KEY_PREFIX = `${STORAGE_KEY}:cleared:`;
const VALID_SCOPES = new Set<ChatScope>([
  "project",
  "workflow",
  "task",
  "step",
]);
const DURABLE_LIFECYCLES = new Set<LocalChatLifecycle>(["idle", "closed"]);

function canUseStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function normalizeSession(value: unknown): ChatSession | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<ChatSession>;
  if (typeof candidate.id !== "string") return null;
  if (!VALID_SCOPES.has(candidate.scope as ChatScope)) return null;
  if (
    candidate.entityId !== null &&
    candidate.entityId !== undefined &&
    typeof candidate.entityId !== "string"
  ) {
    return null;
  }
  if (typeof candidate.label !== "string") return null;
  if (!Array.isArray(candidate.messages)) return null;
  if (candidate.status !== "open" && candidate.status !== "closed") return null;

  const lifecycle =
    typeof candidate.lifecycle === "string" &&
    DURABLE_LIFECYCLES.has(candidate.lifecycle as LocalChatLifecycle)
      ? (candidate.lifecycle as LocalChatLifecycle)
      : candidate.status === "closed"
        ? "closed"
        : "idle";

  return {
    id: candidate.id,
    scope: candidate.scope as ChatScope,
    entityId: candidate.entityId ?? null,
    label: candidate.label,
    messages: durableMessages(candidate.messages),
    status: candidate.status,
    claudeSessionId:
      typeof candidate.claudeSessionId === "string"
        ? candidate.claudeSessionId
        : null,
    claudeConversationId:
      typeof candidate.claudeConversationId === "string"
        ? candidate.claudeConversationId
        : null,
    contextSummary:
      typeof candidate.contextSummary === "string"
        ? candidate.contextSummary
        : null,
    projectPath:
      typeof candidate.projectPath === "string" ? candidate.projectPath : null,
    model: typeof candidate.model === "string" ? candidate.model : undefined,
    tokenUsage:
      candidate.tokenUsage &&
      typeof candidate.tokenUsage.used === "number" &&
      typeof candidate.tokenUsage.max === "number"
        ? {
            used: candidate.tokenUsage.used,
            max: candidate.tokenUsage.max,
          }
        : undefined,
    isDetached: false,
    lifecycle,
    lifecycleError: null,
    streamingAssistant: null,
  };
}

function durableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) => message.kind !== "assistant" || !message.isPartial
  );
}

function serializeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: durableMessages(session.messages),
    claudeSessionId: null,
    projectPath: session.projectPath ?? null,
    isDetached: false,
    lifecycle: session.lifecycle === "closed" ? "closed" : "idle",
    lifecycleError: null,
    streamingAssistant: null,
  };
}

function readSessions(): Record<string, ChatSession> {
  if (!canUseStorage()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const entries = Array.isArray(parsed)
      ? parsed.map((session) => {
          const normalized = normalizeSession(session);
          return [normalized?.id, normalized];
        })
      : Object.entries(parsed).map(([id, session]) => [
          id,
          normalizeSession(session),
        ]);

    return Object.fromEntries(
      entries.filter(
        (entry): entry is [string, ChatSession] =>
          typeof entry[0] === "string" && entry[1] !== null
      )
    );
  } catch {
    return {};
  }
}

function writeSessions(sessions: Record<string, ChatSession>): void {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Storage can be disabled or full; local in-memory chat still works.
  }
}

function projectPathMatches(
  sessionProjectPath: string | null | undefined,
  requestedProjectPath: string | null | undefined
): boolean {
  if (requestedProjectPath === undefined) return true;
  if (sessionProjectPath === undefined || sessionProjectPath === null) {
    return true;
  }
  return sessionProjectPath === requestedProjectPath;
}

export function loadPersistedLocalChatSessions(): Record<string, ChatSession> {
  return Object.fromEntries(
    Object.entries(readSessions()).filter(
      (entry): entry is [string, ChatSession] => entry[1].status === "open"
    )
  );
}

export function loadPersistedLocalChatSession(
  sessionId: string
): ChatSession | null {
  return readSessions()[sessionId] ?? null;
}

export function findPersistedLocalChatSession(
  scope: ChatScope,
  entityId: string | null,
  projectPath?: string | null
): ChatSession | null {
  return (
    Object.values(readSessions()).find(
      (session) =>
        session.status === "open" &&
        session.scope === scope &&
        session.entityId === entityId &&
        projectPathMatches(session.projectPath, projectPath)
    ) ?? null
  );
}

export function persistLocalChatSession(session: ChatSession): void {
  const sessions = readSessions();
  sessions[session.id] = serializeSession(session);
  writeSessions(sessions);
  clearLocalChatSessionCleared(session.id);
}

export function removePersistedLocalChatSession(sessionId: string): void {
  const sessions = readSessions();
  delete sessions[sessionId];
  writeSessions(sessions);
}

export function clearPersistedLocalChatSessions(): void {
  if (!canUseStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function markLocalChatSessionCleared(sessionId: string): void {
  removePersistedLocalChatSession(sessionId);
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(`${CLEARED_KEY_PREFIX}${sessionId}`, "1");
  } catch {
    // Storage can be disabled; in-memory clear still applies.
  }
}

export function isLocalChatSessionCleared(sessionId: string): boolean {
  if (!canUseStorage()) return false;
  try {
    return localStorage.getItem(`${CLEARED_KEY_PREFIX}${sessionId}`) !== null;
  } catch {
    return false;
  }
}

export function clearLocalChatSessionCleared(sessionId: string): void {
  if (!canUseStorage()) return;
  try {
    localStorage.removeItem(`${CLEARED_KEY_PREFIX}${sessionId}`);
  } catch {
    // Nothing to clear.
  }
}

export const LOCAL_CHAT_SESSIONS_STORAGE_KEY = STORAGE_KEY;
