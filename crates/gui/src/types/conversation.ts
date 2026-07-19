/**
 * Types for parsing Claude session logs into a conversational view.
 *
 * SessionLog.content contains raw JSON from `claude --jsonl` output.
 * This module provides types and utilities to transform that into
 * structured conversation events for display.
 */

import type { SessionLog } from "../bindings";

// ============================================================================
// Raw Claude Message Types (from --jsonl output)
// ============================================================================

/** Content item types in Claude messages */
export type ClaudeContentItem =
  | { type: "text"; text: string }
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | unknown[];
      is_error?: boolean;
    };

export interface ClaudeMessageEnvelope {
  id?: string;
  content?: ClaudeContentItem[] | string;
  model?: string;
  role?: string;
}

export interface ClaudeRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

/** Raw Claude message structure from --jsonl */
export interface ClaudeRawMessage {
  type:
    | "system"
    | "assistant"
    | "user"
    | "result"
    | "task_notification"
    | "rate_limit_event";
  subtype?:
    | "init"
    | "success"
    | "error"
    | "thinking_tokens"
    | "task_progress"
    | "task_started"
    | "task_notification"
    | string;
  message?: ClaudeMessageEnvelope | string;
  /**
   * Subagent linkage. Anthropic stream-json carries this at the TOP LEVEL of
   * assistant/user messages emitted BY a spawned subagent: it is the
   * `tool_use` id of the parent `Task` (or other spawn) tool call that
   * launched the subagent. The parser threads it onto every emitted
   * {@link ConversationEvent} as `parentToolUseId` so the normalizer can lift
   * those events into a nested child Thread. Absent/null on the main agent's
   * own messages.
   */
  parent_tool_use_id?: string | null;
  /**
   * Set on harness-injected `user`-role lines (skill preambles, command
   * caveats, …) that were never typed by the user; such lines must not render
   * as user messages.
   */
  isMeta?: boolean;
  // System init fields
  model?: string;
  session_id?: string;
  // Claude Code 2.1.x live telemetry fields
  estimated_tokens?: number;
  estimated_tokens_delta?: number;
  tool_use_id?: string;
  task_id?: string;
  description?: string;
  subagent_type?: string;
  rate_limit_info?: ClaudeRateLimitInfo;
  // Result fields
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
}

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
   * Subagent linkage (the ONLY intra-run nesting axis). When set, this event
   * was emitted by a spawned subagent and this is the `tool_use` id of the
   * parent spawn tool call (Anthropic's top-level `parent_tool_use_id`, or the
   * Codex `collab_tool_call` id). The normalizer's `groupBySpawn` reads this
   * (via `readParentToolUseId`) to lift the event into a nested child Thread.
   * Undefined on the main agent's own events.
   */
  parentToolUseId?: string;
}

/** User prompt text from provider JSONL, emitted only for full transcript replay. */
export interface UserMessageEvent extends BaseEvent {
  kind: "user_message";
  text: string;
}

/** Session start event - from 'system' type with subtype 'init' */
export interface SessionStartEvent extends BaseEvent {
  kind: "session_start";
  model: string;
  sessionId: string;
}

/** Session end event - from 'result' with subtype 'success' */
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

/** Claude Code thinking-token heartbeat. */
export interface ThinkingHeartbeatEvent extends BaseEvent {
  kind: "thinking_heartbeat";
  sessionId: string;
  estimatedTokens: number;
  estimatedTokensDelta: number;
}

/** Claude Code subagent progress snapshot. */
export interface TaskProgressEvent extends BaseEvent {
  kind: "task_progress";
  toolUseId: string;
  taskId?: string;
  description: string;
  subagentType?: string;
}

/** Claude Code subagent start event. */
export interface TaskStartedEvent extends BaseEvent {
  kind: "task_started";
  toolUseId?: string;
  taskId?: string;
  description: string;
  subagentType?: string;
}

/** Claude Code task-level notification event. */
export interface TaskNotificationEvent extends BaseEvent {
  kind: "task_notification";
  message: string;
}

/** Claude Code rate-limit status snapshot. */
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

/** Tool call event - from tool_use in assistant content */
export interface ToolCallEvent extends BaseEvent {
  kind: "tool_call";
  toolId: string;
  toolName: string;
  displayName: string;
  icon: string;
  summary: string;
  input: Record<string, unknown>;
}

/** Tool result event - from tool_result in user content */
export interface ToolResultEvent extends BaseEvent {
  kind: "tool_result";
  toolUseId: string;
  isError: boolean;
  result: string;
}

/**
 * Status of a Codex `file_change` patch application.
 *
 * Codex's upstream schema reports per-patch status as an enum (`completed`
 * or `failed`); we keep the discriminator open so unknown future statuses
 * don't break parsing.
 */
export type PatchApplyStatus = "completed" | "failed" | string;

/** A single per-file change inside a Codex `file_change` item. */
export interface FileUpdateChange {
  /** Repo-relative path of the file being changed. */
  path: string;
  /** Codex change kind: add, delete, or update (open string for forward-compat). */
  kind: "add" | "delete" | "update" | string;
  /** Unified diff body, when Codex provides one. */
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

/** A single checklist row in a Codex `todo_list` item. */
export interface TodoListItem {
  text: string;
  completed: boolean;
}

/**
 * Plan/todo checklist event sourced from Codex `todo_list` items. Codex
 * emits these as `item.started` and refines them via `item.updated`; the
 * parser dedupes by `itemId`, replacing earlier entries in place so the
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

export interface ParseSessionLogsOptions {
  /**
   * Include user-authored transcript messages. Traces leave this off because
   * step prompts are already represented by StepExecution.prompt; local chat
   * restore enables it to rebuild the complete conversation from provider JSONL.
   */
  includeUserMessages?: boolean;
}

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

function readClaudeMessageContent(
  message: ClaudeRawMessage["message"]
): ClaudeMessageEnvelope["content"] | undefined {
  return typeof message === "object" && message !== null && "content" in message
    ? message.content
    : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return (
        readString(record.text) ??
        readString(record.input_text) ??
        readString(record.output_text) ??
        ""
      );
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve the original argument string under a stable key.
  }
  return { arguments: value };
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
    trimmed.length > 0 && !trimmed.startsWith("# AGENTS.md instructions for ")
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

function readNotificationMessage(raw: ClaudeRawMessage): string | undefined {
  const record = raw as unknown as Record<string, unknown>;
  return (
    readString(raw.description) ??
    readString(raw.message) ??
    readString(record.content) ??
    readString(record.text)
  );
}

function rateLimitEvent(
  raw: ClaudeRawMessage,
  timestamp: string
): RateLimitEvent {
  const info =
    raw.rate_limit_info && typeof raw.rate_limit_info === "object"
      ? raw.rate_limit_info
      : {};
  return {
    kind: "rate_limit",
    timestamp,
    sessionId: readString(raw.session_id),
    status: readString(info.status),
    rateLimitType: readString(info.rateLimitType),
    resetsAt: readNumber(info.resetsAt),
    overageStatus: readString(info.overageStatus),
    overageDisabledReason: readString(info.overageDisabledReason),
    isUsingOverage:
      typeof info.isUsingOverage === "boolean"
        ? info.isUsingOverage
        : undefined,
  };
}

function isRateLimitFailure(raw: ClaudeRawMessage): boolean {
  const record = raw as unknown as Record<string, unknown>;
  const info =
    raw.rate_limit_info && typeof raw.rate_limit_info === "object"
      ? (raw.rate_limit_info as unknown as Record<string, unknown>)
      : undefined;
  const status = readString(info?.status) ?? readString(record.status);
  const message =
    readString(record.message) ??
    readString(record.reason) ??
    (record.error && typeof record.error === "object"
      ? readString((record.error as Record<string, unknown>).message)
      : undefined) ??
    readString(info?.message);
  const messageIsRateLimit = message
    ? /rate[ _]limit|too many requests/i.test(message)
    : false;
  const statusIsFailure = status
    ? !["allowed", "ok", "available", "active"].includes(status.toLowerCase())
    : false;
  return messageIsRateLimit || statusIsFailure;
}

/**
 * Parse a single Claude JSON message into conversation events.
 * Returns an array because one message can contain multiple content items.
 */
export function parseClaudeMessage(
  raw: ClaudeRawMessage,
  timestamp: string,
  options: ParseSessionLogsOptions = {},
  state: ClaudeParseState = {
    latestSnapshotByKey: new Map(),
    fileChangesByToolId: new Map(),
    fileEditByToolId: new Map(),
  }
): ConversationEvent[] {
  const events: ConversationEvent[] = [];

  switch (raw.type) {
    case "system":
      if (raw.subtype === "init" && raw.model && raw.session_id) {
        events.push({
          kind: "session_start",
          timestamp,
          model: raw.model,
          sessionId: raw.session_id,
        });
      } else if (raw.subtype === "thinking_tokens") {
        const sessionId = readString(raw.session_id);
        const estimatedTokens = readNumber(raw.estimated_tokens);
        if (sessionId && estimatedTokens !== undefined) {
          events.push({
            kind: "thinking_heartbeat",
            timestamp,
            sessionId,
            estimatedTokens,
            estimatedTokensDelta: readNumber(raw.estimated_tokens_delta) ?? 0,
          });
        }
      } else if (raw.subtype === "task_progress") {
        const toolUseId = readString(raw.tool_use_id);
        const description = readString(raw.description);
        if (toolUseId && description) {
          events.push({
            kind: "task_progress",
            timestamp,
            toolUseId,
            taskId: readString(raw.task_id),
            description,
            subagentType: readString(raw.subagent_type),
          });
        }
      } else if (raw.subtype === "task_started") {
        events.push({
          kind: "task_started",
          timestamp,
          toolUseId: readString(raw.tool_use_id),
          taskId: readString(raw.task_id),
          description:
            readString(raw.description) ??
            readString(raw.subagent_type) ??
            "Subagent started",
          subagentType: readString(raw.subagent_type),
        });
      } else if (raw.subtype === "task_notification") {
        const message = readNotificationMessage(raw);
        if (message) {
          events.push({ kind: "task_notification", timestamp, message });
        }
      }
      break;

    case "assistant":
      {
        const content = readClaudeMessageContent(raw.message);
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === "text" && item.text) {
              events.push({
                kind: "assistant_message",
                timestamp,
                text: item.text,
              });
            } else if (item.type === "tool_use") {
              const changes = claudeFileChanges(item.name, item.input);
              if (changes.length > 0) {
                state.fileChangesByToolId.set(item.id, changes);
                events.push({
                  kind: "file_edit",
                  timestamp,
                  toolId: item.id,
                  status: "started",
                  changes,
                });
              }
              events.push({
                kind: "tool_call",
                timestamp,
                toolId: item.id,
                toolName: item.name,
                displayName: getToolDisplayName(item.name),
                icon: getToolIcon(item.name),
                summary: getToolSummary(item.name, item.input),
                input: item.input,
              });
            }
          }
        }
      }
      break;

    case "user":
      {
        const content = readClaudeMessageContent(raw.message);
        if (options.includeUserMessages && raw.isMeta !== true) {
          const text = contentText(content).trim();
          const notification = readTaskNotificationText(text);
          if (notification) {
            events.push({
              kind: "task_notification",
              timestamp,
              message: notification,
            });
          } else if (shouldKeepUserMessage(text)) {
            events.push({ kind: "user_message", timestamp, text });
          }
        }
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === "tool_result") {
              const changes = state.fileChangesByToolId.get(item.tool_use_id);
              if (changes) {
                state.fileChangesByToolId.delete(item.tool_use_id);
                events.push({
                  kind: "file_edit",
                  timestamp,
                  toolId: item.tool_use_id,
                  status: item.is_error ? "failed" : "completed",
                  changes,
                });
              }
              const toolResultContent = item.content;
              const resultText =
                typeof toolResultContent === "string"
                  ? toolResultContent
                  : JSON.stringify(toolResultContent);
              events.push({
                kind: "tool_result",
                timestamp,
                toolUseId: item.tool_use_id,
                isError: item.is_error ?? false,
                // Full output, newlines preserved — the tool body renders as a
                // scrollable card. (The compact one-line tool label is separate.)
                result: resultText,
              });
            }
          }
        }
      }
      break;

    case "result":
      if (raw.subtype === "success") {
        events.push({
          kind: "session_end",
          timestamp,
          durationMs: raw.duration_ms ?? 0,
          numTurns: raw.num_turns ?? 0,
          costUsd: raw.total_cost_usd ?? 0,
        });
      }
      break;

    case "task_notification": {
      const message = readNotificationMessage(raw);
      if (message)
        events.push({ kind: "task_notification", timestamp, message });
      break;
    }

    case "rate_limit_event":
      if (isRateLimitFailure(raw)) events.push(rateLimitEvent(raw, timestamp));
      break;
  }

  // Thread Anthropic's top-level subagent linkage onto every event emitted
  // from this message. When a subagent runs, its assistant/user stream-json
  // lines carry `parent_tool_use_id` = the parent spawn tool's id; tagging the
  // events lets the normalizer nest them into a child Thread. When absent/null
  // we leave `parentToolUseId` undefined (main-agent events stay flat).
  const parentToolUseId =
    typeof raw.parent_tool_use_id === "string" &&
    raw.parent_tool_use_id.length > 0
      ? raw.parent_tool_use_id
      : undefined;
  if (parentToolUseId) {
    for (const ev of events) ev.parentToolUseId = parentToolUseId;
  } else {
    for (const ev of events) {
      if (ev.kind === "task_progress" || ev.kind === "task_started") {
        const toolUseId = ev.toolUseId;
        if (toolUseId) ev.parentToolUseId = toolUseId;
      }
    }
  }

  return events;
}

/** Convert Claude's native file-writing tools into the shared file-edit row. */
function claudeFileChanges(
  name: string,
  input: Record<string, unknown>
): FileUpdateChange[] {
  const path = readString(input.file_path) ?? readString(input.path);
  if (!path) return [];
  if (name === "Edit") {
    const oldValue =
      typeof input.old_string === "string" ? input.old_string : "";
    const newValue =
      typeof input.new_string === "string" ? input.new_string : "";
    return [
      {
        path,
        kind: "update",
        diff: syntheticDiff(oldValue, newValue),
      },
    ];
  }
  if (name === "Write") {
    const content = typeof input.content === "string" ? input.content : "";
    return [{ path, kind: "add", diff: syntheticDiff("", content) }];
  }
  if (name === "NotebookEdit") {
    const source = typeof input.new_source === "string" ? input.new_source : "";
    return [{ path, kind: "update", diff: syntheticDiff("", source) }];
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const diffs = input.edits.flatMap((edit) => {
      const record = readRecord(edit);
      if (!record) return [];
      const oldValue =
        typeof record.old_string === "string" ? record.old_string : "";
      const newValue =
        typeof record.new_string === "string" ? record.new_string : "";
      return [syntheticDiff(oldValue, newValue)];
    });
    if (diffs.length > 0)
      return [{ path, kind: "update", diff: diffs.join("\n") }];
  }
  return [];
}

function syntheticDiff(oldValue: string, newValue: string): string {
  const lines = ["@@"];
  if (oldValue) lines.push(...oldValue.split("\n").map((line) => `-${line}`));
  if (newValue) lines.push(...newValue.split("\n").map((line) => `+${line}`));
  if (lines.length === 1) lines.push("+");
  return lines.join("\n");
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
 * Projects persisted neutral harness events onto the trace's established
 * conversation-event model. The projection deliberately preserves the legacy
 * Claude parser: only logs tagged `format: "harness"` use this path.
 */
function parseHarnessEvent(
  raw: HarnessRawEvent,
  fallbackTimestamp: string,
  state: HarnessParseState
): ConversationEvent[] {
  const timestamp = readString(raw.timestamp) ?? fallbackTimestamp;
  const data = raw.data;
  const correlation = readRecord(raw.correlation);
  const turnKey = harnessTurnKey(raw);
  const turnPayloadKey = turnKey ? `${turnKey}:${raw.type}` : undefined;
  const events: ConversationEvent[] = [];

  switch (raw.type) {
    case "session_started": {
      const model = readString(data.model) ?? "Claude";
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
      if ((provenance === "human" || provenance === "agent") && text) {
        events.push({ kind: "user_message", timestamp, text });
      }
      break;
    }
    case "text": {
      const text = readString(data.text);
      if (text) {
        if (
          raw.semantics === "snapshot" &&
          turnPayloadKey &&
          state.deltaPayloads.has(turnPayloadKey)
        ) {
          break;
        }
        if (raw.semantics === "delta" && turnPayloadKey)
          state.deltaPayloads.add(turnPayloadKey);
        if (turnKey) state.turnsWithText.add(turnKey);
        events.push({ kind: "assistant_message", timestamp, text });
      }
      break;
    }
    case "reasoning": {
      const text = readString(data.text);
      if (text) {
        if (
          raw.semantics === "snapshot" &&
          turnPayloadKey &&
          state.deltaPayloads.has(turnPayloadKey)
        ) {
          break;
        }
        if (raw.semantics === "delta" && turnPayloadKey)
          state.deltaPayloads.add(turnPayloadKey);
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

// ============================================================================
// Codex `exec --json` raw message types
// ============================================================================

/** Item payload inside a Codex `item.started` / `item.updated` / `item.completed` event.
 *
 * Per the upstream schema (`codex-rs/exec/src/exec_events.rs`), `ThreadItemDetails`
 * is `#[serde(tag = "type", rename_all = "snake_case")]` flattened into
 * `ThreadItem`, so the discriminator is the `type` field on the item object.
 */
export interface CodexItem {
  id?: string;
  type?:
    | "agent_message"
    | "reasoning"
    | "command_execution"
    | "mcp_tool_call"
    | "web_search"
    | "file_change"
    | "fileChange"
    | "todo_list"
    | "collab_tool_call"
    | string;
  /** Present on `agent_message` and `reasoning` items. */
  text?: string;
  /** Present on `command_execution` items. */
  command?: string;
  exit_code?: number;
  /** Captured stdout/stderr for completed command_execution items. */
  aggregated_output?: string;
  // ------ mcp_tool_call ------
  /** MCP server name, e.g. `morph_mcp`. */
  server?: string;
  /** MCP tool name on the server, e.g. `edit_file`. */
  tool?: string;
  /** Arguments passed to the MCP tool. */
  arguments?: Record<string, unknown>;
  /** MCP success result payload (string, list, or object). */
  result?: unknown;
  /** MCP error message when the call failed. */
  error?: string;
  // ------ web_search ------
  /** Search query string. */
  query?: string;
  /** Optional action discriminator (e.g. `search`, `summary`). */
  action?: string;
  // ------ file_change ------
  /**
   * Per-file changes for a `file_change` item. Each entry carries a path,
   * a kind discriminator (add/delete/update), and an optional unified diff.
   */
  changes?: FileUpdateChange[];
  /** Patch application status for a `file_change` item. */
  status?: PatchApplyStatus;
  // ------ todo_list ------
  /** Plan rows for a `todo_list` item. */
  items?: TodoListItem[];
}

/** Raw shape of a single Codex `exec --json` JSONL line.
 *
 * Mirrors `ThreadEvent` in the upstream schema. Note that there is no
 * `thread.completed` or `thread.failed` event -- successful streams just
 * terminate, and fatal errors arrive as `{"type":"error","message":"..."}`.
 */
export interface CodexRawMessage {
  type:
    | "thread.started"
    | "turn.started"
    | "turn.completed"
    | "turn.failed"
    | "item.started"
    | "item.updated"
    | "item.completed"
    | "error"
    | string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  /** Present on top-level `error` events (`ThreadErrorEvent`). */
  message?: string;
}

/**
 * A single per-file change inside a Codex rollout `patch_apply_end`
 * `event_msg` payload, keyed by absolute file path (see
 * {@link CodexRolloutRawMessage.payload.changes}). Distinct from
 * {@link FileUpdateChange} (the `exec --json` `file_change` shape): real
 * rollout files show only `update` changes carry `unified_diff` -- `add` and
 * `delete` changes carry the full file `content` instead, with no diff.
 */
interface CodexRolloutFileChange {
  type: "add" | "delete" | "update" | string;
  unified_diff?: string;
  content?: string;
}

export interface CodexRolloutRawMessage {
  type: "response_item" | "event_msg" | "session_meta" | string;
  timestamp?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
    call_id?: string;
    id?: string;
    namespace?: string;
    name?: string;
    arguments?: unknown;
    input?: unknown;
    output?: unknown;
    exit_code?: number;
    message?: string;
    // -- event_msg "patch_apply_end" --
    success?: boolean;
    changes?: Record<string, CodexRolloutFileChange>;
    // -- event_msg "turn_aborted" --
    reason?: string;
  };
}

/**
 * True if a parsed JSON object looks like a Codex `exec --json` event.
 *
 * Codex events carry `type` strings prefixed with `thread.`, `turn.`, or
 * `item.`, plus the bare `error` event for fatal stream errors. Claude
 * `--output-format stream-json` uses bare names like `system`, `assistant`,
 * `user`, `result`. The two namespaces don't overlap.
 */
function isCodexRawMessage(raw: unknown): raw is CodexRawMessage {
  if (raw === null || typeof raw !== "object") return false;
  const t = (raw as { type?: unknown }).type;
  if (typeof t !== "string") return false;
  return (
    t.startsWith("thread.") ||
    t.startsWith("turn.") ||
    t.startsWith("item.") ||
    t === "error"
  );
}

function isCodexRolloutRawMessage(raw: unknown): raw is CodexRolloutRawMessage {
  if (raw === null || typeof raw !== "object") return false;
  const t = (raw as { type?: unknown }).type;
  return t === "response_item" || t === "event_msg" || t === "session_meta";
}

/**
 * Parse a single Codex JSONL event into the same `ConversationEvent` union
 * Claude logs produce. The mapping is:
 *
 * - `thread.started`                         -> `session_start`
 * - `turn.failed`                            -> `thinking` (`[error] ...`)
 * - `error` (top-level, fatal stream error)  -> `session_end` + `thinking`
 * - `item.completed` w/ `reasoning`          -> `thinking` (text)
 * - `item.completed` w/ `command_execution`  -> `tool_call` + `tool_result`
 * - `item.completed` w/ `agent_message`      -> `assistant_message` (final text)
 * - `item.completed` w/ `mcp_tool_call`      -> `tool_call` + `tool_result`
 * - `item.completed` w/ `web_search`         -> `tool_call` + `tool_result`
 * - `item.completed` w/ `file_change`        -> `file_edit`
 * - `item.started`/`item.updated` w/ `todo_list` -> `todo_list`
 *
 * `agent_message` is the user-facing final reply; we surface it as the
 * dedicated `assistant_message` kind so renderers can style it differently
 * from internal `reasoning` (which still maps to `thinking`).
 *
 * For `todo_list` we honor `item.updated` because that is the upstream
 * Codex behavior (plan refinements arrive as updates). The dedupe is by
 * `item.id` and lives at the parser layer because the renderer is a pure
 * map over the events array; emitting one event per update would balloon
 * the timeline.
 *
 * Note: there is no `thread.completed` event in the upstream schema --
 * successful streams just terminate after `turn.completed`. The session_end
 * event is synthesised at a higher layer (e.g. when the execution row reaches
 * a terminal status), not from a JSONL marker.
 *
 * The `state` arg lets `parseSessionLogs` thread a shared turn counter and
 * a per-execution map of TodoList items keyed by `item.id` across the
 * contiguous run of Codex lines belonging to one execution.
 */
export function parseCodexMessage(
  raw: CodexRawMessage,
  timestamp: string,
  state: CodexParseState = {
    turnCount: 0,
    todoListByItemId: new Map(),
    fileEditByItemId: new Map(),
  }
): ConversationEvent[] {
  const events: ConversationEvent[] = [];

  switch (raw.type) {
    case "thread.started":
      events.push({
        kind: "session_start",
        timestamp,
        // ThreadStartedEvent has only `thread_id` -- no model field.
        model: "codex",
        sessionId: raw.thread_id ?? "",
      });
      break;

    case "turn.started":
      state.turnCount += 1;
      break;

    case "item.started":
    case "item.updated": {
      const item = raw.item;
      if (item?.type === "file_change" || item?.type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        if (changes.length > 0) {
          events.push({
            kind: "file_edit",
            timestamp,
            toolId: item.id ?? "",
            status: item.status ?? "started",
            changes,
          });
        }
        break;
      }
      // Only `todo_list` items use the started/updated channel for
      // user-visible state -- agent_message text streams in via these too
      // but the final text is what we render, on item.completed. Per the
      // upstream Codex schema, plan refinements arrive as `item.updated`.
      if (!item || item.type !== "todo_list") break;
      const ev = makeTodoListEvent(item, timestamp);
      if (ev) events.push(ev);
      break;
    }

    case "item.completed": {
      const item = raw.item;
      if (!item) break;
      switch (item.type) {
        case "reasoning": {
          const text = item.text;
          if (text && text.length > 0) {
            events.push({ kind: "thinking", timestamp, text });
          }
          break;
        }
        case "agent_message": {
          // Final user-facing reply. Distinct from `reasoning` so renderers
          // can style it as the assistant's "spoken" answer rather than
          // chain-of-thought.
          const text = item.text;
          if (text && text.length > 0) {
            events.push({ kind: "assistant_message", timestamp, text });
          }
          break;
        }
        case "command_execution": {
          const toolId = item.id ?? "";
          const command = item.command ?? "";
          events.push({
            kind: "tool_call",
            timestamp,
            toolId,
            toolName: "Bash",
            displayName: "Bash",
            icon: getToolIcon("Bash"),
            summary: truncate(command, 80),
            input: { command },
          });
          events.push({
            kind: "tool_result",
            timestamp,
            toolUseId: toolId,
            isError: typeof item.exit_code === "number" && item.exit_code !== 0,
            // Full output, newlines preserved — rendered in a scrollable card.
            result: item.aggregated_output ?? "",
          });
          break;
        }
        case "mcp_tool_call": {
          const toolId = item.id ?? "";
          const server = item.server ?? "";
          const tool = item.tool ?? "";
          // Compose Claude's `mcp__server__tool` form so getToolDisplayName
          // (strip prefix, take last segment) and getToolIcon's MCP entries
          // both apply.
          const toolName =
            server && tool
              ? `mcp__${server}__${tool}`
              : tool || server || "mcp";
          const args = item.arguments ?? {};
          const isError =
            typeof item.error === "string" && item.error.length > 0;
          const resultText = isError
            ? (item.error as string)
            : codexResultToString(item.result);
          events.push({
            kind: "tool_call",
            timestamp,
            toolId,
            toolName,
            displayName: getToolDisplayName(toolName),
            icon: getToolIcon(toolName),
            summary: getToolSummary(toolName, args),
            input: args,
          });
          events.push({
            kind: "tool_result",
            timestamp,
            toolUseId: toolId,
            isError,
            result: truncate(resultText.replace(/\n/g, " "), 200),
          });
          break;
        }
        case "web_search": {
          const toolId = item.id ?? "";
          const query = item.query ?? "";
          const action = item.action ?? "search";
          const isError =
            typeof item.error === "string" && item.error.length > 0;
          const resultText = isError
            ? (item.error as string)
            : codexResultToString(item.result);
          const input: Record<string, unknown> = { query, action };
          events.push({
            kind: "tool_call",
            timestamp,
            toolId,
            toolName: "WebSearch",
            displayName: "WebSearch",
            icon: getToolIcon("WebSearch"),
            summary: truncate(query, 80),
            input,
          });
          events.push({
            kind: "tool_result",
            timestamp,
            toolUseId: toolId,
            isError,
            result: truncate(resultText.replace(/\n/g, " "), 200),
          });
          break;
        }
        case "file_change":
        case "fileChange": {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          // Drop empty patches silently -- nothing to render.
          if (changes.length === 0) break;
          events.push({
            kind: "file_edit",
            timestamp,
            toolId: item.id ?? "",
            status: item.status ?? "completed",
            changes,
          });
          break;
        }
        case "todo_list": {
          // Some Codex streams emit the todo_list only on completion (no
          // prior started/updated). Treat it the same; dedupe-by-id is
          // applied at the parseSessionLogs layer.
          const ev = makeTodoListEvent(item, timestamp);
          if (ev) events.push(ev);
          break;
        }
        case "collab_tool_call": {
          // Codex's subagent-spawn vehicle. We surface it as a `tool_call` so
          // it appears as the PARENT tool in the timeline (mirroring how an
          // Anthropic `Task` tool_use renders). The id becomes the spawn key.
          //
          // TODO(spawn-linkage / codex): the CHILD linkage is NOT implemented.
          // The upstream `collab_tool_call` schema is still in flight and does
          // not (in any shape verified in this codebase — no fixtures, no
          // vendored codex source) expose how a subagent's child events refer
          // back to this id. Anthropic carries `parent_tool_use_id` on each
          // child message; the Codex equivalent is unknown. Until the real
          // shape is confirmed, child events are NOT tagged with
          // `parentToolUseId`, so the subagent's events (if any) stay flat
          // rather than being nested incorrectly. Do NOT invent the field.
          const toolId = item.id ?? "";
          // Best-effort label: prefer an explicit tool/command name if Codex
          // provides one, else a generic "subagent".
          const toolName = item.tool || item.command || "subagent";
          const args =
            (item.arguments as Record<string, unknown> | undefined) ?? {};
          events.push({
            kind: "tool_call",
            timestamp,
            toolId,
            toolName,
            displayName: getToolDisplayName(toolName),
            icon: getToolIcon(toolName),
            summary: getToolSummary(toolName, args),
            input: args,
          });
          break;
        }
        default:
          // Unknown item types are intentionally dropped from the timeline,
          // but we log via console.debug so schema drift surfaces during
          // development without throwing in production. The raw line is
          // still preserved at the SessionLog layer.
          if (typeof console !== "undefined") {
            console.debug(
              `[codex] dropping unknown item.type=${String(item.type)}`,
              item
            );
          }
          break;
      }
      break;
    }

    case "turn.failed": {
      const msg = raw.error?.message ?? "turn failed";
      events.push({ kind: "thinking", timestamp, text: `[error] ${msg}` });
      break;
    }

    case "error": {
      // Top-level `ThreadErrorEvent`: an unrecoverable stream error. Surface
      // the message as a `thinking` event and emit a `session_end` so the
      // timeline closes cleanly even though no `turn.completed` followed.
      const msg = raw.message ?? "codex error";
      events.push({ kind: "thinking", timestamp, text: `[error] ${msg}` });
      events.push({
        kind: "session_end",
        timestamp,
        durationMs: 0,
        numTurns: state.turnCount,
        costUsd: 0,
      });
      break;
    }

    default:
      break;
  }

  return events;
}

export interface PendingMultiAgentCall {
  name: string;
  input: Record<string, unknown>;
}

export interface CodexRolloutParseState {
  pendingMultiAgentCallsByCallId: Map<string, PendingMultiAgentCall>;
  agentToolIdByAgentPath: Map<string, string>;
  agentSpawnEventByAgentPath: Map<string, ToolCallEvent>;
  completedAgentPaths: Set<string>;
  /**
   * `session_meta.payload.id` values already turned into a `session_start`
   * event. Real rollout files repeat the identical `session_meta` line many
   * times over the life of a thread (e.g. resume/compaction re-stamps) --
   * dedup by id so the timeline gets one `session_start` per thread instead
   * of dozens of identical ones.
   */
  emittedSessionStartIds: Set<string>;
  fileEditByToolId: Map<string, number>;
}

function newCodexRolloutParseState(): CodexRolloutParseState {
  return {
    pendingMultiAgentCallsByCallId: new Map(),
    agentToolIdByAgentPath: new Map(),
    agentSpawnEventByAgentPath: new Map(),
    completedAgentPaths: new Set(),
    emittedSessionStartIds: new Set(),
    fileEditByToolId: new Map(),
  };
}

function agentToolId(agentPath: string): string {
  return `agent:${agentPath}`;
}

function makeAgentSpawnEvent(
  timestamp: string,
  toolId: string,
  input: Record<string, unknown>
): ToolCallEvent {
  return {
    kind: "tool_call",
    timestamp,
    toolId,
    toolName: "Agent",
    displayName: "Agent",
    icon: getToolIcon("Agent"),
    summary: getToolSummary("Agent", input),
    input,
  };
}

function ensureAgentSpawnEvent(
  state: CodexRolloutParseState,
  timestamp: string,
  agentPath: string,
  overrides: Record<string, unknown> = {}
): ToolCallEvent | undefined {
  if (state.agentToolIdByAgentPath.has(agentPath)) return undefined;
  const toolId = agentToolId(agentPath);
  state.agentToolIdByAgentPath.set(agentPath, toolId);
  const event = makeAgentSpawnEvent(timestamp, toolId, {
    collab_tool: "spawnAgent",
    agent_path: agentPath,
    receiver_thread_ids: [agentPath],
    description: overrides.description ?? overrides.agent_nickname ?? "Agent",
    ...overrides,
  });
  state.agentSpawnEventByAgentPath.set(agentPath, event);
  return event;
}

function markAgentSpawnCompleted(
  state: CodexRolloutParseState,
  agentPath: string
): void {
  const event = state.agentSpawnEventByAgentPath.get(agentPath);
  if (!event) return;
  const agentsStates = readRecord(event.input.agents_states) ?? {};
  event.input = {
    ...event.input,
    agents_states: {
      ...agentsStates,
      [agentPath]: {
        ...(readRecord(agentsStates[agentPath]) ?? {}),
        status: "completed",
      },
    },
  };
  event.summary = getToolSummary(event.toolName, event.input);
}

function agentResultEvents(
  timestamp: string,
  agentPath: string,
  parentToolId: string,
  completedText: string
): ConversationEvent[] {
  const toolId = `${parentToolId}:result:${agentPath}`;
  const input = {
    collab_tool: "agentResult",
    agent_path: agentPath,
    receiver_thread_ids: [agentPath],
    parent_tool_use_id: parentToolId,
  };
  return [
    {
      kind: "tool_call",
      timestamp,
      toolId,
      toolName: "Agent Result",
      displayName: "Agent Result",
      icon: getToolIcon("Agent"),
      summary: getToolSummary("Agent Result", input),
      input,
    },
    {
      kind: "tool_result",
      timestamp,
      toolUseId: toolId,
      isError: false,
      result: completedText,
    },
  ];
}

function emitAgentCompletion(
  state: CodexRolloutParseState,
  timestamp: string,
  agentPath: string,
  completedText: string
): ConversationEvent[] {
  if (state.completedAgentPaths.has(agentPath)) return [];
  state.completedAgentPaths.add(agentPath);

  const events: ConversationEvent[] = [];
  const spawnEvent = ensureAgentSpawnEvent(state, timestamp, agentPath);
  if (spawnEvent) events.push(spawnEvent);

  const toolId =
    state.agentToolIdByAgentPath.get(agentPath) ?? agentToolId(agentPath);
  markAgentSpawnCompleted(state, agentPath);
  events.push({
    kind: "tool_result",
    timestamp,
    toolUseId: toolId,
    isError: false,
    result: "completed",
  });
  events.push(
    ...agentResultEvents(timestamp, agentPath, toolId, completedText)
  );
  return events;
}

/**
 * Codex injects subagent status updates into the parent transcript as
 * `user`-role messages wrapping `<subagent_notification>` JSON blocks — the
 * user never typed them. Returns one parsed body per block (null when a body
 * isn't valid JSON); an empty array means the text carries no notification.
 */
function readSubagentNotificationBodies(
  text: string
): Array<Record<string, unknown> | null> {
  const pattern =
    /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/g;
  return Array.from(text.matchAll(pattern), (m) => parseRecord(m[1]) ?? null);
}

/**
 * Human-readable notice for a notification body that is NOT a nestable
 * completion (real rollouts carry e.g. `status: "shutdown"` as a bare string
 * alongside the `{completed: …}` object shape).
 */
function subagentStatusMessage(status: unknown): string {
  if (typeof status === "string" && status) return `Subagent ${status}`;
  const record = readRecord(status);
  const key = record ? Object.keys(record)[0] : undefined;
  if (record && key) {
    const detail = readString(record[key]);
    return detail ? `Subagent ${key}: ${detail}` : `Subagent ${key}`;
  }
  return "Subagent notification";
}

function subagentNotificationEvents(
  state: CodexRolloutParseState,
  timestamp: string,
  bodies: Array<Record<string, unknown> | null>
): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  for (const body of bodies) {
    const agentPath = readString(body?.agent_path);
    const completedText = readString(readRecord(body?.status)?.completed);
    if (agentPath && completedText) {
      events.push(
        ...emitAgentCompletion(state, timestamp, agentPath, completedText)
      );
    } else {
      events.push({
        kind: "task_notification",
        timestamp,
        message: subagentStatusMessage(body?.status),
      });
    }
  }
  return events;
}

function parseMultiAgentFunctionCall(
  raw: CodexRolloutRawMessage,
  timestamp: string,
  state: CodexRolloutParseState
): ConversationEvent[] | undefined {
  const payload = raw.payload;
  if (!payload) return undefined;

  if (payload.type === "function_call") {
    if (payload.namespace !== "multi_agent_v1") return undefined;
    const callId = readString(payload.call_id) ?? readString(payload.id) ?? "";
    if (!callId) return [];
    state.pendingMultiAgentCallsByCallId.set(callId, {
      name: readString(payload.name) ?? "tool",
      input: parseRecord(payload.arguments) ?? {},
    });
    return [];
  }

  if (payload.type !== "function_call_output") return undefined;

  const callId = readString(payload.call_id) ?? readString(payload.id) ?? "";
  const pending = callId
    ? state.pendingMultiAgentCallsByCallId.get(callId)
    : undefined;
  if (!pending) {
    return payload.namespace === "multi_agent_v1" ? [] : undefined;
  }
  state.pendingMultiAgentCallsByCallId.delete(callId);

  const output = parseRecord(payload.output) ?? {};
  switch (pending.name) {
    case "spawn_agent": {
      const agentPath =
        readString(output.agent_id) ??
        readString(output.agent_path) ??
        readString(output.id);
      if (!agentPath) return [];
      const nickname = readString(output.nickname);
      const toolId = agentToolId(agentPath);
      state.agentToolIdByAgentPath.set(agentPath, toolId);
      const input: Record<string, unknown> = {
        collab_tool: "spawnAgent",
        agent_path: agentPath,
        receiver_thread_ids: [agentPath],
        agent_type: pending.input.agent_type,
        agent_nickname: nickname,
        description: readString(pending.input.message) ?? nickname ?? "Agent",
      };
      const event = makeAgentSpawnEvent(timestamp, toolId, input);
      state.agentSpawnEventByAgentPath.set(agentPath, event);
      return [event];
    }

    case "wait_agent": {
      const statusByAgent = readRecord(output.status) ?? {};
      return Object.entries(statusByAgent).flatMap(([agentPath, status]) => {
        const completedText = readString(readRecord(status)?.completed);
        return completedText
          ? emitAgentCompletion(state, timestamp, agentPath, completedText)
          : [];
      });
    }

    case "close_agent": {
      const agentPath =
        readString(pending.input.target) ??
        readString(output.agent_id) ??
        readString(output.agent_path);
      const completedText = readString(
        readRecord(output.previous_status)?.completed
      );
      return agentPath && completedText
        ? emitAgentCompletion(state, timestamp, agentPath, completedText)
        : [];
    }

    default:
      return [];
  }
}

/**
 * Map a Codex rollout `session_meta` line to a `session_start` event.
 *
 * Real rollout files (~/.codex/sessions/**\/*.jsonl) never carry a `model`
 * field on `session_meta` -- that only appears on the separate `turn_context`
 * line, which is outside the `response_item` | `event_msg` | `session_meta`
 * set {@link isCodexRolloutRawMessage} accepts; widening that guard is out of
 * scope for this fix, so `turn_context` stays unhandled. We reuse the same
 * `"codex"` placeholder the `thread.started` (`exec --json`) case uses for
 * the same reason: no real model string is available at this point.
 *
 * `payload.id` is this rollout's OWN thread id (matches the file name's
 * UUID); `payload.session_id` is the PARENT thread id for sub-agent
 * rollouts, so it is not a usable substitute.
 */
function parseCodexRolloutSessionMeta(
  raw: CodexRolloutRawMessage,
  timestamp: string,
  state: CodexRolloutParseState
): ConversationEvent[] {
  const sessionId = readString(raw.payload?.id);
  if (!sessionId || state.emittedSessionStartIds.has(sessionId)) return [];
  state.emittedSessionStartIds.add(sessionId);
  return [{ kind: "session_start", timestamp, model: "codex", sessionId }];
}

/** Build {@link FileUpdateChange}s from a `patch_apply_end` `changes` map. */
function patchApplyChanges(
  changes: Record<string, CodexRolloutFileChange> | undefined
): FileUpdateChange[] {
  if (!changes) return [];
  return Object.entries(changes).map(([path, change]) => ({
    path,
    kind: change.type,
    // Only `update` changes carry a unified diff; `add`/`delete` changes
    // carry the full file `content` instead (verified against real
    // rollouts). We don't synthesize a diff from raw content --
    // FileEditBlock already renders a plain kind+path row with no
    // expandable body when `diff` is absent, which is the right degraded
    // display for those two kinds.
    diff: readString(change.unified_diff),
  }));
}

/** Parse Codex's rollout-only `apply_patch` custom tool input. */
function applyPatchInputChanges(input: unknown): FileUpdateChange[] {
  const text =
    typeof input === "string" ? input : (JSON.stringify(input) ?? "");
  const lines = text.split("\n");
  const changes: FileUpdateChange[] = [];
  let current: FileUpdateChange | null = null;
  const body: string[] = [];
  const finish = () => {
    if (!current) return;
    const diff = body.filter((line) => line.length > 0).join("\n");
    changes.push({ ...current, ...(diff ? { diff } : {}) });
    current = null;
    body.length = 0;
  };
  for (const line of lines) {
    const add = line.match(/^\*\*\* Add File: (.+)$/);
    const update = line.match(/^\*\*\* Update File: (.+)$/);
    const remove = line.match(/^\*\*\* Delete File: (.+)$/);
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (add || update || remove) {
      finish();
      current = {
        path: (add ?? update ?? remove)![1],
        kind: add ? "add" : remove ? "delete" : "update",
      };
      continue;
    }
    if (move && current) {
      current = { ...current, kind: "rename", diff: undefined };
      body.push(`*** Move to: ${move[1]}`);
      continue;
    }
    if (
      current &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith("@@"))
    ) {
      body.push(line);
    }
  }
  finish();
  return changes;
}

/**
 * Map a Codex rollout `event_msg` line to conversation events.
 *
 * Built from inspecting real rollout files under ~/.codex/sessions/ and
 * ~/.codex/archived_sessions/. Every subtype observed there is listed below;
 * anything else falls through to the `default` and is dropped with a debug
 * log, mirroring the unknown-`item.type` handling in `parseCodexMessage`.
 */
function parseCodexRolloutEventMsg(
  raw: CodexRolloutRawMessage,
  timestamp: string
): ConversationEvent[] {
  const payload = raw.payload;
  if (!payload || typeof payload.type !== "string") return [];

  switch (payload.type) {
    // Confirmed via real rollouts: byte-for-byte identical to the `message`
    // response_item (role user/assistant) emitted for the same turn in the
    // SAME rollout file. response_item is handled below and stays the
    // single source of truth -- skip here to avoid double emission.
    case "agent_message":
    case "user_message":
      return [];

    // `last_agent_message` duplicates the final `agent_message` above (and
    // transitively the response_item `message`); the remaining fields
    // (turn_id, timing) have no corresponding ConversationEvent.
    case "task_complete":
      return [];

    // Turn bookkeeping only (turn_id, model_context_window, collaboration
    // mode) -- no user-facing text to surface.
    case "task_started":
      return [];

    // High-volume per-request token/rate-limit telemetry (nested
    // input/output/cached/reasoning counters + rate-limit windows). Doesn't
    // fit ThinkingHeartbeatEvent's flat estimatedTokens/estimatedTokensDelta
    // shape (that shape is Claude-Code-specific), and inventing a new
    // ConversationEvent kind would require updating EventGlyph/EventRenderer's
    // switches over `event.kind` -- those live under components/, owned by a
    // concurrent change. Skip.
    case "token_count":
      return [];

    // Confirmed via real rollouts: same `call_id` as an existing
    // function_call/function_call_output response_item pair, which the
    // response_item branch below already turns into tool_call/tool_result.
    // Skip to avoid double emission.
    case "mcp_tool_call_end":
      return [];

    // Confirmed via real rollouts: same `call_id` as a response_item
    // `web_search_call`. Unlike `mcp_tool_call_end` though, the payload here
    // never carries a result/error field (only `query`/`action`) in any
    // sample observed, so there is nothing to pair with a `tool_result` --
    // emitting a bare `tool_call` would leave a permanently-pending entry in
    // the timeline. Skip until Codex emits the corresponding output content.
    case "web_search_end":
      return [];

    // Turn-level interruption; not represented anywhere else in the
    // rollout. Mirrors the existing Codex exec-json `turn.failed` ->
    // `thinking` "[error] ..." convention.
    case "turn_aborted": {
      const reason = readString(payload.reason) ?? "unknown reason";
      return [
        {
          kind: "thinking",
          timestamp,
          text: `[error] Turn aborted: ${reason}`,
        },
      ];
    }

    case "custom_tool_call": {
      if (readString(payload.name) !== "apply_patch") return [];
      const toolId = readString(payload.call_id) ?? readString(payload.id);
      if (!toolId) return [];
      const changes = applyPatchInputChanges(
        payload.input ?? payload.arguments
      );
      return changes.length > 0
        ? [{ kind: "file_edit", timestamp, toolId, status: "started", changes }]
        : [];
    }

    case "custom_tool_call_output": {
      const toolId = readString(payload.call_id) ?? readString(payload.id);
      if (!toolId) return [];
      const output = readRecord(payload.output);
      const status =
        payload.exit_code !== undefined && payload.exit_code !== 0
          ? "failed"
          : (readString(output?.status) ?? "completed");
      // The output carries the result, not the original patch. The stateful
      // dedupe in parseSessionLogs replaces the started row only when the
      // terminal event also has changes, so leave the input row visible when
      // Codex omits the patch body here.
      return [{ kind: "file_edit", timestamp, toolId, status, changes: [] }];
    }

    // Per-file patch application result. Confirmed via real rollouts that
    // this does NOT correspond to any response_item -- patches are applied
    // via a plain `exec_command` function_call whose call_id never matches
    // this event's call_id -- so this is the only source of structured
    // per-file diff data in a rollout-only stream and is worth surfacing.
    case "patch_apply_end": {
      const changes = patchApplyChanges(payload.changes);
      if (changes.length === 0) return [];
      return [
        {
          kind: "file_edit",
          timestamp,
          toolId: readString(payload.call_id) ?? "",
          status: payload.success === false ? "failed" : "completed",
          changes,
        },
      ];
    }

    // Rare control-flow/telemetry events with no textual content and no
    // existing ConversationEvent kind that fits without inventing a new one
    // (see the `token_count` note above for why that's out of scope here):
    // context_compacted, thread_rolled_back, entered_review_mode,
    // exited_review_mode. Falls through to `default`.
    default:
      if (typeof console !== "undefined") {
        console.debug(
          `[codex rollout] dropping unhandled event_msg.type=${payload.type}`
        );
      }
      return [];
  }
}

export function parseCodexRolloutMessage(
  raw: CodexRolloutRawMessage,
  timestamp: string,
  options: ParseSessionLogsOptions = {},
  state: CodexRolloutParseState = newCodexRolloutParseState()
): ConversationEvent[] {
  if (raw.type === "session_meta") {
    return parseCodexRolloutSessionMeta(raw, timestamp, state);
  }
  if (raw.type === "event_msg") {
    return parseCodexRolloutEventMsg(raw, timestamp);
  }

  const events: ConversationEvent[] = [];
  if (raw.type !== "response_item") return events;
  const payload = raw.payload;
  if (!payload || typeof payload !== "object") return events;

  switch (payload.type) {
    case "custom_tool_call": {
      if (readString(payload.name) !== "apply_patch") break;
      const toolId = readString(payload.call_id) ?? readString(payload.id);
      if (!toolId) break;
      const changes = applyPatchInputChanges(
        payload.input ?? payload.arguments
      );
      if (changes.length > 0) {
        events.push({
          kind: "file_edit",
          timestamp,
          toolId,
          status: "started",
          changes,
        });
      }
      break;
    }
    case "custom_tool_call_output": {
      const toolId = readString(payload.call_id) ?? readString(payload.id);
      if (!toolId) break;
      const output = readRecord(payload.output);
      const status =
        payload.exit_code !== undefined && payload.exit_code !== 0
          ? "failed"
          : (readString(output?.status) ?? "completed");
      events.push({
        kind: "file_edit",
        timestamp,
        toolId,
        status,
        changes: [],
      });
      break;
    }
    case "message": {
      const text = contentText(payload.content).trim();
      if (!text) break;
      if (payload.role === "user") {
        // Only user-role lines carry injected notifications; an assistant
        // message QUOTING the tag in prose must not be swallowed. Whatever
        // the body shape, the raw XML never renders as a user message.
        const notificationBodies = readSubagentNotificationBodies(text);
        if (notificationBodies.length > 0) {
          events.push(
            ...subagentNotificationEvents(state, timestamp, notificationBodies)
          );
          break;
        }
        if (options.includeUserMessages && shouldKeepUserMessage(text)) {
          events.push({ kind: "user_message", timestamp, text });
        }
      } else if (payload.role === "assistant") {
        events.push({ kind: "assistant_message", timestamp, text });
      }
      break;
    }
    case "function_call": {
      const multiAgentEvents = parseMultiAgentFunctionCall(
        raw,
        timestamp,
        state
      );
      if (multiAgentEvents) {
        events.push(...multiAgentEvents);
        break;
      }
      const toolId =
        readString(payload.call_id) ?? readString(payload.id) ?? "";
      if (!toolId) break;
      const toolName = readString(payload.name) ?? "tool";
      const input =
        typeof payload.arguments === "string"
          ? payload.arguments
          : payload.arguments && typeof payload.arguments === "object"
            ? (payload.arguments as Record<string, unknown>)
            : {};
      const inputObject =
        typeof input === "string" ? parseJsonObject(input) : input;
      // Rollout `exec_command` carries the shell line as `cmd`; present it as
      // the shared Bash shell card (the live harness and the exec-shape
      // parser already do), which keys on `input.command`.
      const isExec = toolName === "exec_command";
      const presentedName = isExec ? "Bash" : toolName;
      const presentedInput =
        isExec && typeof inputObject.cmd === "string"
          ? { ...inputObject, command: inputObject.cmd }
          : inputObject;
      events.push({
        kind: "tool_call",
        timestamp,
        toolId,
        toolName: presentedName,
        displayName: getToolDisplayName(presentedName),
        icon: getToolIcon(presentedName),
        summary: getToolSummary(presentedName, presentedInput),
        input: presentedInput,
      });
      break;
    }
    case "function_call_output": {
      const multiAgentEvents = parseMultiAgentFunctionCall(
        raw,
        timestamp,
        state
      );
      if (multiAgentEvents) {
        events.push(...multiAgentEvents);
        break;
      }
      const toolUseId =
        readString(payload.call_id) ?? readString(payload.id) ?? "";
      if (!toolUseId) break;
      events.push({
        kind: "tool_result",
        timestamp,
        toolUseId,
        isError: false,
        result: codexResultToString(payload.output),
      });
      break;
    }
    default:
      break;
  }

  return events;
}

/** Build a TodoListEvent from a Codex item, returning null if the shape is unusable. */
function makeTodoListEvent(
  item: CodexItem,
  timestamp: string
): TodoListEvent | null {
  const id = item.id;
  if (!id) return null;
  const items = Array.isArray(item.items) ? item.items : [];
  return {
    kind: "todo_list",
    timestamp,
    itemId: id,
    items,
  };
}

/**
 * Render a Codex MCP / web_search `result` payload (string | array | object)
 * into a flat string for the `tool_result` event. Mirrors how Claude
 * tool_result handles `string | unknown[]` content.
 */
function codexResultToString(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

/** Per-stream state shared across a single Codex JSONL run. */
export interface CodexParseState {
  turnCount: number;
  /**
   * Index in the merged `parseSessionLogs` events array where the latest
   * TodoListEvent for each Codex `item.id` lives. Subsequent
   * `item.started` / `item.updated` / `item.completed` events for the same
   * id replace that slot with a fresh event reference so the rendered
   * checklist reflects the latest items without growing the timeline (and
   * downstream React.memo / shallow-equals consumers see a changed identity
   * and re-render).
   *
   * Each Codex execution gets its own state instance (see `parseSessionLogs`)
   * so concurrent executions don't share plans even if `item.id`s collide.
   */
  todoListByItemId: Map<string, number>;
  fileEditByItemId: Map<string, number>;
}

interface ClaudeParseState {
  latestSnapshotByKey: Map<string, number>;
  fileChangesByToolId: Map<string, FileUpdateChange[]>;
  fileEditByToolId: Map<string, number>;
}

interface HarnessParseState {
  /** Streaming deltas supersede the equivalent completed snapshot. */
  deltaPayloads: Set<string>;
  /** Avoid duplicating a terminal result after provider text was already shown. */
  turnsWithText: Set<string>;
  /** Snapshot plans replace their prior version instead of growing the trace. */
  todoListByItemId: Map<string, number>;
  fileEditByToolId: Map<string, number>;
}

function claudeSnapshotKey(
  ev: ConversationEvent,
  executionId: string
): string | null {
  switch (ev.kind) {
    case "thinking_heartbeat":
      return `thinking:${ev.sessionId || executionId}`;
    case "task_progress":
      return `task_progress:${ev.toolUseId}`;
    case "rate_limit":
      return `rate_limit:${ev.sessionId || executionId}`;
    default:
      return null;
  }
}

/**
 * Parse an array of SessionLog entries into conversation events.
 *
 * Each log is parsed as JSON and routed to either the Claude (stream-json) or
 * Codex (`exec --json`) parser based on the `type` namespace. Per-execution
 * Codex turn counts are threaded across logs of the same execution so a
 * top-level `error` event can emit a `session_end` with the right `numTurns`.
 * Entries that fail to parse as JSON are skipped.
 */
export function parseSessionLogs(
  logs: SessionLog[],
  options: ParseSessionLogsOptions = {}
): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  // One Codex state per (step_execution_id) so concurrent executions don't
  // share turn counts. Anthropic logs ignore this map.
  const codexStateByExecution = new Map<string, CodexParseState>();
  const codexRolloutStateByExecution = new Map<
    string,
    CodexRolloutParseState
  >();
  const claudeStateByExecution = new Map<string, ClaudeParseState>();
  const harnessStateByExecution = new Map<string, HarnessParseState>();

  for (const log of logs) {
    let raw: unknown;
    try {
      raw = JSON.parse(log.content ?? "");
    } catch {
      continue;
    }

    const ts = log.created_at ?? "";
    if (log.format === "harness" && isHarnessRawEvent(raw)) {
      const execId = log.step_execution_id ?? "";
      let state = harnessStateByExecution.get(execId);
      if (!state) {
        state = {
          deltaPayloads: new Set(),
          turnsWithText: new Set(),
          todoListByItemId: new Map(),
          fileEditByToolId: new Map(),
        };
        harnessStateByExecution.set(execId, state);
      }
      for (const ev of parseHarnessEvent(raw, ts, state)) {
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
    } else if (isCodexRawMessage(raw)) {
      const execId = log.step_execution_id ?? "";
      let state = codexStateByExecution.get(execId);
      if (!state) {
        state = {
          turnCount: 0,
          todoListByItemId: new Map(),
          fileEditByItemId: new Map(),
        };
        codexStateByExecution.set(execId, state);
      }
      for (const ev of parseCodexMessage(raw, ts, state)) {
        if (ev.kind === "todo_list") {
          const priorIndex = state.todoListByItemId.get(ev.itemId);
          if (priorIndex !== undefined) {
            events[priorIndex] = ev;
            continue;
          }
          state.todoListByItemId.set(ev.itemId, events.length);
        }
        if (ev.kind === "file_edit" && ev.toolId) {
          const priorIndex = state.fileEditByItemId.get(ev.toolId);
          if (priorIndex !== undefined) {
            const previous = events[priorIndex];
            events[priorIndex] =
              previous?.kind === "file_edit" && ev.changes.length === 0
                ? { ...ev, changes: previous.changes }
                : ev;
            continue;
          }
          state.fileEditByItemId.set(ev.toolId, events.length);
        }
        events.push(ev);
      }
    } else if (isCodexRolloutRawMessage(raw)) {
      const execId = log.step_execution_id ?? "";
      let state = codexRolloutStateByExecution.get(execId);
      if (!state) {
        state = newCodexRolloutParseState();
        codexRolloutStateByExecution.set(execId, state);
      }
      for (const ev of parseCodexRolloutMessage(raw, ts, options, state)) {
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
    } else {
      const execId = log.step_execution_id ?? "";
      let state = claudeStateByExecution.get(execId);
      if (!state) {
        state = {
          latestSnapshotByKey: new Map(),
          fileChangesByToolId: new Map(),
          fileEditByToolId: new Map(),
        };
        claudeStateByExecution.set(execId, state);
      }
      for (const ev of parseClaudeMessage(
        raw as ClaudeRawMessage,
        ts,
        options,
        state
      )) {
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
        const key = claudeSnapshotKey(ev, execId);
        if (key) {
          const priorIndex = state.latestSnapshotByKey.get(key);
          if (priorIndex !== undefined) {
            events[priorIndex] = ev;
            continue;
          }
          state.latestSnapshotByKey.set(key, events.length);
        }
        events.push(ev);
      }
    }
  }

  return events;
}

// ============================================================================
// Cross-execution merging (UnifiedChatView)
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

/** Minimal execution shape needed by `mergeExecutionEvents`. */
export interface ExecutionLike {
  id: string | null;
  task_id?: string;
  workflow_id?: string;
  step_name?: string;
  started_at?: string;
}

/**
 * Merge session logs across many executions into one chronologically-ordered
 * stream of tagged events.
 *
 * Sort order:
 *   1. event.timestamp (ascending)
 *   2. execution.started_at (ascending) — break timestamp ties between
 *      events from different executions
 *   3. eventIndex (ascending) — preserve original ordering within a single
 *      execution when multiple events share a timestamp
 */
export function mergeExecutionEvents(
  executions: readonly ExecutionLike[],
  logsByExecutionId: Readonly<Record<string, SessionLog[]>>
): TaggedConversationEvent[] {
  const merged: TaggedConversationEvent[] = [];

  const tsMs: number[] = [];
  const startedMs: number[] = [];

  for (const exec of executions) {
    const execId = exec.id;
    if (!execId) continue;
    const logs = logsByExecutionId[execId] ?? [];
    const events = parseSessionLogs(logs);
    const execStartedMs = exec.started_at ? Date.parse(exec.started_at) : 0;
    const execStartedSafe = Number.isNaN(execStartedMs) ? 0 : execStartedMs;
    events.forEach((event, idx) => {
      const t = Date.parse(event.timestamp);
      merged.push({
        event,
        executionId: execId,
        taskId: exec.task_id ?? "",
        workflowId: exec.workflow_id ?? null,
        stepName: exec.step_name ?? null,
        executionStartedAt: exec.started_at ?? null,
        eventIndex: idx,
      });
      tsMs.push(Number.isNaN(t) ? 0 : t);
      startedMs.push(execStartedSafe);
    });
  }

  const indices = merged.map((_, i) => i);
  indices.sort((a, b) => {
    if (tsMs[a] !== tsMs[b]) return tsMs[a] - tsMs[b];
    if (startedMs[a] !== startedMs[b]) return startedMs[a] - startedMs[b];
    return merged[a].eventIndex - merged[b].eventIndex;
  });

  return indices.map((i) => merged[i]);
}
