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
  content?: ClaudeContentItem[];
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
 * plus the patch application status. Sourced from Codex `file_change`
 * `item.completed` events; Claude's per-file edits still go through the
 * generic `Edit`/`Write` `tool_call` path.
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
): ClaudeContentItem[] | undefined {
  return typeof message === "object" && message !== null && "content" in message
    ? message.content
    : undefined;
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

/**
 * Parse a single Claude JSON message into conversation events.
 * Returns an array because one message can contain multiple content items.
 */
export function parseClaudeMessage(
  raw: ClaudeRawMessage,
  timestamp: string
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
        if (content) {
          for (const item of content) {
            if (item.type === "text" && item.text) {
              events.push({
                kind: "assistant_message",
                timestamp,
                text: item.text,
              });
            } else if (item.type === "tool_use") {
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
        if (content) {
          for (const item of content) {
            if (item.type === "tool_result") {
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
      events.push(rateLimitEvent(raw, timestamp));
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
  state: CodexParseState = { turnCount: 0, todoListByItemId: new Map() }
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
      // Only `todo_list` items use the started/updated channel for
      // user-visible state -- agent_message text streams in via these too
      // but the final text is what we render, on item.completed. Per the
      // upstream Codex schema, plan refinements arrive as `item.updated`.
      const item = raw.item;
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
        case "file_change": {
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
}

interface ClaudeParseState {
  latestSnapshotByKey: Map<string, number>;
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
export function parseSessionLogs(logs: SessionLog[]): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  // One Codex state per (step_execution_id) so concurrent executions don't
  // share turn counts. Anthropic logs ignore this map.
  const codexStateByExecution = new Map<string, CodexParseState>();
  const claudeStateByExecution = new Map<string, ClaudeParseState>();

  for (const log of logs) {
    let raw: unknown;
    try {
      raw = JSON.parse(log.content ?? "");
    } catch {
      continue;
    }

    const ts = log.created_at ?? "";
    if (isCodexRawMessage(raw)) {
      const execId = log.step_execution_id ?? "";
      let state = codexStateByExecution.get(execId);
      if (!state) {
        state = { turnCount: 0, todoListByItemId: new Map() };
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
        events.push(ev);
      }
    } else {
      const execId = log.step_execution_id ?? "";
      let state = claudeStateByExecution.get(execId);
      if (!state) {
        state = { latestSnapshotByKey: new Map() };
        claudeStateByExecution.set(execId, state);
      }
      for (const ev of parseClaudeMessage(raw as ClaudeRawMessage, ts)) {
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
