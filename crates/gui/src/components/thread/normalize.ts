/**
 * Normalizers (P2) — turn backend data into the canonical Thread tree.
 *
 * Two pure adapters, both producing the SAME `Thread`/`Turn`/`Message` shapes
 * from `./types` that `<Thread>`/`<EventRow>` render:
 *
 *   · runToThreads(...)  — the TRACES variant. One Run's `StepExecution[]` →
 *                          root threads (depth 0), each with a step head.
 *                          mode="timed" reveal="deep".
 *   · msgsToThread(...)  — the CHAT variant. A flat chat message list → one
 *                          ongoing thread (no head). mode="bare" reveal="shallow".
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HARD CONSTRAINTS honoured here (see types.ts header):
 *   1. SINGLE TASK RUN. `runToThreads` takes exactly one task_run's executions;
 *      there is NO recursive task-run fetch and NO DelegationBlock machinery.
 *   2. The only nesting axis is intra-run subagents via `parent_tool_use_id`
 *      → a `SpawnMessage` carrying a child Thread.
 *   3. `wait_for_children` is a STEP (a root thread whose body is one terminal
 *      `WaitMessage`), never an inlined subtree.
 *   5. Both anthropic (claude) and openai (codex) shapes are supported — the
 *      existing parser (`parseSessionLogs`) already normalises both into the
 *      same `ConversationEvent` union, so this layer is provider-agnostic.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * *** BLOCKER carried over from P0 — subagent linkage is NOT parsed yet. ***
 *
 *   `conversation.ts` does NOT expose `parent_tool_use_id` (Anthropic) nor a
 *   parsed `collab_tool_call` (Codex) on any `ConversationEvent`. There is
 *   therefore NO data source today for the spawn/nested-Thread axis
 *   (constraint #2). Until the parser threads that linkage through:
 *     (a) ClaudeContentItem + parseClaudeMessage must carry parent_tool_use_id
 *         onto each tool_call/assistant event;
 *     (b) ToolCallEvent / AssistantMessageEvent / ThinkingEvent must gain a
 *         `parentToolUseId?: string` field;
 *     (c) parseCodexMessage must handle collab_tool_call into a spawn shape.
 *
 *   This module is written to USE that linkage when present and to degrade to a
 *   correct FLAT single-level thread when absent (no crash). The linkage is
 *   read defensively via {@link readParentToolUseId}; spawn-grouping in
 *   `runToThreads` activates automatically once the field exists. See
 *   {@link groupBySpawn} and its TODO.
 * ──────────────────────────────────────────────────────────────────────────
 */

import type { SessionLog, StepExecution, StepType, TaskRun } from "../../bindings";
import {
  parseSessionLogs,
  type ConversationEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type FileEditEvent,
  type TodoListEvent,
} from "../../types/conversation";
import type {
  AgentMessage,
  ErrorMessage,
  Message,
  Run,
  StepKind,
  Thread,
  ThreadStep,
  ThreadSummary,
  ToolMessage,
  Turn,
  UserMessage,
  WaitMessage,
} from "./types";

// ===========================================================================
// Inputs.
// ===========================================================================

/** Input bundle for {@link runToThreads} — exactly one task_run. */
export interface RunInput {
  /** The single task_run this Run represents. */
  taskRun: TaskRun;
  /** Its step executions (any order; sorted here by started_at). */
  stepExecutions: StepExecution[];
  /** Session logs keyed by `step_execution_id`. */
  logsByExecutionId: Record<string, SessionLog[]>;
}

/** Optional chat-message shape consumed by {@link msgsToThread}. */
export interface ChatMsg {
  id: string | number;
  role: "user" | "assistant" | string;
  text?: string;
  speaker?: string;
  model?: string;
  streaming?: boolean;
  /** Pre-shaped tool rows (chat owns its own tool toggling). */
  tools?: ToolMessage[];
  /** Rendered prose (markdown string in production). */
  prose?: string;
}

// ===========================================================================
// Step-kind mapping.
// ===========================================================================

/**
 * Map a Sacrum {@link StepType} to a {@link StepKind}.
 *   execute → "execute", evaluate → "eval", route → "route",
 *   human_input → "human", wait_children → "wait".
 * Unknown / `{ unsupported }` types fall back to "execute".
 *
 * `StepExecution.step_type` arrives as a nullable string (not the union), so
 * this accepts a loose string and is also reused for the typed `StepType`.
 */
export function stepKindFromStepType(
  stepType: StepType | string | null | undefined
): StepKind {
  switch (stepType) {
    case "execute":
      return "execute";
    case "evaluate":
      return "eval";
    case "route":
      return "route";
    case "human_input":
      return "human";
    case "wait_children":
      return "wait";
    default:
      return "execute";
  }
}

/** A wait step is the only one rendered as a terminal WaitMessage (constraint #3). */
function isWaitStep(stepType: string | null | undefined): boolean {
  return stepType === "wait_children";
}

// ===========================================================================
// Small format helpers.
// ===========================================================================

/** "verify_changes" → "verify_changes" kept verbatim; humanize only spacing. */
function humanize(stepName: string | undefined): string {
  return (stepName ?? "").trim() || "step";
}

/** Parse an ISO timestamp to epoch ms, or null when unparseable. */
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "01:22:40" wall-clock fragment from an ISO timestamp (UTC HH:MM:SS). */
function clock(iso: string | null | undefined): string | undefined {
  const t = ms(iso);
  if (t == null) return undefined;
  return new Date(t).toISOString().slice(11, 19);
}

/** "+8m 58s" / "+142ms" relative offset between two epoch-ms values. */
function rel(fromMs: number | null, atMs: number | null): string | undefined {
  if (fromMs == null || atMs == null) return undefined;
  return "+" + humanDuration(atMs - fromMs);
}

/** Human duration: "142ms" | "9.0s" | "8m 58s" | "7h 36m". */
export function humanDuration(deltaMs: number): string {
  const d = Math.max(0, Math.round(deltaMs));
  if (d < 1000) return `${d}ms`;
  const s = d / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalSec = Math.round(s);
  const m = Math.floor(totalSec / 60);
  if (m < 60) return `${m}m ${totalSec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ===========================================================================
// Subagent linkage (BLOCKER) — read defensively.
// ===========================================================================

/**
 * Best-effort read of a parent tool-use id off a parsed event.
 *
 * The current `ConversationEvent` union has NO such field (see the module
 * header blocker). We read it via an index access so spawn grouping lights up
 * automatically the day the parser threads `parent_tool_use_id` /
 * `collab_tool_call` through — without a type change here.
 *
 * TODO(spawn-linkage): once the parser exposes `parentToolUseId` on
 * ToolCallEvent / AssistantMessageEvent / ThinkingEvent, replace this with a
 * typed field read and delete the cast.
 */
function readParentToolUseId(ev: ConversationEvent): string | undefined {
  const v = (ev as unknown as { parentToolUseId?: unknown }).parentToolUseId;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** A tool id this event participates in (for spawn keying), when derivable. */
function eventToolId(ev: ConversationEvent): string | undefined {
  if (ev.kind === "tool_call") return ev.toolId;
  if (ev.kind === "tool_result") return ev.toolUseId;
  if (ev.kind === "file_edit") return ev.toolId;
  return undefined;
}

// ===========================================================================
// Event → Message mapping.
// ===========================================================================

/** Detect the Codex `[error] …` thinking encoding (constraint #5 / contract). */
const ERROR_PREFIX = "[error] ";

let EVT_SEQ = 0;
/** Stable-enough evt id within a single normalize pass. */
function nextEvt(prefix: string): string {
  EVT_SEQ += 1;
  return `${prefix}-${EVT_SEQ}`;
}

/** Build a ToolMessage from a tool_call, merging its matching tool_result. */
function toolMessage(
  call: ToolCallEvent,
  result: ToolResultEvent | undefined,
  runStartMs: number | null
): ToolMessage {
  const isShell = call.toolName === "Bash";
  const status: ToolMessage["status"] = result
    ? result.isError
      ? "err"
      : "done"
    : "pending";
  const atMs = ms(call.timestamp);
  const m: ToolMessage = {
    evt: call.toolId || nextEvt("tool"),
    type: "tool",
    at: clock(call.timestamp),
    rel: rel(runStartMs, atMs),
    status,
    error: result?.isError || undefined,
    collapsed: true,
  };
  if (isShell) {
    m.kind = "shell";
    m.cmd = String(call.input.command ?? call.displayName);
  } else {
    m.kind = "fn";
    m.name = call.displayName;
    m.em = call.summary || undefined;
  }
  // A result body upgrades the row to a bordered, collapsible card.
  if (result && result.result) m.body = result.result;
  return m;
}

/** Build a ToolMessage from a Codex file_edit (apply_patch style). */
function fileEditMessage(
  ev: FileEditEvent,
  runStartMs: number | null
): ToolMessage {
  const atMs = ms(ev.timestamp);
  const paths = ev.changes.map((c) => c.path).join(", ");
  const diffs = ev.changes
    .map((c) => c.diff)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .join("\n");
  return {
    evt: ev.toolId || nextEvt("edit"),
    type: "tool",
    kind: "shell",
    cmd: "apply_patch",
    em: paths || undefined,
    at: clock(ev.timestamp),
    rel: rel(runStartMs, atMs),
    status: ev.status === "failed" ? "err" : "done",
    error: ev.status === "failed" || undefined,
    body: diffs || undefined,
    collapsed: true,
  };
}

/**
 * Build a ToolMessage representing a Codex todo_list.
 *
 * The Message union has no `todo` kind (open question in the contract); we
 * render it via a ToolMessage with a checklist body — the smallest change that
 * keeps the union closed. The body is a "[x]/[ ]" rendering of the items.
 */
function todoMessage(ev: TodoListEvent, runStartMs: number | null): ToolMessage {
  const atMs = ms(ev.timestamp);
  const done = ev.items.filter((i) => i.completed).length;
  const body = ev.items
    .map((i) => `${i.completed ? "[x]" : "[ ]"} ${i.text}`)
    .join("\n");
  return {
    evt: ev.itemId || nextEvt("todo"),
    type: "tool",
    kind: "fn",
    name: "todo_list",
    summary: `${done}/${ev.items.length}`,
    at: clock(ev.timestamp),
    rel: rel(runStartMs, atMs),
    status: "done",
    body: body || undefined,
    collapsed: true,
  };
}

/** Build an AgentMessage prose row from assistant_message / thinking text. */
function agentMessage(
  text: string,
  timestamp: string,
  runStartMs: number | null,
  speaker: string | undefined,
  model: string | undefined,
  reasoning: boolean
): AgentMessage {
  const atMs = ms(timestamp);
  return {
    evt: nextEvt("agent"),
    type: "agent",
    at: clock(timestamp),
    rel: rel(runStartMs, atMs),
    speaker: reasoning ? (speaker ? `${speaker} · reasoning` : "reasoning") : speaker,
    model,
    prose: text,
  };
}

/** Build an ErrorMessage from a Codex `[error] …` thinking event. */
function errorMessage(
  text: string,
  timestamp: string,
  runStartMs: number | null
): ErrorMessage {
  const atMs = ms(timestamp);
  return {
    evt: nextEvt("error"),
    type: "error",
    at: clock(timestamp),
    rel: rel(runStartMs, atMs),
    title: text.slice(ERROR_PREFIX.length) || "error",
  };
}

// ===========================================================================
// runToThreads — the TRACES variant.
// ===========================================================================

/**
 * Convenience wrapper: produce a {@link Run} (single task_run) from a
 * {@link RunInput}.
 */
export function runToRun(input: RunInput): Run {
  return { id: input.taskRun.id, threads: runToThreads(input) };
}

/**
 * Produce ONE Run's root threads (depth 0) — one Thread per StepExecution,
 * ordered by `started_at`. See module header for the full contract.
 */
export function runToThreads(input: RunInput): Thread[] {
  const { taskRun, stepExecutions, logsByExecutionId } = input;

  const runStartMs =
    ms(taskRun.started_at) ??
    // fall back to the earliest execution start if the run has no start
    stepExecutions
      .map((e) => ms(e.started_at))
      .filter((t): t is number => t != null)
      .sort((a, b) => a - b)[0] ??
    null;

  const ordered = [...stepExecutions].sort((a, b) => {
    const ta = ms(a.started_at) ?? 0;
    const tb = ms(b.started_at) ?? 0;
    return ta - tb;
  });

  return ordered.map((exec) => stepExecutionToThread(exec, logsByExecutionId, runStartMs));
}

/** One StepExecution → one root Thread (its step head + turns). */
function stepExecutionToThread(
  exec: StepExecution,
  logsByExecutionId: Record<string, SessionLog[]>,
  runStartMs: number | null
): Thread {
  const execId = exec.id ?? "";
  const startMs = ms(exec.started_at);
  const stepKind = stepKindFromStepType(exec.step_type);

  const step: ThreadStep = {
    to: humanize(exec.step_name),
    kind: stepKind,
    at: clock(exec.started_at),
    rel: rel(runStartMs, startMs),
    runtime:
      typeof exec.duration_ms === "number"
        ? humanDuration(exec.duration_ms)
        : undefined,
  };

  let turns: Turn[];

  if (isWaitStep(exec.step_type)) {
    // constraint #3 — a wait step is a single terminal WaitMessage. childRunIds
    // stay empty until the backend exposes the blocked-on child run ids.
    const wait: WaitMessage = {
      evt: `${execId}-wait`,
      type: "wait",
      at: clock(exec.started_at),
      rel: rel(runStartMs, startMs),
      id: execId || undefined,
      text: exec.output ?? "Waiting on child tasks",
      childRunIds: [],
    };
    turns = [{ id: `${execId}-t0`, messages: [wait] }];
  } else {
    const logs = logsByExecutionId[execId] ?? [];
    const events = parseSessionLogs(logs);
    turns = eventsToTurns(events, exec, runStartMs);
  }

  const toolCount = turns.reduce(
    (n, t) => n + t.messages.filter((m) => m.type === "tool").length,
    0
  );
  const summary: ThreadSummary = {
    turns: turns.length,
    tools: toolCount,
    status: statusFor(exec, turns),
    dur:
      typeof exec.duration_ms === "number"
        ? humanDuration(exec.duration_ms)
        : undefined,
  };

  return {
    id: execId || nextEvt("thread"),
    label: humanize(exec.step_name),
    step,
    kind: stepKind,
    summary,
    turns,
  };
}

/** Roll-up status for a step's summary mark. */
function statusFor(exec: StepExecution, turns: Turn[]): ThreadSummary["status"] {
  if (exec.status === "in_progress") return "running";
  if (exec.status === "failed") return "err";
  const hasErr = turns.some((t) =>
    t.messages.some(
      (m) =>
        m.type === "error" ||
        (m.type === "tool" && (m.error || m.status === "err"))
    )
  );
  return hasErr ? "err" : "ok";
}

/**
 * Group a flat `ConversationEvent[]` (one execution's logs) into Turns.
 *
 * Turn boundaries:
 *   · A `user`/human input opens a new turn (chat-style). In traces, the steps
 *     are usually interpolated and carry no human turn — so when no human input
 *     exists, the step's `prompt` becomes a SINGLE leading SystemMessage that
 *     opens the (single) turn.
 *   · Within a turn, agent prose + standalone tool rows accumulate in order.
 *
 * Tool pairing: each `tool_call` is merged with its matching `tool_result`
 * (by toolId/toolUseId) into one ToolMessage.
 *
 * Layout (open question, resolved here): in TIMED trace mode tools are emitted
 * as STANDALONE chronological ToolMessages in the turn series (matching the
 * prototype's RUN1_THREADS), NOT nested under AgentMessage.tools. The chat
 * variant nests tools (see {@link msgsToThread}).
 */
function eventsToTurns(
  events: ConversationEvent[],
  exec: StepExecution,
  runStartMs: number | null
): Turn[] {
  // Pre-index tool_results by id for O(1) pairing.
  const resultById = new Map<string, ToolResultEvent>();
  for (const ev of events) {
    if (ev.kind === "tool_result") resultById.set(ev.toolUseId, ev);
  }

  // Resolve the per-execution speaker/model from the (first) session_start.
  let speaker: string | undefined;
  let model: string | undefined = exec.model ?? undefined;
  for (const ev of events) {
    if (ev.kind === "session_start") {
      model = model ?? ev.model;
      speaker = ev.model ? `Agent · ${ev.model}` : "Agent";
      break;
    }
  }

  const messages: Message[] = [];

  // Trace step executions are interpolated and carry NO human turn (the
  // `user` role only originates from chat). So lead the single turn with the
  // step's interpolated prompt as a SystemMessage. reveal="shallow" (chat)
  // drops these; reveal="deep" (traces) shows them.
  if (exec.prompt && exec.prompt.trim()) {
    const sys: Message = {
      evt: `${exec.id ?? "exec"}-prompt`,
      type: "system",
      at: clock(exec.started_at),
      rel: rel(runStartMs, ms(exec.started_at)),
      label: "System · interpolated",
      text: exec.prompt,
    };
    messages.push(sys);
  }

  for (const ev of events) {
    switch (ev.kind) {
      case "session_start":
      case "session_end":
        // No row — folded into step head / summary.
        break;
      case "thinking": {
        if (ev.text.startsWith(ERROR_PREFIX)) {
          messages.push(errorMessage(ev.text, ev.timestamp, runStartMs));
        } else {
          messages.push(
            agentMessage(ev.text, ev.timestamp, runStartMs, speaker, model, true)
          );
        }
        break;
      }
      case "assistant_message":
        messages.push(
          agentMessage(ev.text, ev.timestamp, runStartMs, speaker, model, false)
        );
        break;
      case "tool_call":
        messages.push(toolMessage(ev, resultById.get(ev.toolId), runStartMs));
        break;
      case "tool_result":
        // Merged into its tool_call — not its own row.
        break;
      case "file_edit":
        messages.push(fileEditMessage(ev, runStartMs));
        break;
      case "todo_list":
        messages.push(todoMessage(ev, runStartMs));
        break;
    }
  }

  const nested = groupBySpawn(messages, events);
  return [{ id: `${exec.id ?? "exec"}-t0`, messages: nested }];
}

/**
 * Lift subagent events into nested `SpawnMessage` child threads.
 *
 * *** BLOCKER (see module header). *** `parent_tool_use_id` is not exposed by
 * the parser today, so {@link readParentToolUseId} returns undefined for every
 * event and this function is a NO-OP pass-through producing a correct FLAT
 * thread. The grouping logic is intentionally left minimal here: the real
 * lift-into-child-thread implementation cannot be written or tested without a
 * data source. Once the linkage lands, expand this to:
 *   1. partition events by parentToolUseId,
 *   2. build a child Thread per parent tool id (kind "execute", spawnLabel
 *      "subagent"),
 *   3. replace the parent tool_call's ToolMessage with a SpawnMessage at the
 *      same position.
 *
 * TODO(spawn-linkage): implement the lift once the parser threads
 * parent_tool_use_id / collab_tool_call onto ConversationEvent.
 */
function groupBySpawn(messages: Message[], events: ConversationEvent[]): Message[] {
  const anyLinked = events.some(
    (ev) => readParentToolUseId(ev) !== undefined && eventToolId(ev) !== undefined
  );
  if (!anyLinked) return messages; // flat — no linkage available.
  // Linkage present: future work. For now, still return flat to avoid a
  // partially-correct nesting; flip this once the lift is implemented + tested.
  return messages;
}

// ===========================================================================
// msgsToThread — the CHAT variant.
// ===========================================================================

/**
 * Mirror the prototype's `msgsToThread`: walk a flat chat-message list, opening
 * a new Turn at each user message and attaching agent messages (with their
 * nested tools) to the open turn. Returns ONE `{ id:'chat-thread', turns }`
 * Thread, rendered depth=0 mode="bare" reveal="shallow" showHead={false}.
 *
 * Unlike the trace variant, tools are NESTED under the AgentMessage (the chat
 * layout) and the optional `onToggleTool(msgId, toolIndex)` wires each tool's
 * collapse toggle.
 */
export function msgsToThread(
  msgs: ChatMsg[],
  onToggleTool?: (msgId: string | number, toolIndex: number) => void
): Thread {
  const turns: Turn[] = [];
  let cur: Turn | null = null;

  for (const m of msgs) {
    const idStr = String(m.id);
    if (m.role === "user") {
      cur = { id: "t" + idStr, messages: [] };
      turns.push(cur);
      const um: UserMessage = {
        evt: idStr,
        type: "user",
        role: "human",
        text: m.text,
      };
      cur.messages.push(um);
    } else {
      if (!cur) {
        cur = { id: "t" + idStr, messages: [] };
        turns.push(cur);
      }
      const tools = (m.tools ?? []).map((t, ti) => ({
        ...t,
        onToggle: onToggleTool ? () => onToggleTool(m.id, ti) : t.onToggle,
      }));
      const am: AgentMessage = {
        evt: idStr,
        type: "agent",
        speaker: m.speaker ?? "sacrum",
        model: m.model,
        streaming: m.streaming,
        tools,
        prose: m.prose,
      };
      cur.messages.push(am);
    }
  }

  return { id: "chat-thread", turns };
}
