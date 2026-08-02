/**
 * Types and projection helpers for normalized harness session logs.
 *
 * SessionLog.content contains serialized HarnessEventV1 JSON. This module
 * transforms those provider-neutral events into the ConversationEvent model
 * consumed by the trace and chat renderers.
 */

import type { SessionLog } from "../bindings";

/** Persisted provider-neutral event emitted by the shared harness runtime. */
interface HarnessRawEvent {
  version: 1;
  event_id: string;
  stream_id: string;
  correlation?: {
    session_id?: string;
    thread_id?: string;
    turn_id?: string;
    run_id?: string;
    parent_tool_call_id?: string;
    provider_resume_id?: string;
  };
  timestamp?: string;
  semantics?: "delta" | "snapshot";
  type: string;
  data: Record<string, unknown>;
}

// ============================================================================
// Parsed Conversation Event Types
// ============================================================================

/** Base event with timestamp */
interface BaseEvent {
  timestamp: string;
  /**
   * Subagent linkage (the only intra-run nesting axis). When set, this event
   * was emitted by a spawned subagent and this is the normalized parent
   * tool-call id. The normalizer's `groupBySpawn` reads this (via
   * `readParentToolUseId`) to lift the event into a nested child Thread.
   * Undefined on the main agent's own events.
   */
  parentToolUseId?: string;
}

/** Exact human or agent input included in the normalized transcript. */
export interface UserMessageEvent extends BaseEvent {
  kind: "user_message";
  text: string;
}

/** Session start event emitted by the normalized harness stream. */
export interface SessionStartEvent extends BaseEvent {
  kind: "session_start";
  model: string;
  sessionId: string;
}

/** Session end event emitted by the normalized harness stream. */
export interface SessionEndEvent extends BaseEvent {
  kind: "session_end";
  durationMs: number;
  numTurns: number;
  costUsd: number;
}

/** Thinking/text content from assistant */
export interface ThinkingEvent extends BaseEvent {
  kind: "thinking";
  text: string;
}

/** Final assistant text intended for the user. */
export interface AssistantMessageEvent extends BaseEvent {
  kind: "assistant_message";
  text: string;
}

/** Provider heartbeat activity, when represented by a harness adapter. */
export interface ThinkingHeartbeatEvent extends BaseEvent {
  kind: "thinking_heartbeat";
  sessionId: string;
  estimatedTokens: number;
  estimatedTokensDelta: number;
}

/** Subagent progress snapshot, when represented by a harness adapter. */
export interface TaskProgressEvent extends BaseEvent {
  kind: "task_progress";
  toolUseId: string;
  taskId?: string;
  description: string;
  subagentType?: string;
}

/** Subagent start event, when represented by a harness adapter. */
export interface TaskStartedEvent extends BaseEvent {
  kind: "task_started";
  toolUseId?: string;
  taskId?: string;
  description: string;
  subagentType?: string;
}

/** Task-level notification event from the normalized transcript. */
export interface TaskNotificationEvent extends BaseEvent {
  kind: "task_notification";
  message: string;
}

/** Provider rate-limit status snapshot, when represented by a harness adapter. */
export interface RateLimitEvent extends BaseEvent {
  kind: "rate_limit";
  sessionId?: string;
  status?: string;
  rateLimitType?: string;
  resetsAt?: number;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

/** Tool icons by tool name */
export const TOOL_ICONS: Record<string, string> = {
  Bash: "terminal",
  Read: "file-text",
  Grep: "search",
  Glob: "folder-search",
  Edit: "edit",
  Write: "file-plus",
  WebFetch: "globe",
  WebSearch: "search",
  Task: "git-branch",
  TaskOutput: "file-output",
  // MCP tools
  mcp__morph_mcp__edit_file: "edit",
  mcp__morph_mcp__warpgrep_codebase_search: "search",
};

/** Get icon for a tool */
export function getToolIcon(toolName: string): string {
  if (toolName in TOOL_ICONS) {
    return TOOL_ICONS[toolName];
  }
  if (toolName.includes("warpgrep") || toolName.includes("search")) {
    return "search";
  }
  if (toolName.includes("edit")) {
    return "edit";
  }
  return "wrench";
}

/** Tool call event projected from a normalized harness tool_call payload. */
export interface ToolCallEvent extends BaseEvent {
  kind: "tool_call";
  toolId: string;
  toolName: string;
  displayName: string;
  icon: string;
  summary: string;
  input: Record<string, unknown>;
}

/** Tool result event projected from a normalized harness tool_output payload. */
export interface ToolResultEvent extends BaseEvent {
  kind: "tool_result";
  toolUseId: string;
  isError: boolean;
  result: string;
}

/**
 * Status of a normalized file-change patch application.
 *
 * The harness schema reports terminal statuses as an enum; we keep the
 * discriminator open so unknown future statuses don't break projection.
 */
export type PatchApplyStatus = "completed" | "failed" | string;

/** A single per-file change inside a normalized `file_change` event. */
export interface FileUpdateChange {
  /** Repo-relative path of the file being changed. */
  path: string;
  /** Change kind: add, delete, or update (open for forward compatibility). */
  kind: "add" | "delete" | "update" | string;
  /** Unified diff body, including projected file content for add/delete changes. */
  diff?: string;
}

/**
 * File-edit event carrying one or more {@link FileUpdateChange} entries
 * plus the patch application status. Both harnesses normalize their native
 * edit/write/apply-patch lifecycle into this shape.
 */
export interface FileEditEvent extends BaseEvent {
  kind: "file_edit";
  toolId: string;
  status: PatchApplyStatus;
  changes: FileUpdateChange[];
}

/** A single checklist row in a normalized harness plan. */
export interface TodoListItem {
  text: string;
  completed: boolean;
}

/**
 * Plan/todo checklist event sourced from normalized harness plan snapshots.
 * The parser dedupes by `itemId`, replacing earlier entries in place so the
 * timeline shows the latest state without growing unboundedly.
 */
export interface TodoListEvent extends BaseEvent {
  kind: "todo_list";
  itemId: string;
  items: TodoListItem[];
}

/** Union of all conversation events */
export type ConversationEvent =
  | UserMessageEvent
  | SessionStartEvent
  | SessionEndEvent
  | ThinkingEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | FileEditEvent
  | TodoListEvent
  | ThinkingHeartbeatEvent
  | TaskProgressEvent
  | TaskStartedEvent
  | TaskNotificationEvent
  | RateLimitEvent;

// ============================================================================
// Parsing Utilities
// ============================================================================

/** Get a human-friendly display name for a tool */
function getToolDisplayName(name: string): string {
  // Handle MCP tools
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[parts.length - 1].replace(/_/g, " ");
  }
  return name;
}

/** Get a summary of the tool call for display */
function getToolSummary(name: string, input: Record<string, unknown>): string {
  const maxLen = 80;

  switch (name) {
    case "Bash":
      return truncate(String(input.command || ""), maxLen);
    case "Read": {
      const path = String(input.file_path || "");
      return path.split("/").pop() || path;
    }
    case "Grep":
      return `pattern: ${truncate(String(input.pattern || ""), maxLen - 10)}`;
    case "Glob":
      return truncate(String(input.pattern || ""), maxLen);
    case "Edit": {
      const editPath = String(input.file_path || "");
      return editPath.split("/").pop() || editPath;
    }
    case "Write": {
      const writePath = String(input.file_path || "");
      return writePath.split("/").pop() || writePath;
    }
    case "Agent":
      return truncate(
        String(
          input.description ||
            input.prompt ||
            input.agent_nickname ||
            input.agent_path ||
            "Agent"
        ),
        maxLen
      );
    case "Agent Result":
      return truncate(
        String(input.agent_nickname || input.agent_path || "Agent result"),
        maxLen
      );
    case "mcp__morph_mcp__warpgrep_codebase_search":
      return truncate(String(input.search_string || ""), maxLen);
    case "mcp__morph_mcp__edit_file": {
      const mcpPath = String(input.path || "");
      return mcpPath.split("/").pop() || mcpPath;
    }
    default:
      return truncate(JSON.stringify(input), maxLen);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return readRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return readRecord(value);
}

function shouldKeepUserMessage(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.includes("# AGENTS.md instructions for ") &&
    !trimmed.includes("<recommended_plugins>") &&
    !trimmed.includes("<environment_context>")
  );
}

/**
 * Background subagent completion notices are injected into the transcript as
 * `user`-role lines wrapping a `<task-notification>` block — the user never
 * typed them. Returns the human-readable notice (the `<summary>` body, falling
 * back to `<status>`) when the text is such a block, undefined otherwise.
 */
function readTaskNotificationText(text: string): string | undefined {
  if (!text.trimStart().startsWith("<task-notification>")) return undefined;
  const tag = (name: string) =>
    text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
  return tag("summary") ?? tag("status") ?? "Background task notification";
}

function readHarnessNotificationText(text: string): string | undefined {
  const taskNotification = readTaskNotificationText(text);
  if (taskNotification) return taskNotification;
  const match = text.match(
    /^\s*<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/
  );
  if (!match) return undefined;
  const body = parseRecord(match[1]);
  const status = body?.status;
  const completed = readString(readRecord(status)?.completed);
  if (completed) return `Subagent completed: ${completed}`;
  if (typeof status === "string" && status) return `Subagent ${status}`;
  return "Subagent notification";
}

function isHarnessRawEvent(raw: unknown): raw is HarnessRawEvent {
  const record = readRecord(raw);
  return (
    record?.version === 1 &&
    typeof record.event_id === "string" &&
    typeof record.stream_id === "string" &&
    typeof record.type === "string" &&
    readRecord(record.data) !== undefined
  );
}

function outputText(output: unknown): string {
  return typeof output === "string" ? output : (JSON.stringify(output) ?? "");
}

function harnessOutcomeMetrics(data: Record<string, unknown>): {
  durationMs: number;
  numTurns: number;
  costUsd: number;
} {
  const metrics = readRecord(data.metrics);
  const usage = readRecord(data.usage);
  const usageCostMicrousd = readNumber(usage?.cost_microusd);
  return {
    durationMs: readNumber(metrics?.duration_ms) ?? 0,
    numTurns: readNumber(metrics?.turn_count) ?? 0,
    costUsd:
      readNumber(metrics?.total_cost_usd) ??
      (usageCostMicrousd === undefined ? 0 : usageCostMicrousd / 1_000_000),
  };
}

function tagHarnessParent(
  events: ConversationEvent[],
  event: HarnessRawEvent
): ConversationEvent[] {
  const parentToolUseId = readString(
    readRecord(event.correlation)?.parent_tool_call_id
  );
  if (parentToolUseId) {
    for (const parsed of events) parsed.parentToolUseId = parentToolUseId;
  }
  return events;
}

/**
 * Persistent sessions share a stream across turns. Dedupe state must therefore
 * be scoped to the emitted turn (or one-shot run), never the stream alone.
 * When neither identity is present, preserve all events rather than risking a
 * later turn being hidden.
 */
function harnessTurnKey(event: HarnessRawEvent): string | undefined {
  const correlation = readRecord(event.correlation);
  const turnId = readString(correlation?.turn_id);
  if (turnId) return `turn:${event.stream_id}:${turnId}`;
  const runId = readString(correlation?.run_id);
  if (runId) return `run:${event.stream_id}:${runId}`;
  return undefined;
}

/**
 * Projects persisted provider-neutral harness events onto the shared
 * conversation-event model.
 */
function parseHarnessEvent(
  raw: HarnessRawEvent,
  fallbackTimestamp: string,
  state: HarnessParseState,
  options: ConversationParseOptions
): ConversationEvent[] {
  const timestamp = readString(raw.timestamp) ?? fallbackTimestamp;
  const data = raw.data;
  const correlation = readRecord(raw.correlation);
  const turnKey = harnessTurnKey(raw);
  const events: ConversationEvent[] = [];

  switch (raw.type) {
    case "session_started": {
      const model =
        readString(data.model) ?? readString(data.provider) ?? "Unknown";
      const sessionId =
        readString(correlation?.session_id) ??
        readString(data.provider_resume_id) ??
        raw.stream_id;
      events.push({ kind: "session_start", timestamp, model, sessionId });
      break;
    }
    case "turn_input": {
      const provenance = readString(data.provenance);
      const text = readString(data.content);
      if (provenance === "human" || provenance === "agent") {
        const notification = options.preserveRawInputs
          ? undefined
          : text
            ? readHarnessNotificationText(text)
            : undefined;
        if (notification) {
          events.push({
            kind: "task_notification",
            timestamp,
            message: notification,
          });
        } else if (
          text &&
          (options.preserveRawInputs || shouldKeepUserMessage(text))
        ) {
          events.push({ kind: "user_message", timestamp, text });
        }
      }
      break;
    }
    case "text": {
      const text = readString(data.text);
      if (text) {
        if (turnKey) state.turnsWithText.add(turnKey);
        events.push({ kind: "assistant_message", timestamp, text });
      }
      break;
    }
    case "reasoning": {
      const text = readString(data.text);
      if (text) {
        events.push({ kind: "thinking", timestamp, text });
      }
      break;
    }
    case "plan": {
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const items = entries.flatMap((entry) => {
        const plan = readRecord(entry);
        const text = readString(plan?.text);
        if (!text) return [];
        const status = readString(plan?.status)?.toLowerCase();
        return [
          { text, completed: status === "completed" || status === "done" },
        ];
      });
      if (items.length > 0) {
        events.push({
          kind: "todo_list",
          timestamp,
          itemId: `harness-plan:${readString(correlation?.thread_id) ?? raw.stream_id}`,
          items,
        });
      }
      break;
    }
    case "tool_call": {
      const toolId = readString(data.tool_call_id);
      const toolName = readString(data.name);
      if (toolId && toolName) {
        const input = readRecord(data.input) ?? {};
        events.push({
          kind: "tool_call",
          timestamp,
          toolId,
          toolName,
          displayName: getToolDisplayName(toolName),
          icon: getToolIcon(toolName),
          summary: getToolSummary(toolName, input),
          input,
        });
      }
      break;
    }
    case "tool_output": {
      const toolUseId = readString(data.tool_call_id);
      if (toolUseId) {
        const status = readString(data.status);
        events.push({
          kind: "tool_result",
          timestamp,
          toolUseId,
          isError:
            status === "failed" ||
            status === "declined" ||
            status === "cancelled",
          result: outputText(data.output),
        });
      }
      break;
    }
    case "file_change": {
      const changes = (Array.isArray(data.changes) ? data.changes : []).flatMap(
        (change) => {
          const file = readRecord(change);
          const path = readString(file?.path);
          if (!path) return [];
          const kind = readString(file?.kind)?.toLowerCase();
          return [
            {
              path,
              kind:
                kind === "add" || kind === "added"
                  ? "add"
                  : kind === "delete" || kind === "deleted"
                    ? "delete"
                    : kind === "rename" || kind === "renamed"
                      ? "rename"
                      : "update",
              diff: readString(file?.patch) ?? readString(file?.diff),
            },
          ];
        }
      );
      if (changes.length > 0) {
        events.push({
          kind: "file_edit",
          timestamp,
          toolId: readString(data.tool_call_id) ?? raw.event_id,
          status: readString(data.status) ?? "completed",
          changes,
        });
      }
      break;
    }
    case "turn_finished":
    case "run_finished": {
      const resultText = readString(data.result_text);
      if (resultText && (!turnKey || !state.turnsWithText.has(turnKey))) {
        events.push({ kind: "assistant_message", timestamp, text: resultText });
      }
      events.push({
        kind: "session_end",
        timestamp,
        ...harnessOutcomeMetrics(data),
      });
      break;
    }
  }

  return tagHarnessParent(events, raw);
}

interface HarnessParseState {
  /** Current text/reasoning delta row, keyed by turn and payload type. */
  activeDeltaByPayloadKey: Map<string, number>;
  /** Avoid duplicating a terminal result after provider text was already shown. */
  turnsWithText: Set<string>;
  /** Snapshot plans replace their prior version instead of growing the trace. */
  todoListByItemId: Map<string, number>;
  fileEditByToolId: Map<string, number>;
}

function harnessDeltaPayloadKey(raw: HarnessRawEvent): string | undefined {
  if (raw.type !== "text" && raw.type !== "reasoning") return undefined;
  const turnKey = harnessTurnKey(raw);
  return turnKey ? `${turnKey}:${raw.type}` : undefined;
}

function mergeHarnessDeltaEvent(
  events: ConversationEvent[],
  event: ConversationEvent,
  raw: HarnessRawEvent,
  state: HarnessParseState
): boolean {
  const payloadKey = harnessDeltaPayloadKey(raw);
  const isDelta = raw.semantics === "delta";
  const isSnapshot = raw.semantics === "snapshot";

  if (
    !payloadKey ||
    (event.kind !== "assistant_message" && event.kind !== "thinking") ||
    (!isDelta && !isSnapshot)
  ) {
    return false;
  }

  const activeIndex = state.activeDeltaByPayloadKey.get(payloadKey);
  if (isDelta && activeIndex !== undefined) {
    const previous = events[activeIndex];
    if (previous?.kind === event.kind) {
      events[activeIndex] = {
        ...previous,
        text: previous.text + event.text,
        timestamp: event.timestamp,
      };
      return true;
    }
  }

  if (isSnapshot && activeIndex !== undefined) {
    const previous = events[activeIndex];
    if (previous?.kind === event.kind) {
      events[activeIndex] = event;
      state.activeDeltaByPayloadKey.delete(payloadKey);
      return true;
    }
  }

  if (isDelta) state.activeDeltaByPayloadKey.set(payloadKey, events.length);
  return false;
}

/** Controls data-retention policy while projecting harness session logs. */
export interface ConversationParseOptions {
  /**
   * Keep each stored `turn_input` verbatim, including environment and plugin
   * context. Historic conversation artifacts use this mode; live surfaces keep
   * their existing concise input filtering.
   */
  preserveRawInputs?: boolean;
}

/**
 * Parse normalized HarnessEventV1 SessionLog entries into conversation events.
 * Entries without format="harness" or with invalid event payloads are ignored.
 */
export function parseSessionLogs(
  logs: SessionLog[],
  options: ConversationParseOptions = {}
): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  const harnessStateByExecution = new Map<string, HarnessParseState>();

  for (const log of logs) {
    if (log.format !== "harness") continue;

    let raw: unknown;
    try {
      raw = JSON.parse(log.content ?? "");
    } catch {
      continue;
    }
    if (!isHarnessRawEvent(raw)) continue;

    const execId = log.step_execution_id ?? "";
    let state = harnessStateByExecution.get(execId);
    if (!state) {
      state = {
        activeDeltaByPayloadKey: new Map(),
        turnsWithText: new Set(),
        todoListByItemId: new Map(),
        fileEditByToolId: new Map(),
      };
      harnessStateByExecution.set(execId, state);
    }

    const parsedHarnessEvents = parseHarnessEvent(
      raw,
      log.created_at ?? "",
      state,
      options
    );
    for (const ev of parsedHarnessEvents) {
      if (mergeHarnessDeltaEvent(events, ev, raw, state)) continue;
      if (ev.kind === "todo_list") {
        const priorIndex = state.todoListByItemId.get(ev.itemId);
        if (priorIndex !== undefined) {
          events[priorIndex] = ev;
          continue;
        }
        state.todoListByItemId.set(ev.itemId, events.length);
      }
      if (ev.kind === "file_edit" && ev.toolId) {
        const priorIndex = state.fileEditByToolId.get(ev.toolId);
        if (priorIndex !== undefined) {
          const previous = events[priorIndex];
          events[priorIndex] =
            previous?.kind === "file_edit" && ev.changes.length === 0
              ? { ...ev, changes: previous.changes }
              : ev;
          continue;
        }
        state.fileEditByToolId.set(ev.toolId, events.length);
      }
      events.push(ev);
    }

    const turnKey = harnessTurnKey(raw);
    if (
      turnKey &&
      (raw.type === "turn_finished" || raw.type === "run_finished")
    ) {
      for (const payloadKey of state.activeDeltaByPayloadKey.keys()) {
        if (payloadKey.startsWith(turnKey + ":")) {
          state.activeDeltaByPayloadKey.delete(payloadKey);
        }
      }
    }
  }

  return events;
}

/**
 * Validate and project a newline-delimited normalized harness transcript.
 *
 * Artifact previews intentionally use this stricter entry point rather than
 * treating arbitrary JSON as a conversation: every nonblank line must be a
 * HarnessEventV1 envelope. A malformed or unsupported transcript returns
 * undefined so the caller can preserve and display the original raw body.
 */
export function parseHarnessJsonl(
  body: string
): ConversationEvent[] | undefined {
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return undefined;

  const logs: SessionLog[] = [];
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isHarnessRawEvent(raw)) return undefined;
    logs.push({
      id: `artifact-event-${index}`,
      step_execution_id: "artifact-preview",
      format: "harness",
      content: line,
      created_at: raw.timestamp,
    });
  }

  const events = parseSessionLogs(logs, { preserveRawInputs: true });
  return events.length > 0 ? events : undefined;
}

// ============================================================================
// Trace event metadata
// ============================================================================

/**
 * Conversation event tagged with the execution and task it originated from.
 * Used by UnifiedChatView to merge events across multiple executions in a
 * subtree while still being able to draw step boundaries and delegation
 * blocks per (execution, step) and (task) tuple.
 */
export interface TaggedConversationEvent {
  event: ConversationEvent;
  executionId: string;
  taskId: string;
  workflowId: string | null;
  stepName: string | null;
  /** Execution start time, used as a stable tie-breaker. */
  executionStartedAt: string | null;
  /** Original index of this event within its parent execution's stream. */
  eventIndex: number;
}
