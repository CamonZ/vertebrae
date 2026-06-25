import type {
  ChatMessage,
  ChatScope,
  ChatSession,
  LocalChatLifecycle,
} from "../stores/chatStore";
import type { PermissionMode } from "../bindings";

const STORAGE_KEY = "local-chat-sessions:v1";
const MODEL_STORAGE_KEY = "local-chat-model:last-used:v1";
const CLEARED_KEY_PREFIX = `${STORAGE_KEY}:cleared:`;
const VALID_SCOPES = new Set<ChatScope>([
  "project",
  "workflow",
  "task",
  "step",
]);
const VALID_PERMISSION_MODES = new Set<PermissionMode>([
  "accept_edits",
  "auto",
  "bypass_permissions",
  "default",
  "dont_ask",
  "plan",
]);
const DURABLE_LIFECYCLES = new Set<LocalChatLifecycle>(["idle", "closed"]);
const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export interface LocalChatSessionSummary {
  id: string;
  scope: ChatScope;
  entityId: string | null;
  label: string;
  preview: string;
  model?: string;
  selectedModelId?: string | null;
  createdAt: string;
  updatedAt: string;
  projectPath: string | null;
  claudeConversationId: string | null;
  messageCount: number;
  lifecycle: LocalChatLifecycle;
}

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

  const messages = durableMessages(candidate.messages);
  const createdAt = normalizeTimestamp(candidate.createdAt, messages, "first");
  const updatedAt = normalizeTimestamp(
    candidate.updatedAt,
    messages,
    "last",
    createdAt
  );
  const preview =
    typeof candidate.preview === "string"
      ? candidate.preview
      : buildPreview(messages);

  return {
    id: candidate.id,
    scope: candidate.scope as ChatScope,
    entityId: candidate.entityId ?? null,
    label: candidate.label,
    messages,
    status: candidate.status,
    claudeSessionId: null,
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
    selectedModelId:
      typeof candidate.selectedModelId === "string"
        ? candidate.selectedModelId
        : candidate.selectedModelId === null
          ? null
          : undefined,
    permissionMode:
      typeof candidate.permissionMode === "string" &&
      VALID_PERMISSION_MODES.has(candidate.permissionMode as PermissionMode)
        ? (candidate.permissionMode as PermissionMode)
        : candidate.permissionMode === null
          ? null
          : "default",
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
    createdAt,
    updatedAt,
    preview,
  };
}

function durableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) => message.kind !== "assistant" || !message.isPartial
  );
}

function messageText(message: ChatMessage): string | null {
  switch (message.kind) {
    case "user":
    case "assistant":
      return message.text;
    case "error":
    case "warning":
      return message.message;
    case "tool_call":
      return `${message.toolName} ${message.input}`;
    case "tool_result":
      return message.result;
    case "permission_request":
      return message.message;
    case "session_start":
      return `Started ${message.model}`;
    case "session_end":
      return "Session ended";
  }
}

function buildPreview(messages: ChatMessage[]): string {
  const lastText = [...messages]
    .reverse()
    .map(messageText)
    .find((text) => text && text.trim().length > 0);
  return (lastText ?? "No messages yet").replace(/\s+/g, " ").trim();
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeTimestamp(
  value: unknown,
  messages: ChatMessage[],
  position: "first" | "last",
  fallback = FALLBACK_TIMESTAMP
): string {
  if (isIsoTimestamp(value)) return value;
  const ordered = position === "first" ? messages : [...messages].reverse();
  const messageTimestamp = ordered.find((message) =>
    isIsoTimestamp(message.timestamp)
  )?.timestamp;
  return messageTimestamp ?? fallback;
}

function serializeSession(
  session: ChatSession,
  previous?: ChatSession | null
): ChatSession {
  const messages = durableMessages(session.messages);
  const createdAt =
    session.createdAt ??
    previous?.createdAt ??
    normalizeTimestamp(undefined, messages, "first", new Date().toISOString());
  const updatedAt =
    session.updatedAt ??
    normalizeTimestamp(undefined, messages, "last", new Date().toISOString());

  return {
    ...session,
    messages,
    claudeSessionId: null,
    projectPath: session.projectPath ?? null,
    permissionMode: session.permissionMode ?? "default",
    isDetached: false,
    lifecycle: session.lifecycle === "closed" ? "closed" : "idle",
    lifecycleError: null,
    streamingAssistant: null,
    createdAt,
    updatedAt,
    preview: buildPreview(messages),
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

export function projectPathMatches(
  sessionProjectPath: string | null | undefined,
  requestedProjectPath: string | null | undefined
): boolean {
  if (requestedProjectPath === undefined) return true;
  if (requestedProjectPath === null) return false;
  if (sessionProjectPath === undefined || sessionProjectPath === null)
    return false;
  return sessionProjectPath === requestedProjectPath;
}

export function loadPersistedLocalChatSessions(): Record<string, ChatSession> {
  return Object.fromEntries(
    Object.entries(readSessions()).filter(
      (entry): entry is [string, ChatSession] => entry[1].status === "open"
    )
  );
}

export function listPersistedLocalChatSessions(
  projectPath?: string | null
): LocalChatSessionSummary[] {
  return Object.values(readSessions())
    .filter(
      (session) =>
        session.status === "open" &&
        projectPathMatches(session.projectPath, projectPath)
    )
    .map((session) => ({
      id: session.id,
      scope: session.scope,
      entityId: session.entityId,
      label: session.label,
      preview: session.preview ?? buildPreview(session.messages),
      model: session.model,
      selectedModelId: session.selectedModelId,
      createdAt: session.createdAt ?? FALLBACK_TIMESTAMP,
      updatedAt: session.updatedAt ?? session.createdAt ?? FALLBACK_TIMESTAMP,
      projectPath: session.projectPath ?? null,
      claudeConversationId: session.claudeConversationId,
      messageCount: session.messages.length,
      lifecycle: session.lifecycle ?? "idle",
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
  sessions[session.id] = serializeSession(session, sessions[session.id]);
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

export function loadLastUsedLocalChatModelId(): string | null {
  if (!canUseStorage()) return null;
  try {
    const value = localStorage.getItem(MODEL_STORAGE_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function persistLastUsedLocalChatModelId(modelId: string): void {
  if (!canUseStorage()) return;
  const trimmed = modelId.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, trimmed);
  } catch {
    // Storage can be disabled or full; the per-session selection still works.
  }
}

export function clearLastUsedLocalChatModelId(): void {
  if (!canUseStorage()) return;
  try {
    localStorage.removeItem(MODEL_STORAGE_KEY);
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
export const LOCAL_CHAT_MODEL_STORAGE_KEY = MODEL_STORAGE_KEY;
