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
 *   5. Both providers emit the same normalized `harness` SessionLog shape —
 *      `parseSessionLogs` projects it into the provider-agnostic
 *      `ConversationEvent` union.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Subagent linkage (constraint #2). The parser now threads the spawn linkage
 * onto every `ConversationEvent` as `parentToolUseId`:
 *     · Both providers carry the parent tool-call identity in the normalized
 *       harness event correlation, and `parseSessionLogs` tags the projected
 *       events with it.
 *
 * {@link groupBySpawn} reads `parentToolUseId` via {@link readParentToolUseId}
 * and lifts tagged events into a nested child {@link Thread}, replacing the
 * parent spawn tool's row with a `SpawnMessage` in place. When no event carries
 * a parent id it degrades to a correct FLAT single-level thread (no crash) —
 * identical to the pre-linkage behavior.
 * ──────────────────────────────────────────────────────────────────────────
 */

import type {
  SessionLog,
  StepExecution,
  StepType,
  TaskRun,
} from "../../bindings";
import {
  parseSessionLogs,
  type ConversationEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type FileEditEvent,
  type TodoListEvent,
} from "../../types/conversation";
import type {
  ActivityMessage,
  AgentMessage,
  ErrorMessage,
  Message,
  ResultMessage,
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
// Subagent linkage — the only intra-run nesting axis (constraint #2).
// ===========================================================================

/**
 * Read the parent spawn tool-use id off a parsed event. Set by the parser on
 * every event a spawned subagent emitted from normalized harness correlation;
 * undefined on the main agent's own events. {@link groupBySpawn} uses it to
 * lift the event into a nested child Thread.
 */
function readParentToolUseId(ev: ConversationEvent): string | undefined {
  const v = ev.parentToolUseId;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// ===========================================================================
// Event → Message mapping.
// ===========================================================================

/** Detect the normalized `[error] …` thinking encoding. */
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
    // Collapsed by default; ToolRow self-toggles on click (read-only Traces).
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
  const agentPrompt = isAgentSpawnCall(call) ? agentSpawnPromptBody(call) : "";
  if (
    result &&
    result.result &&
    !(agentPrompt && isStatusOnlyAgentSpawnResult(result.result))
  ) {
    m.body = result.result;
  }
  if (!m.body && status !== "pending" && agentPrompt) m.body = agentPrompt;
  return m;
}

function isAgentSpawnCall(call: ToolCallEvent): boolean {
  const collabTool = inputStringField(call.input, [
    "collab_tool",
    "collabTool",
  ]);
  if (collabTool === "spawnAgent") return true;
  const displayName = `${call.toolName} ${call.displayName}`.toLowerCase();
  if (!displayName.includes("agent")) return false;
  return (
    agentIdentityKeys(call.input).length > 0 ||
    Boolean(agentSpawnPromptBody(call))
  );
}

function agentSpawnPromptBody(call: ToolCallEvent): string {
  return inputStringField(call.input, ["description", "prompt", "message"]);
}

function isStatusOnlyAgentSpawnResult(result: string): boolean {
  return /^(completed|complete|done|finished|running|pending|active|idle)$/i.test(
    result.trim()
  );
}

/** Build a ToolMessage from either harness's normalized file_edit event. */
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
  const status = fileEditMessageStatus(ev.status);
  return {
    evt: ev.toolId || nextEvt("edit"),
    type: "tool",
    kind: "shell",
    cmd: "apply_patch",
    em: paths || undefined,
    at: clock(ev.timestamp),
    rel: rel(runStartMs, atMs),
    status,
    error: status === "err" || undefined,
    body: diffs || undefined,
    collapsed: true,
  };
}

function fileEditMessageStatus(status: string): ToolMessage["status"] {
  switch (status.toLowerCase()) {
    case "started":
    case "running":
    case "inprogress":
    case "in_progress":
      return "pending";
    case "failed":
    case "declined":
    case "cancelled":
    case "canceled":
      return "err";
    default:
      return "done";
  }
}

/**
 * Build a ToolMessage representing a normalized todo_list.
 *
 * The Message union has no `todo` kind (open question in the contract); we
 * render it via a ToolMessage with a checklist body — the smallest change that
 * keeps the union closed. The body is a "[x]/[ ]" rendering of the items.
 */
function todoMessage(
  ev: TodoListEvent,
  runStartMs: number | null
): ToolMessage {
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

function formatRateLimitText(ev: ConversationEvent): string {
  if (ev.kind !== "rate_limit") return "";
  const type = ev.rateLimitType?.replace(/_/g, " ");
  const status = ev.status ?? "rate limit";
  const reset =
    ev.resetsAt === undefined
      ? null
      : new Date(ev.resetsAt * 1000).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });
  return [type, status, reset ? `resets ${reset}` : null]
    .filter(Boolean)
    .join(" · ");
}

function activityMessage(
  ev: ConversationEvent,
  runStartMs: number | null
): ActivityMessage | null {
  switch (ev.kind) {
    case "thinking_heartbeat":
      return {
        evt: `thinking-heartbeat-${ev.sessionId}`,
        type: "activity",
        variant: "heartbeat",
        at: clock(ev.timestamp),
        rel: rel(runStartMs, ms(ev.timestamp)),
        label: "Thinking",
        text: `${ev.estimatedTokens.toLocaleString()} tokens`,
      };
    case "task_progress":
      return {
        evt: `task-progress-${ev.toolUseId}`,
        type: "activity",
        variant: "progress",
        at: clock(ev.timestamp),
        rel: rel(runStartMs, ms(ev.timestamp)),
        label: ev.subagentType ?? "subagent",
        text: ev.description,
      };
    case "task_started":
      return {
        evt: ev.toolUseId
          ? `task-started-${ev.toolUseId}`
          : nextEvt("task-started"),
        type: "activity",
        variant: "progress",
        at: clock(ev.timestamp),
        rel: rel(runStartMs, ms(ev.timestamp)),
        label: ev.subagentType ?? "subagent",
        text: ev.description,
      };
    case "task_notification":
      return {
        evt: nextEvt("task-notification"),
        type: "activity",
        variant: "notification",
        at: clock(ev.timestamp),
        rel: rel(runStartMs, ms(ev.timestamp)),
        label: "Task",
        text: ev.message,
      };
    case "rate_limit":
      return {
        evt: ev.sessionId
          ? `rate-limit-${ev.sessionId}`
          : nextEvt("rate-limit"),
        type: "activity",
        variant: "banner",
        tone: "warn",
        at: clock(ev.timestamp),
        rel: rel(runStartMs, ms(ev.timestamp)),
        label: "Rate limit",
        text: formatRateLimitText(ev),
      };
    default:
      return null;
  }
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
    speaker: reasoning
      ? speaker
        ? `${speaker} · reasoning`
        : "reasoning"
      : speaker,
    model,
    prose: text,
  };
}

/** Build an ErrorMessage from a normalized `[error] …` thinking event. */
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

  return ordered.map((exec) =>
    stepExecutionToThread(exec, logsByExecutionId, runStartMs)
  );
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
    turns = appendStepResult(turns, exec, execId);
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

/** Recursively key-sorted JSON, so two serializations of the same value compare
 *  equal regardless of whitespace or key order. Returns null for non-JSON. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

function canonicalJson(s: string): string | null {
  const t = s.trim();
  if (t[0] !== "{" && t[0] !== "[") return null;
  try {
    return stableStringify(JSON.parse(t));
  } catch {
    return null;
  }
}

/**
 * Append a step execution's final structured output as a terminal ResultMessage
 * on the last turn (so it reads as the step's final result without opening a new
 * conversational turn). Prefers `output`; falls back to `handoff`. Rendered
 * pretty-printed by the EventRow when it parses as JSON / an Elixir map.
 */
function appendStepResult(
  turns: Turn[],
  exec: StepExecution,
  execId: string
): Turn[] {
  const output = (exec.output ?? "").trim();
  const handoff = (exec.handoff ?? "").trim();
  const body = output || handoff;
  if (!body) return turns;

  // The final output is usually ALSO present as the trailing agent message in
  // the stream (the agent's final text == exec.output). Drop that duplicate so
  // the output renders exactly once — as the dedicated card. Matches either an
  // exact string (markdown / plain text) OR the same JSON value serialized
  // differently (the model emits compact JSON; the backend stores it
  // normalized/pretty). Genuinely different output keeps both.
  const bodyCanon = canonicalJson(body);
  const isDuplicate = (m: Message): boolean => {
    if (m.type !== "agent") return false;
    const prose = (m as AgentMessage).prose;
    if (typeof prose !== "string") return false;
    if (prose.trim() === body) return true;
    return bodyCanon !== null && canonicalJson(prose) === bodyCanon;
  };
  const deduped = turns
    .map((t) => ({ ...t, messages: t.messages.filter((m) => !isDuplicate(m)) }))
    .filter((t) => t.messages.length > 0);

  const result: ResultMessage = {
    evt: `${execId}-output`,
    type: "result",
    label: output ? "output" : "handoff",
    body,
  };
  if (deduped.length === 0) {
    return [{ id: `${execId}-result`, messages: [result] }];
  }
  const last = deduped[deduped.length - 1];
  return [
    ...deduped.slice(0, -1),
    { ...last, messages: [...last.messages, result] },
  ];
}

/** Roll-up status for a step's summary mark. */
function statusFor(
  exec: StepExecution,
  turns: Turn[]
): ThreadSummary["status"] {
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
  // Pre-index tool_results by id for O(1) pairing across the WHOLE execution
  // (a subagent's tool_result pairs with the subagent's tool_call by id).
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
    // Keep the row quiet: a one-line summary in `text`, the full interpolated
    // prompt in the collapsible `body` (revealed via "show input"). Otherwise
    // the whole multi-KB prompt floods the stream.
    const fullPrompt = exec.prompt.trim();
    const firstLine =
      fullPrompt
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? fullPrompt;
    const summary =
      firstLine.length > 140
        ? firstLine.slice(0, 139).trimEnd() + "…"
        : firstLine;
    const sys: Message = {
      evt: `${exec.id ?? "exec"}-prompt`,
      type: "system",
      at: clock(exec.started_at),
      rel: rel(runStartMs, ms(exec.started_at)),
      label: "System",
      text: summary,
      body: fullPrompt,
    };
    messages.push(sys);
  }

  // Build the (possibly nested) message series. groupBySpawn lifts any
  // subagent events (those carrying parentToolUseId) into child Threads and
  // replaces the parent spawn tool's row with a SpawnMessage in place; when no
  // linkage is present it builds a flat series.
  messages.push(
    ...groupBySpawn(events, resultById, speaker, model, runStartMs)
  );

  return [{ id: `${exec.id ?? "exec"}-t0`, messages }];
}

/**
 * Build the flat message rows for a contiguous list of events that all belong
 * to the SAME agent (i.e. share the same parentToolUseId, or none). Subagent
 * grouping is handled by {@link groupBySpawn}, not here — this just maps each
 * renderable event to its Message.
 */
function eventsToMessages(
  events: ConversationEvent[],
  resultById: Map<string, ToolResultEvent>,
  speaker: string | undefined,
  model: string | undefined,
  runStartMs: number | null
): Message[] {
  const out: Message[] = [];
  const fileEditIds = new Set(
    events
      .filter(
        (event): event is FileEditEvent =>
          event.kind === "file_edit" && event.toolId.length > 0
      )
      .map((event) => event.toolId)
  );
  for (const ev of events) {
    switch (ev.kind) {
      case "user_message":
        out.push({
          evt: nextEvt("user"),
          type: "user",
          role: "human",
          label: "You",
          at: clock(ev.timestamp),
          rel: rel(runStartMs, ms(ev.timestamp)),
          text: ev.text,
        });
        break;
      case "session_start":
      case "session_end":
        // No row — folded into step head / summary.
        break;
      case "thinking": {
        if (ev.text.startsWith(ERROR_PREFIX)) {
          out.push(errorMessage(ev.text, ev.timestamp, runStartMs));
        } else {
          out.push(
            agentMessage(
              ev.text,
              ev.timestamp,
              runStartMs,
              speaker,
              model,
              true
            )
          );
        }
        break;
      }
      case "assistant_message":
        out.push(
          agentMessage(ev.text, ev.timestamp, runStartMs, speaker, model, false)
        );
        break;
      case "tool_call":
        if (fileEditIds.has(ev.toolId)) break;
        out.push(toolMessage(ev, resultById.get(ev.toolId), runStartMs));
        break;
      case "tool_result":
        // Merged into its tool_call — not its own row.
        break;
      case "file_edit":
        out.push(fileEditMessage(ev, runStartMs));
        break;
      case "todo_list":
        out.push(todoMessage(ev, runStartMs));
        break;
      case "thinking_heartbeat":
      case "task_progress":
      case "task_started":
      case "task_notification":
      case "rate_limit": {
        const msg = activityMessage(ev, runStartMs);
        if (msg) out.push(msg);
        break;
      }
    }
  }
  return out;
}

/**
 * Lift subagent events into nested `SpawnMessage` child threads (constraint #2,
 * the only nesting axis).
 *
 * An event carrying a {@link readParentToolUseId} was emitted BY a spawned
 * subagent; the id points at the PARENT spawn tool's `tool_call` through the
 * normalized harness correlation. We:
 *   1. partition events into the main agent's events (no parentToolUseId) and
 *      one group per parent tool id (the subagent's events);
 *   2. build the main agent's flat message series;
 *   3. when we reach the parent spawn tool's `tool_call`, REPLACE its
 *      ToolMessage with a {@link SpawnMessage} whose child Thread is built from
 *      that group's events (kind "execute", spawnLabel "subagent"), inserted at
 *      the parent tool's position.
 *
 * When NO event carries a parent id this degrades to a flat series — identical
 * output to the pre-linkage behavior (the existing flat tests guard this).
 */
function groupBySpawn(
  events: ConversationEvent[],
  resultById: Map<string, ToolResultEvent>,
  speaker: string | undefined,
  model: string | undefined,
  runStartMs: number | null
): Message[] {
  const parentRedirects = buildCollabParentRedirects(events);

  // Partition: main-agent events vs subagent events keyed by parent tool id.
  const main: ConversationEvent[] = [];
  const childGroups = new Map<string, ConversationEvent[]>();
  for (const ev of events) {
    const initialParentId = readParentToolUseId(ev);
    const parentId = initialParentId
      ? parentRedirects.get(initialParentId) || initialParentId
      : undefined;
    if (parentId === undefined) {
      main.push(ev);
      continue;
    }
    let group = childGroups.get(parentId);
    if (!group) {
      group = [];
      childGroups.set(parentId, group);
    }
    group.push(ev);
  }

  // No linkage → flat series (unchanged behavior).
  if (childGroups.size === 0) {
    return eventsToMessages(main, resultById, speaker, model, runStartMs);
  }

  const out: Message[] = [];
  const spawned = new Set<string>();
  for (const ev of main) {
    if (isNonSpawnCollabAgentCall(ev)) continue;
    // When this is the parent spawn tool_call, swap its row for the nested
    // child Thread carrying the subagent's events.
    if (ev.kind === "tool_call" && childGroups.has(ev.toolId)) {
      const childEvents = childGroups.get(ev.toolId)!;
      out.push(spawnMessage(ev, childEvents, resultById, runStartMs));
      spawned.add(ev.toolId);
      continue;
    }
    out.push(...eventsToMessages([ev], resultById, speaker, model, runStartMs));
  }

  // Defensive: if a child group references a parent tool_call that never
  // appeared in the main stream, surface the orphaned subagent at the end
  // rather than dropping it.
  for (const [parentId, childEvents] of childGroups) {
    if (spawned.has(parentId)) continue;
    out.push(
      spawnMessage(undefined, childEvents, resultById, runStartMs, parentId)
    );
  }

  return out;
}

function buildCollabParentRedirects(
  events: ConversationEvent[]
): Map<string, string> {
  const spawnByAgentKey = new Map<string, string>();
  const pendingNonSpawn: Array<{ toolId: string; agentKeys: string[] }> = [];

  for (const ev of events) {
    if (ev.kind !== "tool_call") continue;
    const collabTool = inputStringField(ev.input, [
      "collab_tool",
      "collabTool",
    ]);
    if (!collabTool) continue;
    const agentKeys = agentIdentityKeys(ev.input);
    if (collabTool === "spawnAgent") {
      agentKeys.forEach((key) => spawnByAgentKey.set(key, ev.toolId));
    } else {
      pendingNonSpawn.push({ toolId: ev.toolId, agentKeys });
    }
  }

  const redirects = new Map<string, string>();
  for (const update of pendingNonSpawn) {
    const spawnToolId = update.agentKeys
      .map((key) => spawnByAgentKey.get(key))
      .find((toolId): toolId is string => Boolean(toolId));
    if (spawnToolId) redirects.set(update.toolId, spawnToolId);
  }
  return redirects;
}

function isNonSpawnCollabAgentCall(ev: ConversationEvent): boolean {
  if (ev.kind !== "tool_call") return false;
  const collabTool = inputStringField(ev.input, ["collab_tool", "collabTool"]);
  return Boolean(collabTool && collabTool !== "spawnAgent");
}

/**
 * Build a {@link SpawnMessage} wrapping a subagent's events in a child Thread.
 * `parentCall` is the parent spawn tool_call (used for its id/label/clock);
 * when absent (orphaned group) `fallbackId` keys the thread.
 */
function spawnMessage(
  parentCall: ToolCallEvent | undefined,
  childEvents: ConversationEvent[],
  resultById: Map<string, ToolResultEvent>,
  runStartMs: number | null,
  fallbackId?: string
): Message {
  const threadId = parentCall?.toolId || fallbackId || nextEvt("spawn");

  // The child speaker/model come from the child's own session_start, if any.
  let childSpeaker: string | undefined;
  let childModel: string | undefined;
  for (const ev of childEvents) {
    if (ev.kind === "session_start") {
      childModel = ev.model;
      childSpeaker = ev.model ? `Agent · ${ev.model}` : "Agent";
      break;
    }
  }

  const childMessages = eventsToMessages(
    childEvents,
    resultById,
    childSpeaker,
    childModel,
    runStartMs
  );
  const turns: Turn[] = [{ id: `${threadId}-t0`, messages: childMessages }];

  const toolCount = childMessages.filter((m) => m.type === "tool").length;
  const hasErr = childMessages.some(
    (m) =>
      m.type === "error" ||
      (m.type === "tool" && (m.error || m.status === "err"))
  );
  const parentStatus = spawnStatus(parentCall);
  const summary: ThreadSummary = {
    turns: turns.length,
    tools: toolCount,
    status: hasErr ? "err" : (parentStatus ?? "ok"),
  };

  const childThread: Thread = {
    id: threadId,
    label: spawnLabel(parentCall),
    kind: "execute",
    spawnLabel: "subagent",
    summary,
    turns,
  };

  return {
    type: "spawn",
    thread: childThread,
    evt: parentCall?.toolId || threadId,
  };
}

function spawnStatus(
  parentCall: ToolCallEvent | undefined
): ThreadSummary["status"] | undefined {
  if (!parentCall) return undefined;
  const statuses = agentStatusValues(parentCall.input);
  if (
    statuses.some((status) => /^(failed|error|system_?error)$/i.test(status))
  ) {
    return "err";
  }
  if (
    statuses.some((status) =>
      /^(active|running|in_?progress|executing)$/i.test(status)
    )
  ) {
    return "running";
  }
  if (
    statuses.some((status) =>
      /^(pending_?init|pending|idle|not_?loaded|waiting)$/i.test(status)
    )
  ) {
    return "waiting";
  }
  return undefined;
}

function agentStatusValues(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  };
  const addRecordStatus = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    add((value as Record<string, unknown>).status);
  };

  add(input.status);
  addRecordStatus(input.agents_states);
  addRecordStatus(input.agentsStates);

  for (const field of ["agent_statuses", "agentStatuses"] as const) {
    const rows = input[field];
    if (Array.isArray(rows)) rows.forEach(addRecordStatus);
  }

  for (const field of ["agents_states", "agentsStates"] as const) {
    const states = input[field];
    if (!states || typeof states !== "object" || Array.isArray(states)) {
      continue;
    }
    Object.values(states as Record<string, unknown>).forEach((state) => {
      add(state);
      addRecordStatus(state);
    });
  }

  return values;
}

function spawnLabel(parentCall: ToolCallEvent | undefined): string {
  if (!parentCall) return "subagent";
  const input = parentCall.input;
  const direct =
    inputStringField(input, [
      "agent_nickname",
      "agentNickname",
      "new_agent_nickname",
      "newAgentNickname",
      "receiver_agent_nickname",
      "receiverAgentNickname",
      "nickname",
      "name",
    ]) || singleReceiverAgentName(input);
  return (
    direct ||
    agentIdentityLabel(input) ||
    inputStringField(input, ["description", "prompt"]) ||
    parentCall.displayName ||
    "subagent"
  );
}

function inputStringField(
  input: Record<string, unknown>,
  fields: readonly string[]
): string {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function singleReceiverAgentName(input: Record<string, unknown>): string {
  const receivers = input.receiver_agents ?? input.receiverAgents;
  if (!Array.isArray(receivers) || receivers.length !== 1) return "";
  const receiver = receivers[0];
  if (!receiver || typeof receiver !== "object" || Array.isArray(receiver)) {
    return "";
  }
  return inputStringField(receiver as Record<string, unknown>, [
    "agent_nickname",
    "agentNickname",
    "nickname",
    "name",
  ]);
}

function agentIdentityLabel(input: Record<string, unknown>): string {
  const id = agentIdentityKeys(input)[0] || "";
  return id ? `Agent ${shortAgentId(id)}` : "";
}

function agentIdentityKeys(input: Record<string, unknown>): string[] {
  return [
    ...stringsFromArray(input.receiver_thread_ids),
    ...stringsFromArray(input.receiverThreadIds),
    ...receiverAgentIds(input),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function stringsFromArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0
    )
    .map((item) => item.trim());
}

function receiverAgentIds(input: Record<string, unknown>): string[] {
  const receivers = input.receiver_agents ?? input.receiverAgents;
  if (!Array.isArray(receivers)) return [];
  return receivers
    .map((receiver) => {
      if (
        !receiver ||
        typeof receiver !== "object" ||
        Array.isArray(receiver)
      ) {
        return "";
      }
      return inputStringField(receiver as Record<string, unknown>, [
        "thread_id",
        "threadId",
        "agent_id",
        "agentId",
        "agent_path",
        "agentPath",
        "path",
        "id",
      ]);
    })
    .filter(Boolean);
}

function shortAgentId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
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

// ===========================================================================
// chatTurnEventsToMessages — the local-chat reuse of groupBySpawn.
// ===========================================================================

export interface ChatTurnOptions {
  /** Toggle a tool body's collapsed state (interactive surfaces). */
  onToggleTool?: (toolId: string) => void;
  /** Tool ids currently COLLAPSED; when omitted tools start collapsed. */
  collapsed?: Set<string>;
  /** Provider label shown on assistant prose rows. */
  assistantLabel?: string;
  /**
   * SESSION-wide tool_result index. A result can land in a later chat turn
   * than its call; per-turn indexing would leave the call's card pending
   * forever. Falls back to indexing this turn's `events` when omitted.
   */
  resultById?: Map<string, ToolResultEvent>;
}

/**
 * Build the message series for ONE chat turn's events, reusing {@link
 * groupBySpawn} so sub-agent tool calls/results (those carrying
 * `parentToolUseId`) lift into nested `SpawnMessage` child threads — the SAME
 * nesting Traces gets. With no sub-agent linkage this degrades to a flat
 * series (agent prose + standalone tool rows), a layout the Thread renderer
 * supports.
 *
 * Tools are wired for the chat's interactive collapse model: each tool body is
 * collapsed per `collapsed` (default collapsed) and toggles via
 * `onToggleTool(toolId)`. Wiring recurses into nested sub-agent threads.
 */
export function chatTurnEventsToMessages(
  events: ConversationEvent[],
  opts: ChatTurnOptions = {}
): Message[] {
  let resultById = opts.resultById;
  if (!resultById) {
    resultById = new Map<string, ToolResultEvent>();
    for (const ev of events) {
      if (ev.kind === "tool_result") resultById.set(ev.toolUseId, ev);
    }
  }
  const msgs = groupBySpawn(
    events,
    resultById,
    opts.assistantLabel ?? "Assistant",
    undefined,
    null
  );
  wireChatToolCollapse(msgs, opts);
  return msgs;
}

/** Recursively apply the chat collapse model to every ToolMessage in a series. */
function wireChatToolCollapse(msgs: Message[], opts: ChatTurnOptions): void {
  for (const m of msgs) {
    if (m.type === "tool") {
      const id = m.evt;
      m.collapsed = opts.collapsed ? opts.collapsed.has(id) : true;
      m.onToggle = opts.onToggleTool
        ? () => opts.onToggleTool!(id)
        : m.onToggle;
    } else if (m.type === "agent" && m.tools) {
      wireChatToolCollapse(m.tools, opts);
    } else if (m.type === "spawn") {
      for (const t of m.thread.turns) wireChatToolCollapse(t.messages, opts);
    }
  }
}
