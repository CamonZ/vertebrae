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

/** Raw Claude message structure from --jsonl */
export interface ClaudeRawMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: "init" | "success" | "error" | "task_notification";
  message?: {
    id?: string;
    content?: ClaudeContentItem[];
    model?: string;
    role?: string;
  };
  // System init fields
  model?: string;
  session_id?: string;
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

/** Union of all conversation events */
export type ConversationEvent =
  | SessionStartEvent
  | SessionEndEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent;

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
      }
      break;

    case "assistant":
      if (raw.message?.content) {
        for (const item of raw.message.content) {
          if (item.type === "text" && item.text) {
            events.push({
              kind: "thinking",
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
      break;

    case "user":
      if (raw.message?.content) {
        for (const item of raw.message.content) {
          if (item.type === "tool_result") {
            const content = item.content;
            const resultText =
              typeof content === "string"
                ? content
                : JSON.stringify(content);
            events.push({
              kind: "tool_result",
              timestamp,
              toolUseId: item.tool_use_id,
              isError: item.is_error ?? false,
              result: truncate(resultText.replace(/\n/g, " "), 200),
            });
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
    | string;
  /** Present on `agent_message` and `reasoning` items. */
  text?: string;
  /** Present on `command_execution` items. */
  command?: string;
  exit_code?: number;
  /** Captured stdout/stderr for completed command_execution items. */
  aggregated_output?: string;
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
 * - `item.completed` w/ `agent_message`      -> `thinking` (final text)
 *
 * Note: there is no `thread.completed` event in the upstream schema --
 * successful streams just terminate after `turn.completed`. The session_end
 * event is synthesised at a higher layer (e.g. when the execution row reaches
 * a terminal status), not from a JSONL marker.
 *
 * The `state` arg lets `parseSessionLogs` thread a shared turn counter
 * across the contiguous run of Codex lines belonging to one execution.
 */
export function parseCodexMessage(
  raw: CodexRawMessage,
  timestamp: string,
  state: CodexParseState = { turnCount: 0 }
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

    case "item.completed": {
      const item = raw.item;
      if (!item) break;
      switch (item.type) {
        case "agent_message":
        case "reasoning": {
          const text = item.text;
          if (text && text.length > 0) {
            events.push({ kind: "thinking", timestamp, text });
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
            result: truncate(
              (item.aggregated_output ?? "").replace(/\n/g, " "),
              200
            ),
          });
          break;
        }
        default:
          // Unknown item types are intentionally dropped from the timeline;
          // the raw line is still preserved at the SessionLog layer.
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

    // item.started / item.updated / unknown types contribute nothing --
    // partial streaming chunks are consumed by item.completed.
    default:
      break;
  }

  return events;
}

/** Per-stream state shared across a single Codex JSONL run. */
export interface CodexParseState {
  turnCount: number;
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
        state = { turnCount: 0 };
        codexStateByExecution.set(execId, state);
      }
      events.push(...parseCodexMessage(raw, ts, state));
    } else {
      events.push(...parseClaudeMessage(raw as ClaudeRawMessage, ts));
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
