import { isOpenLocalChatConversation, normalizeDiscussionBinding } from "./localChatDiscussion";
import { localChatActivityStatus } from "./localChatActivity";
import type {
  ChatMessage,
  ChatSession,
  ChatTitleStatus,
  LocalChatLifecycle,
} from "../stores/chatStore";
import type {
  JsonValue,
  LocalChatDiscussionBinding,
  LocalChatGateBinding,
  LocalChatHarnessKind,
  PermissionMode,
} from "../bindings";
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
  gate?: LocalChatGateBinding | null;
  discussionBinding?: LocalChatDiscussionBinding;
};

type LocalChatSessionIndexCommands = typeof commands & {
  loadLocalChatSessionIndex?: () => Promise<
    | {
        status: "ok";
        data: unknown[];
      }
    | {
        status: "error";
        error: unknown;
      }
  >;
  saveLocalChatSessionIndex?: (input: {
    sessions: LocalChatSessionIndexEntry[];
    deletedIds?: string[];
    changedIds?: string[];
  }) => Promise<
    { status: "ok"; data: null } | { status: "error"; error: unknown }
  >;
};

let sessionIndexCache: Record<string, ChatSession> = {};
const pendingDeletedIds = new Set<string>();

// A per-entry generation keeps a second edit pending while its first write awaits.
const pendingChangedIds = new Map<string, number>();
const failedCatalogSaves = new Set<string>();
const catalogSaveListeners = new Set<() => void>();

export function subscribeToCatalogSaves(listener: () => void): () => void {
  catalogSaveListeners.add(listener);
  return () => catalogSaveListeners.delete(listener);
}

export function hasFailedCatalogSave(sessionId: string): boolean {
  return failedCatalogSaves.has(sessionId);
}

export function retryCatalogSave(): Promise<boolean> {
  return scheduleIndexSave();
}

function setCatalogSaveFailed(ids: Iterable<string>, failed: boolean): void {
  let changed = false;
  for (const id of ids) {
    if (failed === failedCatalogSaves.has(id)) continue;
    if (failed) failedCatalogSaves.add(id);
    else failedCatalogSaves.delete(id);
    changed = true;
  }
  if (changed) catalogSaveListeners.forEach((listener) => listener());
}

let nextChangeGeneration = 0;
let indexSaveInFlight = false;
let indexSaveQueued = false;
let indexSavePromise: Promise<boolean> | null = null;
let sessionIndexHydrated = false;
let sessionIndexHydratePromise: Promise<boolean> | null = null;

export interface LocalChatSessionSummary {
  activityStatus?: "working" | "idle";
  association?: JsonValue | null;
  id: string;
  label: string;
  title?: string | null;
  titleStatus?: ChatTitleStatus;
  titleConfidence?: number | null;
  titleUserMessageCount?: number;
  harness: LocalChatHarnessKind;
  providerId?: string | null;
  model?: string;
  selectedModelId?: string | null;
  selectedReasoningEffort?: string | null;
  selectedSpeedTier?: string | null;
  selectedPersonality?: string | null;
  createdAt: string;
  updatedAt: string;
  projectPath: string | null;
  providerResumeId: string | null;
  providerParentResumeId?: string | null;
  threadTotalTokens?: number;
  messageCount: number;
  /** Whether the user has sent at least one message in this session. */
  hasUserMessage?: boolean;
  lifecycle: LocalChatLifecycle;
}

type LocalChatSessionRecord = Partial<ChatSession> & Pick<LocalChatSessionIndexEntry, "discussionBinding">;

function canUseStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function normalizeHarness(value: unknown): LocalChatHarnessKind {
  return typeof value === "string" &&
    VALID_LOCAL_CHAT_HARNESSES.has(value as LocalChatHarnessKind)
    ? (value as LocalChatHarnessKind)
    : DEFAULT_LOCAL_CHAT_HARNESS;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A persisted gate binding, or null unless every identifying field is set. */
function normalizeGateBinding(value: unknown): LocalChatGateBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const gate = value as Partial<LocalChatGateBinding>;
  if (
    !nonEmptyString(gate.task_run_id) ||
    !nonEmptyString(gate.step_name) ||
    !nonEmptyString(gate.execution_id) ||
    !nonEmptyString(gate.artifact)
  ) {
    return null;
  }
  return {
    task_run_id: gate.task_run_id,
    step_name: gate.step_name,
    execution_id: gate.execution_id,
    artifact: gate.artifact,
    role: typeof gate.role === "string" ? gate.role : null,
    question: typeof gate.question === "string" ? gate.question : null,
    output_schema: (gate.output_schema ?? null) as JsonValue | null,
  };
}

export function normalizeLocalChatSession(value: unknown): ChatSession | null {
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
    DURABLE_LIFECYCLES.has(candidate.lifecycle as LocalChatLifecycle)
      ? (candidate.lifecycle as LocalChatLifecycle)
      : candidate.status === "closed"
        ? "closed"
        : "idle";

  const messages = durableMessages(rawMessages).map((message) =>
    message.kind === "user_question" && message.status === "pending"
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
  const hasUserMessage =
    typeof candidate.hasUserMessage === "boolean"
      ? candidate.hasUserMessage
      : rawMessages.some((message) => message.kind === "user") ||
        messageCount > 0 ||
        !!providerResumeId?.trim();
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

  const discussion = normalizeDiscussionBinding(candidate.discussionBinding);

  return {
    ...(discussion && { discussion }),
    id: candidate.id,
    label: candidate.label,
    title,
    titleStatus,
    titleConfidence,
    titleUserMessageCount,
    messages,
    hasUserMessage,
    status: candidate.status,
    activityStatus: candidate.activityStatus === "working" ? "working" : "idle",
    harness: normalizeHarness(candidate.harness),
    backendSessionId: null,
    providerResumeId,
    steeringTurnIds: candidate.steeringTurnIds ?? undefined,
    providerParentResumeId:
      typeof candidate.providerParentResumeId === "string"
        ? candidate.providerParentResumeId
        : null,
    projectPath:
      typeof candidate.projectPath === "string" ? candidate.projectPath : null,
    providerId:
      typeof candidate.providerId === "string" && candidate.providerId.trim()
        ? candidate.providerId.trim()
        : null,
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
    selectedSpeedTier:
      typeof candidate.selectedSpeedTier === "string"
        ? candidate.selectedSpeedTier
        : candidate.selectedSpeedTier === null
          ? null
          : undefined,
    selectedPersonality:
      typeof candidate.selectedPersonality === "string"
        ? candidate.selectedPersonality
        : candidate.selectedPersonality === null
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
    lifecycle,
    lifecycleError: null,
    streamingAssistant: null,
    createdAt,
    updatedAt,
    messageCount,
    association: candidate.association ?? null,
    gate: normalizeGateBinding(candidate.gate),
  };
}

function durableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) => message.kind !== "assistant" || !message.isPartial
  );
}

export function hasLocalChatUserMessage(
  session: Pick<
    ChatSession,
    "hasUserMessage" | "messages" | "messageCount" | "providerResumeId"
  >
): boolean {
  if (typeof session.hasUserMessage === "boolean") {
    return session.hasUserMessage;
  }
  return (
    session.messages.length > 0 ||
    (session.messageCount ?? 0) > 0 ||
    !!session.providerResumeId?.trim()
  );
}

export function hasLocalChatUserMessageSummary(
  session: Pick<
    LocalChatSessionSummary,
    "hasUserMessage" | "messageCount" | "providerResumeId"
  >
): boolean {
  if (typeof session.hasUserMessage === "boolean") {
    return session.hasUserMessage;
  }
  return session.messageCount > 0 || !!session.providerResumeId?.trim();
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

export function isAutomaticLocalChatLabel(label: string): boolean {
  const normalized = label.trim();
  return normalized === "New Chat" || normalized === "Project Chat";
}

/** Automatic placeholders are safe to reuse or deduplicate. Explicitly named
 * empty sessions remain user-owned and are not treated as disposable. */
export function isDefaultEmptyLocalChatSession(
  session: Pick<
    ChatSession,
    "label" | "messages" | "providerResumeId" | "messageCount"
  >
): boolean {
  return (
    isAutomaticLocalChatLabel(session.label) &&
    !hasDurableLocalChatContent(session)
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
    session.createdAt ?? previous?.createdAt ?? new Date().toISOString();
  const updatedAt = session.updatedAt ?? previous?.updatedAt ?? createdAt;

  return {
    discussion: session.discussion,
    id: session.id,
    label: session.label,
    title: session.title ?? null,
    titleStatus:
      session.titleStatus ?? (session.title?.trim() ? "generated" : "pending"),
    titleConfidence:
      session.titleConfidence ?? (session.title?.trim() ? 1 : null),
    titleUserMessageCount: session.titleUserMessageCount ?? 0,
    messages,
    hasUserMessage: hasLocalChatUserMessage(session),
    status: session.status,
    activityStatus: localChatActivityStatus(session),
    harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
    providerId: session.providerId ?? null,
    backendSessionId: null,
    providerParentResumeId: session.providerParentResumeId ?? null,
    providerResumeId: session.providerResumeId ?? null,
    threadTotalTokens: session.threadTotalTokens,
    projectPath: session.projectPath ?? null,
    selectedModelId: session.selectedModelId,
    selectedReasoningEffort: session.selectedReasoningEffort,
    selectedSpeedTier: session.selectedSpeedTier,
    selectedPersonality: session.selectedPersonality,
    permissionMode: session.permissionMode ?? "default",
    model: session.model,
    tokenUsage: session.tokenUsage,
    lifecycle: session.lifecycle === "closed" ? "closed" : "idle",
    lifecycleError: null,
    streamingAssistant: null,
    createdAt,
    updatedAt,
    messageCount,
    steeringTurnIds: session.steeringTurnIds,
    association: session.association ?? null,
    gate: session.gate ?? null,
  };
}

export function allPersistedLocalChatSessions(): Record<string, ChatSession> {
  return { ...sessionIndexCache };
}

function readSessions(): Record<string, ChatSession> {
  return sessionIndexCache;
}

function toIndexEntry(session: ChatSession): LocalChatSessionIndexEntry {
  const binding = session.discussion;
  return {
    activityStatus: session.activityStatus ?? localChatActivityStatus(session),
    association: session.association ?? null,
    id: session.id,
    label: session.label,
    title: session.title ?? null,
    titleStatus:
      session.titleStatus ?? (session.title?.trim() ? "generated" : "pending"),
    titleConfidence:
      session.titleConfidence ?? (session.title?.trim() ? 1 : null),
    titleUserMessageCount: session.titleUserMessageCount ?? 0,
    harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
    providerId: session.providerId ?? null,
    model: session.model,
    selectedModelId: session.selectedModelId,
    selectedReasoningEffort: session.selectedReasoningEffort,
    selectedSpeedTier: session.selectedSpeedTier,
    selectedPersonality: session.selectedPersonality,
    permissionMode: session.permissionMode ?? "default",
    createdAt: session.createdAt ?? FALLBACK_TIMESTAMP,
    updatedAt: session.updatedAt ?? session.createdAt ?? FALLBACK_TIMESTAMP,
    projectPath: session.projectPath ?? null,
    providerParentResumeId: session.providerParentResumeId ?? null,
    providerResumeId: session.providerResumeId ?? null,
    threadTotalTokens: session.threadTotalTokens,
    messageCount:
      session.messageCount ?? durableMessages(session.messages).length,
    hasUserMessage: hasLocalChatUserMessage(session),
    lifecycle: session.lifecycle ?? "idle",
    status: session.status,
    ...(session.gate ? { gate: session.gate } : {}),
    ...(session.steeringTurnIds ? { steeringTurnIds: session.steeringTurnIds } : {}),
    ...(binding && { discussionBinding: binding }),
  };
}

function sameIndexEntry(a: ChatSession, b: ChatSession): boolean {
  return JSON.stringify(toIndexEntry(a)) === JSON.stringify(toIndexEntry(b));
}

/**
 * Apply one durably merged catalog entry. Returns the visible session, `null`
 * for a remote deletion, or `undefined` when the entry must not be applied:
 * the cache is not hydrated yet (recovery will read it) or a local edit or
 * deletion of the same chat is still pending (the local intent wins).
 */
export function applyRemoteLocalChatSession(
  sessionId: string,
  raw: unknown | null
): ChatSession | null | undefined {
  if (
    !sessionIndexHydrated ||
    pendingChangedIds.has(sessionId) ||
    pendingDeletedIds.has(sessionId) ||
    isLocalChatSessionCleared(sessionId)
  ) {
    return undefined;
  }
  if (raw === null) {
    if (!sessionIndexCache[sessionId]) return undefined;
    delete sessionIndexCache[sessionId];
    return null;
  }
  const session = normalizeLocalChatSession(raw);
  if (!session || session.id !== sessionId) return undefined;
  sessionIndexCache[sessionId] = session;
  return session;
}

function writeSessions(
  sessions: Record<string, ChatSession>
): Promise<boolean> {
  sessionIndexCache = sessions;
  return scheduleIndexSave();
}

function deduplicateDefaultEmptyLocalChatSessions(
  sessions: Record<string, ChatSession>
): { sessions: Record<string, ChatSession>; changed: boolean } {
  const deduplicated = { ...sessions };
  const byProject = new Map<string | null, ChatSession[]>();
  for (const session of Object.values(deduplicated)) {
    if (session.status !== "open" || !isDefaultEmptyLocalChatSession(session)) {
      continue;
    }
    const projectKey = session.projectPath ?? null;
    const bucket = byProject.get(projectKey) ?? [];
    bucket.push(session);
    byProject.set(projectKey, bucket);
  }

  let changed = false;
  for (const candidates of byProject.values()) {
    candidates.sort(compareLocalChatSessionRecency);
    for (const duplicate of candidates.slice(1)) {
      delete deduplicated[duplicate.id];
      pendingDeletedIds.add(duplicate.id);
      changed = true;
    }
  }
  return { sessions: deduplicated, changed };
}

function scheduleIndexSave(): Promise<boolean> {
  indexSaveQueued = true;
  if (!indexSavePromise) {
    indexSavePromise = flushIndexSaveQueue().finally(() => {
      indexSavePromise = null;
    });
  }
  return indexSavePromise;
}

async function flushIndexSaveQueue(): Promise<boolean> {
  if (indexSaveInFlight) return false;
  const indexCommands = commands as LocalChatSessionIndexCommands;
  const save = indexCommands.saveLocalChatSessionIndex;
  if (!save) return true;

  indexSaveInFlight = true;
  let blockedByHydration = false;
  let succeeded = true;
  try {
    const hydrated = await hydrateSessionIndexCache();
    if (!hydrated) {
      indexSaveQueued = true;
      blockedByHydration = true;
      setCatalogSaveFailed(pendingChangedIds.keys(), true);
      return false;
    }
    while (indexSaveQueued) {
      indexSaveQueued = false;
      const sessions = Object.values(sessionIndexCache).map(toIndexEntry);
      const deletedIds = [...pendingDeletedIds];
      const changes = new Map(pendingChangedIds);
      const result = await save({
        sessions,
        deletedIds,
        changedIds: [...changes.keys()],
      });

      if (result.status === "error") {
        succeeded = false;
        setCatalogSaveFailed(changes.keys(), true);
        console.warn("[ChatCatalogSync] index_save_failed");
      } else {
        for (const id of deletedIds) pendingDeletedIds.delete(id);
        setCatalogSaveFailed(deletedIds, false);
        for (const [id, generation] of changes) {
          if (pendingChangedIds.get(id) === generation) {
            pendingChangedIds.delete(id);
            setCatalogSaveFailed([id], false);
          }
        }
      }
    }
  } catch {
    succeeded = false;
    setCatalogSaveFailed(pendingChangedIds.keys(), true);
    console.warn("[ChatCatalogSync] index_save_failed");
  } finally {
    indexSaveInFlight = false;
    if (indexSaveQueued && !blockedByHydration) {
      void scheduleIndexSave();
    }
  }
  return succeeded;
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
    console.warn("[ChatCatalogSync] index_load_failed");
    return null;
  } catch {
    console.warn("[ChatCatalogSync] index_load_failed");
    return null;
  }
}

async function hydrateSessionIndexCache(): Promise<boolean> {
  if (sessionIndexHydrated) return true;
  if (!sessionIndexHydratePromise) {
    sessionIndexHydratePromise = loadSessionIndexFromCommand()
      .then((loaded) => {
        if (loaded === null) return false;
        const merged = Object.fromEntries(
          Object.entries({
            ...loaded,
            ...sessionIndexCache,
          }).filter(([id]) => !isLocalChatSessionCleared(id))
        );
        const deduplicated = deduplicateDefaultEmptyLocalChatSessions(merged);
        sessionIndexCache = deduplicated.sessions;
        sessionIndexHydrated = true;
        if (deduplicated.changed) scheduleIndexSave();
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

/**
 * Reload after reconnect. Edits and deletions made during the read win locally;
 * the Rust outbox resolves remote revisions before returning this snapshot.
 */
export async function refreshLocalChatSessionIndex(
  isCurrent: () => boolean
): Promise<Record<string, ChatSession> | null> {
  await hydrateSessionIndexCache();
  await indexSavePromise;
  if (!isCurrent()) {
    return null;
  }

  const before = { ...sessionIndexCache };
  const loaded = await loadSessionIndexFromCommand();
  if (!isCurrent() || loaded === null) {
    return null;
  }

  const merged = { ...loaded };

  // Retain edits made while the backend snapshot was in flight.
  for (const id of new Set([
    ...Object.keys(before),
    ...Object.keys(sessionIndexCache),
  ])) {
    if (sessionIndexCache[id] !== before[id]) {
      if (sessionIndexCache[id]) {
        merged[id] = sessionIndexCache[id];
      } else {
        delete merged[id];
      }
    }
  }

  sessionIndexCache = Object.fromEntries(
    Object.entries(merged).filter(([id]) => !isLocalChatSessionCleared(id))
  );

  return sessionIndexCache;
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
  const normalizedRequestedPath = normalizeProjectPath(requestedProjectPath);
  const normalizedSessionPath = normalizeProjectPath(sessionProjectPath);
  if (!normalizedRequestedPath || !normalizedSessionPath) return false;
  return normalizedSessionPath === normalizedRequestedPath;
}

/** Normalize project paths before grouping or matching persisted sessions. */
export function normalizeProjectPath(
  path: string | null | undefined
): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;

  let normalized = trimmed;
  while (
    normalized.length > 1 &&
    /[\\/]$/.test(normalized) &&
    !/^[A-Za-z]:[\\/]$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function loadPersistedLocalChatSessions(): Record<string, ChatSession> {
  return Object.fromEntries(
    Object.entries(readSessions()).filter(
      (entry): entry is [string, ChatSession] =>
        isOpenLocalChatConversation(entry[1]) &&
        !isDisposableClosedLocalChatSession(entry[1])
    )
  );
}

export function summarizeLocalChatSession(
  session: ChatSession
): LocalChatSessionSummary {
  return {
    activityStatus: session.activityStatus ?? localChatActivityStatus(session),
    id: session.id,
    association: session.association ?? null,
    label: session.label,
    title: session.title ?? null,
    titleStatus:
      session.titleStatus ?? (session.title?.trim() ? "generated" : "pending"),
    titleConfidence:
      session.titleConfidence ?? (session.title?.trim() ? 1 : null),
    titleUserMessageCount: session.titleUserMessageCount ?? 0,
    harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
    providerId: session.providerId ?? null,
    model: session.model,
    selectedModelId: session.selectedModelId,
    selectedReasoningEffort: session.selectedReasoningEffort,
    selectedSpeedTier: session.selectedSpeedTier,
    selectedPersonality: session.selectedPersonality,
    createdAt: session.createdAt ?? FALLBACK_TIMESTAMP,
    updatedAt: session.updatedAt ?? session.createdAt ?? FALLBACK_TIMESTAMP,
    projectPath: session.projectPath ?? null,
    providerParentResumeId: session.providerParentResumeId ?? null,
    providerResumeId: session.providerResumeId,
    threadTotalTokens: session.threadTotalTokens,
    messageCount:
      session.messageCount ?? durableMessages(session.messages).length,
    hasUserMessage: hasLocalChatUserMessage(session),
    lifecycle: session.lifecycle ?? "idle",
  };
}

export function listPersistedLocalChatSessions(
  projectPath?: string | null
): LocalChatSessionSummary[] {
  return Object.values(readSessions())
    .filter(
      (session) =>
        isOpenLocalChatConversation(session) &&
        !isDisposableClosedLocalChatSession(session) &&
        hasLocalChatUserMessage(session) &&
        projectPathMatches(session.projectPath, projectPath)
    )
    .map(summarizeLocalChatSession)
    .sort(compareLocalChatSessionRecency);
}

export function loadPersistedLocalChatSession(
  sessionId: string
): ChatSession | null {
  const session = readSessions()[sessionId] ?? null;
  if (!session || session.discussion || isDisposableClosedLocalChatSession(session)) {
    return null;
  }
  return session;
}

export function findPersistedLocalChatSession(
  projectPath?: string | null
): ChatSession | null {
  return (
    Object.values(readSessions())
      .filter(
        (session) =>
          isOpenLocalChatConversation(session) &&
          !isDisposableClosedLocalChatSession(session) &&
          projectPathMatches(session.projectPath, projectPath)
      )
      .sort(compareLocalChatSessionRecency)[0] ?? null
  );
}

/** Most recent open persisted chat bound to `gate`'s run and step. */
export function findPersistedGateChatSession(
  gate: Pick<LocalChatGateBinding, "task_run_id" | "step_name">
): ChatSession | null {
  return (
    Object.values(readSessions())
      .filter(
        (session) =>
          isOpenLocalChatConversation(session) &&
          session.gate?.task_run_id === gate.task_run_id &&
          session.gate.step_name === gate.step_name
      )
      .sort(compareLocalChatSessionRecency)[0] ?? null
  );
}

export function findPersistedDefaultEmptyLocalChatSession(
  projectPath?: string | null
): ChatSession | null {
  return (
    Object.values(readSessions())
      .filter(
        (session) =>
          isOpenLocalChatConversation(session) &&
          isDefaultEmptyLocalChatSession(session) &&
          projectPathMatches(session.projectPath, projectPath)
      )
      .sort(compareLocalChatSessionRecency)[0] ?? null
  );
}

export function persistLocalChatSession(
  session: ChatSession
): Promise<boolean> {
  const sessions = readSessions();
  const serialized = serializeSession(session, sessions[session.id]);
  if (isDisposableClosedLocalChatSession(session)) {
    delete sessions[session.id];
    pendingDeletedIds.add(session.id);
    return writeSessions(sessions);
  }
  const previous = sessions[session.id];
  sessions[session.id] = serialized;
  // Usage-only, lifecycle-only and partial-text updates leave the persisted
  // projection unchanged: refresh the cache without queueing a network write.
  if (previous && sameIndexEntry(previous, serialized)) {
    return indexSavePromise ?? Promise.resolve(true);
  }
  pendingChangedIds.set(session.id, ++nextChangeGeneration);
  const persistence = writeSessions(
    deduplicateDefaultEmptyLocalChatSessions(sessions).sessions
  );
  clearLocalChatSessionCleared(session.id);
  return persistence;
}

export function removePersistedLocalChatSession(sessionId: string): void {
  const sessions = readSessions();
  delete sessions[sessionId];
  pendingDeletedIds.add(sessionId);
  writeSessions(sessions);
}

export function clearPersistedLocalChatSessions(): void {
  for (const id of Object.keys(sessionIndexCache)) pendingDeletedIds.add(id);
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
