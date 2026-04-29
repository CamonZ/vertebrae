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

/**
 * Parse an array of SessionLog entries into conversation events.
 * Skips entries that fail to parse as JSON.
 */
export function parseSessionLogs(logs: SessionLog[]): ConversationEvent[] {
  const events: ConversationEvent[] = [];

  for (const log of logs) {
    try {
      const raw = JSON.parse(log.content ?? '') as ClaudeRawMessage;
      const parsed = parseClaudeMessage(raw, log.created_at ?? '');
      events.push(...parsed);
    } catch {
      // Skip non-JSON or malformed entries
      continue;
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
