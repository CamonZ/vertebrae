import type {
  ChatMessage,
  ChatSession,
  ChatTitleStatus,
  LocalChatLifecycle,
} from "../stores/chatStore";
import type { LocalChatHarnessKind, PermissionMode } from "../bindings";
import { commands } from "../bindings";

const MODEL_STORAGE_KEY = "local-chat-model:last-used:v1";
const CLEARED_KEY_PREFIX = "local-chat-session-cleared:v1:";
export const DEFAULT_LOCAL_CHAT_HARNESS: LocalChatHarnessKind = "claude";
const VALID_LOCAL_CHAT_HARNESSES = new Set<LocalChatHarnessKind>([
  "claude",
  "codex",
]);
const VALID_PERMISSION_MODES = new Set<PermissionMode>([
  "accept_edits",
  "auto",
  "bypass_permissions",
  "default",
  "dont_ask",
  "plan",
]);
const VALID_LIFECYCLES = new Set<LocalChatLifecycle>([
  "idle",
  "starting",
  "resuming",
  "sending",
  "streaming",
  "closing",
  "closed",
  "error",
]);
const DURABLE_LIFECYCLES = new Set<LocalChatLifecycle>(["idle", "closed"]);
const VALID_TITLE_STATUSES = new Set<ChatTitleStatus>([
  "pending",
  "low_confidence",
  "generated",
  "manual",
]);
const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

type LocalChatSessionIndexEntry = LocalChatSessionSummary & {
  status: "open" | "closed";
  permissionMode?: PermissionMode | null;
};

type LocalChatSessionIndexCommands = typeof commands & {
  loadLocalChatSessionIndex?: () => Promise<{
    status: "ok";
    data: unknown[];
  } | {
    status: "error";
    error: unknown;
  }>;
  saveLocalChatSessionIndex?: (input: {
    sessions: LocalChatSessionIndexEntry[];
  }) => Promise<{ status: "ok"; data: null } | { status: "error"; error: unknown }>;
};

let sessionIndexCache: Record<string, ChatSession> = {};
let indexSaveInFlight = false;
let indexSaveQueued = false;
let sessionIndexHydrated = false;
let sessionIndexHydratePromise: Promise<boolean> | null = null;

export interface LocalChatSessionSummary {
  id: string;
  label: string;
  title?: string | null;
  titleStatus?: ChatTitleStatus;
  titleConfidence?: number | null;
  titleUserMessageCount?: number;
  harness: LocalChatHarnessKind;
  model?: string;
  selectedModelId?: string | null;
  selectedReasoningEffort?: string | null;
  createdAt: string;
  updatedAt: string;
  projectPath: string | null;
  providerResumeId: string | null;
  threadTotalTokens?: number;
  messageCount: number;
  lifecycle: LocalChatLifecycle;
}

type LocalChatSessionRecord = Partial<ChatSession>;

interface NormalizeSessionOptions {
  preserveRuntimeBackendSessionId?: boolean;
}

function canUseStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function normalizeHarness(value: unknown): LocalChatHarnessKind {
  return typeof value === "string" &&
    VALID_LOCAL_CHAT_HARNESSES.has(value as LocalChatHarnessKind)
    ? (value as LocalChatHarnessKind)
    : DEFAULT_LOCAL_CHAT_HARNESS;
}

function normalizeRuntimeBackendSessionId(
  candidate: LocalChatSessionRecord,
  options: NormalizeSessionOptions
): string | null {
  if (!options.preserveRuntimeBackendSessionId) return null;
  if (typeof candidate.backendSessionId === "string") {
    return candidate.backendSessionId;
  }
  return null;
}

export function normalizeLocalChatSession(
  value: unknown,
  options: NormalizeSessionOptions = {}
): ChatSession | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as LocalChatSessionRecord;
  if (typeof candidate.id !== "string") return null;
  if (typeof candidate.label !== "string") return null;
  if (candidate.status !== "open" && candidate.status !== "closed") return null;
  const rawMessages = Array.isArray(candidate.messages)
    ? candidate.messages
    : [];

  const lifecycle =
    typeof candidate.lifecycle === "string" &&
    (options.preserveRuntimeBackendSessionId
      ? VALID_LIFECYCLES.has(candidate.lifecycle as LocalChatLifecycle)
      : DURABLE_LIFECYCLES.has(candidate.lifecycle as LocalChatLifecycle))
      ? (candidate.lifecycle as LocalChatLifecycle)
      : candidate.status === "closed"
        ? "closed"
        : "idle";

  const messages = durableMessages(rawMessages).map((message) =>
    !options.preserveRuntimeBackendSessionId &&
    message.kind === "user_question" &&
    message.status === "pending"
      ? { ...message, status: "unavailable" as const }
      : message
  );
  const createdAt = normalizeTimestamp(candidate.createdAt, messages, "first");
  const updatedAt = normalizeTimestamp(
    candidate.updatedAt,
    messages,
    "last",
    createdAt
  );
  const messageCount =
    typeof candidate.messageCount === "number" &&
    Number.isFinite(candidate.messageCount)
      ? Math.max(0, Math.floor(candidate.messageCount))
      : messages.length;
  const providerResumeId =
    typeof candidate.providerResumeId === "string"
      ? candidate.providerResumeId
      : null;
  const title = typeof candidate.title === "string" ? candidate.title : null;
  const titleStatus =
    typeof candidate.titleStatus === "string" &&
    VALID_TITLE_STATUSES.has(candidate.titleStatus as ChatTitleStatus)
      ? (candidate.titleStatus as ChatTitleStatus)
      : title
        ? "generated"
        : "pending";
  const titleConfidence =
    typeof candidate.titleConfidence === "number" &&
    Number.isFinite(candidate.titleConfidence)
      ? Math.max(0, Math.min(1, candidate.titleConfidence))
      : title
        ? 1
        : null;
  const titleUserMessageCount =
    typeof candidate.titleUserMessageCount === "number" &&
    Number.isFinite(candidate.titleUserMessageCount)
      ? Math.max(0, Math.floor(candidate.titleUserMessageCount))
      : 0;

  return {
    id: candidate.id,
    label: candidate.label,
    title,
    titleStatus,
    titleConfidence,
    titleUserMessageCount,
    messages,
    status: candidate.status,
    harness: normalizeHarness(candidate.harness),
    backendSessionId: normalizeRuntimeBackendSessionId(candidate, options),
    providerResumeId,
    projectPath:
      typeof candidate.projectPath === "string" ? candidate.projectPath : null,
    selectedModelId:
      typeof candidate.selectedModelId === "string"
        ? candidate.selectedModelId
        : candidate.selectedModelId === null
          ? null
          : undefined,
    selectedReasoningEffort:
      typeof candidate.selectedReasoningEffort === "string"
        ? candidate.selectedReasoningEffort
        : candidate.selectedReasoningEffort === null
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
    threadTotalTokens:
      typeof candidate.threadTotalTokens === "number" &&
      Number.isFinite(candidate.threadTotalTokens)
        ? Math.max(0, Math.floor(candidate.threadTotalTokens))
        : undefined,
    isDetached: options.preserveRuntimeBackendSessionId
      ? candidate.isDetached === true
      : false,
    lifecycle,
    lifecycleError: options.preserveRuntimeBackendSessionId
      ? typeof candidate.lifecycleError === "string"
        ? candidate.lifecycleError
        : null
      : null,
    streamingAssistant:
      options.preserveRuntimeBackendSessionId &&
      candidate.streamingAssistant &&
      typeof candidate.streamingAssistant.text === "string" &&
      typeof candidate.streamingAssistant.timestamp === "string"
        ? {
            text: candidate.streamingAssistant.text,
            timestamp: candidate.streamingAssistant.timestamp,
          }
        : null,
    createdAt,
    updatedAt,
    messageCount,
  };
}

function durableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) => message.kind !== "assistant" || !message.isPartial
  );
}

export function hasDurableLocalChatContent(
  session: Pick<ChatSession, "messages" | "providerResumeId" | "messageCount">
): boolean {
  return (
    (session.messageCount ?? 0) > 0 ||
    durableMessages(session.messages).length > 0 ||
    !!session.providerResumeId?.trim()
  );
}

export function isDisposableClosedLocalChatSession(
  session: Pick<
    ChatSession,
    "messages" | "providerResumeId" | "messageCount" | "lifecycle" | "status"
  >
): boolean {
  return (
    (session.lifecycle === "closed" || session.status === "closed") &&
    !hasDurableLocalChatContent(session)
  );
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

function timestampMillis(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function compareLocalChatSessionRecency(
  a: Pick<ChatSession, "createdAt" | "updatedAt" | "id">,
  b: Pick<ChatSession, "createdAt" | "updatedAt" | "id">
): number {
  const updatedDelta =
    timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt);
  if (updatedDelta !== 0) return updatedDelta;

  const createdDelta =
    timestampMillis(b.createdAt) - timestampMillis(a.createdAt);
  if (createdDelta !== 0) return createdDelta;

  return b.id.localeCompare(a.id);
}

function serializeSession(
  session: ChatSession,
  previous?: ChatSession | null
): ChatSession {
  const messages: ChatMessage[] = [];
  const messageCount = Math.max(
    durableMessages(session.messages).length,
    session.messageCount ?? 0,
    previous?.messageCount ?? 0
  );
  const createdAt =
    session.createdAt ??
    previous?.createdAt ??
    new Date().toISOString();
  const updatedAt =
    session.updatedAt ?? previous?.updatedAt ?? createdAt;

  return {
    id: session.id,
    label: session.label,
    title: session.title ?? null,
    titleStatus:
      session.titleStatus ?? (session.title?.trim() ? "generated" : "pending"),
    titleConfidence:
      session.titleConfidence ?? (session.title?.trim() ? 1 : null),
    titleUserMessageCount: session.titleUserMessageCount ?? 0,
    messages,
    status: session.status,
    harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
    backendSessionId: null,
    providerResumeId: session.providerResumeId ?? null,
    threadTotalTokens: session.threadTotalTokens,
    projectPath: session.projectPath ?? null,
    selectedModelId: session.selectedModelId,
    selectedReasoningEffort: session.selectedReasoningEffort,
    permissionMode: session.permissionMode ?? "default",
    model: session.model,
    tokenUsage: session.tokenUsage,
    isDetached: false,
    lifecycle: session.lifecycle === "closed" ? "closed" : "idle",
    lifecycleError: null,
    streamingAssistant: null,
    createdAt,
    updatedAt,
    messageCount,
  };
}

function readSessions(): Record<string, ChatSession> {
  return sessionIndexCache;
}

function toIndexEntry(session: ChatSession): LocalChatSessionIndexEntry {
  return {
    id: session.id,
    label: session.label,
    title: session.title ?? null,
    titleStatus:
      session.titleStatus ?? (session.title?.trim() ? "generated" : "pending"),
    titleConfidence:
      session.titleConfidence ?? (session.title?.trim() ? 1 : null),
    titleUserMessageCount: session.titleUserMessageCount ?? 0,
    harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
    model: session.model,
    selectedModelId: session.selectedModelId,
    selectedReasoningEffort: session.selectedReasoningEffort,
    permissionMode: session.permissionMode ?? "default",
    createdAt: session.createdAt ?? FALLBACK_TIMESTAMP,
    updatedAt: session.updatedAt ?? session.createdAt ?? FALLBACK_TIMESTAMP,
    projectPath: session.projectPath ?? null,
    providerResumeId: session.providerResumeId ?? null,
    threadTotalTokens: session.threadTotalTokens,
    messageCount:
      session.messageCount ?? durableMessages(session.messages).length,
    lifecycle: session.lifecycle ?? "idle",
    status: session.status,
  };
}

function writeSessions(sessions: Record<string, ChatSession>): void {
  sessionIndexCache = sessions;
  scheduleIndexSave();
}

function scheduleIndexSave(): void {
  indexSaveQueued = true;
  void flushIndexSaveQueue();
}

async function flushIndexSaveQueue(): Promise<void> {
  if (indexSaveInFlight) return;
  const indexCommands = commands as LocalChatSessionIndexCommands;
  const save = indexCommands.saveLocalChatSessionIndex;
  if (!save) return;

  indexSaveInFlight = true;
  let blockedByHydration = false;
  try {
    const hydrated = await hydrateSessionIndexCache();
    if (!hydrated) {
      indexSaveQueued = true;
      blockedByHydration = true;
      return;
    }
    while (indexSaveQueued) {
      indexSaveQueued = false;
      const sessions = Object.values(sessionIndexCache).map(toIndexEntry);
      const result = await save({ sessions });
      if (result.status === "error") {
        console.warn("Failed to save local chat session index", result.error);
      }
    }
  } catch (error) {
    console.warn("Failed to save local chat session index", error);
  } finally {
    indexSaveInFlight = false;
    if (indexSaveQueued && !blockedByHydration) {
      void flushIndexSaveQueue();
    }
  }
}

async function loadSessionIndexFromCommand(): Promise<Record<
  string,
  ChatSession
> | null> {
  const indexCommands = commands as LocalChatSessionIndexCommands;
  const load = indexCommands.loadLocalChatSessionIndex;
  if (!load) return {};
  try {
    const result = await load();
    if (result.status === "ok") {
      const entries = Array.isArray(result.data) ? result.data : [];
      return Object.fromEntries(
        entries
          .map((entry) => normalizeLocalChatSession(entry))
          .filter((session): session is ChatSession => session !== null)
          .map((session) => [session.id, session])
      );
    }
    console.warn("Failed to load local chat session index", result.error);
    return null;
  } catch (error) {
    console.warn("Failed to load local chat session index", error);
    return null;
  }
}

async function hydrateSessionIndexCache(): Promise<boolean> {
  if (sessionIndexHydrated) return true;
  if (!sessionIndexHydratePromise) {
    sessionIndexHydratePromise = loadSessionIndexFromCommand()
      .then((loaded) => {
        if (loaded === null) return false;
        sessionIndexCache = {
          ...loaded,
          ...sessionIndexCache,
        };
        sessionIndexHydrated = true;
        return true;
      })
      .finally(() => {
        sessionIndexHydratePromise = null;
      });
  }
  return sessionIndexHydratePromise;
}

export async function hydrateLocalChatSessionIndex(): Promise<{
  sessions: Record<string, ChatSession>;
}> {
  await hydrateSessionIndexCache();
  return {
    sessions: sessionIndexCache,
  };
}

export function projectPathMatches(
  sessionProjectPath: string | null | undefined,
  requestedProjectPath: string | null | undefined
): boolean {
  // `undefined` means the caller intentionally requested an unfiltered list.
  // `null` is a real no-project bucket: it may reuse no-project chats, but it
  // must never match a chat captured under a different project path.
  if (requestedProjectPath === undefined) return true;
  if (requestedProjectPath === null) {
    return sessionProjectPath === undefined || sessionProjectPath === null;
  }
  if (sessionProjectPath === undefined || sessionProjectPath === null)
    return false;
  return sessionProjectPath === requestedProjectPath;
}

export function loadPersistedLocalChatSessions(): Record<string, ChatSession> {
  return Object.fromEntries(
    Object.entries(readSessions()).filter(
      (entry): entry is [string, ChatSession] =>
        entry[1].status === "open" &&
        !isDisposableClosedLocalChatSession(entry[1])
    )
  );
}

export function summarizeLocalChatSession(
  session: ChatSession
): LocalChatSessionSummary {
  return {
    id: session.id,
    label: session.label,
    title: session.title ?? null,
    titleStatus:
      session.titleStatus ??
      (session.title?.trim() ? "generated" : "pending"),
    titleConfidence:
      session.titleConfidence ?? (session.title?.trim() ? 1 : null),
    titleUserMessageCount: session.titleUserMessageCount ?? 0,
    harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
    model: session.model,
    selectedModelId: session.selectedModelId,
    selectedReasoningEffort: session.selectedReasoningEffort,
    createdAt: session.createdAt ?? FALLBACK_TIMESTAMP,
    updatedAt: session.updatedAt ?? session.createdAt ?? FALLBACK_TIMESTAMP,
    projectPath: session.projectPath ?? null,
    providerResumeId: session.providerResumeId,
    threadTotalTokens: session.threadTotalTokens,
    messageCount:
      session.messageCount ?? durableMessages(session.messages).length,
    lifecycle: session.lifecycle ?? "idle",
  };
}

export function listPersistedLocalChatSessions(
  projectPath?: string | null
): LocalChatSessionSummary[] {
  return Object.values(readSessions())
    .filter(
      (session) =>
        session.status === "open" &&
        !isDisposableClosedLocalChatSession(session) &&
        projectPathMatches(session.projectPath, projectPath)
    )
    .map(summarizeLocalChatSession)
    .sort(compareLocalChatSessionRecency);
}

export function loadPersistedLocalChatSession(
  sessionId: string
): ChatSession | null {
  const session = readSessions()[sessionId] ?? null;
  if (!session || isDisposableClosedLocalChatSession(session)) return null;
  return session;
}

export function findPersistedLocalChatSession(
  projectPath?: string | null
): ChatSession | null {
  return (
    Object.values(readSessions())
      .filter(
        (session) =>
          session.status === "open" &&
          !session.isDetached &&
          !isDisposableClosedLocalChatSession(session) &&
          projectPathMatches(session.projectPath, projectPath)
      )
      .sort(compareLocalChatSessionRecency)[0] ?? null
  );
}

export function persistLocalChatSession(session: ChatSession): void {
  const sessions = readSessions();
  const serialized = serializeSession(session, sessions[session.id]);
  if (isDisposableClosedLocalChatSession(session)) {
    delete sessions[session.id];
    writeSessions(sessions);
    return;
  }
  sessions[session.id] = serialized;
  writeSessions(sessions);
  clearLocalChatSessionCleared(session.id);
}

export function removePersistedLocalChatSession(sessionId: string): void {
  const sessions = readSessions();
  delete sessions[sessionId];
  writeSessions(sessions);
}

export function clearPersistedLocalChatSessions(): void {
  sessionIndexCache = {};
  sessionIndexHydrated = true;
  sessionIndexHydratePromise = null;
  scheduleIndexSave();
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

export const LOCAL_CHAT_MODEL_STORAGE_KEY = MODEL_STORAGE_KEY;
