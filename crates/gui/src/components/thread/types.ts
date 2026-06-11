/**
 * Canonical types for the unified recursive Thread primitive.
 *
 * One model, two surfaces. The Traces stream and the chat surfaces render the
 * SAME tree through the SAME <Thread> / <EventRow> components; only capability
 * flags differ:
 *   · chat   → mode="bare"  reveal="shallow" interactive   showHead={false}
 *   · traces → mode="timed" reveal="deep"     readOnly      (focus-drill nav)
 *
 * The canonical model:
 *   Task › Run › Thread › Turn › Message{ user · system · agent · tool ·
 *                                          wait · error · spawn }
 *
 * A Thread is RECURSIVE: a `Message` of type "spawn" carries a child `Thread`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HARD CONSTRAINTS encoded here (decided with the user):
 *
 *   1. SINGLE TASK RUN ONLY. A `Run` = exactly one `task_run`; its `threads`
 *      are its `step_executions`. There is NO cross-run recursion in this
 *      tree — the recursive TaskRunTrace / DelegationBlock machinery is gone.
 *
 *   2. The ONLY nesting axis is intra-run subagents, linked by Anthropic's
 *      `parent_tool_use_id`. A subagent surfaces as a `SpawnMessage` carrying
 *      a child `Thread`. Within one step execution several agents may run in
 *      parallel; the parent turn completes only when all children finish.
 *
 *   3. `wait_for_children` is a step→step relationship, NOT intra-step. It is
 *      rendered as a TERMINAL `WaitMessage` with optional navigable
 *      `childRunIds` links — never an inlined child subtree. (Following such a
 *      link navigates to a different Run; it does not nest one Run inside
 *      another.)
 *
 * These are pure types: no React import is required beyond `ReactNode`, used
 * only where rendered prose may be embedded directly (the prototype passes
 * JSX prose; the production normalizer will pass strings + render markdown).
 * ──────────────────────────────────────────────────────────────────────────
 */

import type { ReactNode } from "react";

// ===========================================================================
// Capability flags — how a Thread tree is presented on a given surface.
// ===========================================================================

/**
 * Grouping / gutter mode.
 *   · "timed" (Traces) shows the left time/rel/id gutter and 1px row gaps.
 *   · "bare"  (Chat)   hides the gutter and uses generous turn gaps.
 * Mirrors EventLog's `evlog--timed` / `evlog--bare` modifiers.
 */
export type ThreadMode = "timed" | "bare";

/**
 * Reveal depth — how much structure is shown.
 *   · "deep"    (Traces) shows turn separators (>1 turn) and the full series.
 *   · "shallow" (Chat)   hides turn separators and `system` messages.
 * Mirrors the prototype's `reveal` flag (`reveal === 'shallow'` drops
 * `system` rows and per-turn `turn N` dividers).
 */
export type ThreadReveal = "deep" | "shallow";

/**
 * The complete capability set a surface passes down the tree. Bundled as a
 * type for documentation; <Thread>/<EventRow> accept these as individual
 * props (see ThreadProps / EventRowProps below) so React can spread them.
 */
export interface ThreadCapabilities {
  mode: ThreadMode;
  reveal: ThreadReveal;
  /**
   * When true, the surface is interactive (chat): tool toggles, composer
   * wiring, etc. When false (or `readOnly` true), the surface is read-only
   * (Traces today) and the only interaction is selection + focus-drill.
   */
  interactive?: boolean;
  /** Convenience inverse of `interactive`; either may be supplied. */
  readOnly?: boolean;
}

// ===========================================================================
// Step / thread classification.
// ===========================================================================

/**
 * The five Vertebrae step kinds plus the subagent fallback. Drives the tick /
 * kind-badge color (--step-execute / -eval / -route / -human / -wait) and the
 * subthread spine color. Maps from Sacrum `StepType`:
 *   execute       → "execute"
 *   evaluate      → "eval"
 *   route         → "route"
 *   human_input   → "human"
 *   wait_children → "wait"
 * A spawned subagent thread that carries no step uses "execute" by default.
 */
export type StepKind = "execute" | "eval" | "route" | "human" | "wait";

/**
 * Status of a thread / subthread, used by the subthread summary status mark
 * and (loosely) by tool / step rows.
 *   · "ok" | "err" | "waiting" → static colored dot
 *   · "running"                → spinner
 */
export type ThreadStatus = "ok" | "err" | "waiting" | "running";

/**
 * The step head of a ROOT thread (depth 0). For a run, one root thread = one
 * step_execution; `to` is the human-readable step name and `kind` its type.
 * Mirrors the prototype's `thread.step`.
 */
export interface ThreadStep {
  /** Human-readable step name shown in the head (e.g. "verify_changes"). */
  to: string;
  /** Step kind → tick/badge color. */
  kind: StepKind;
  /** Absolute timestamp string for the timed gutter (e.g. "01:22:40"). */
  at?: string;
  /** Relative offset string for the timed gutter (e.g. "+8m 58s"). */
  rel?: string;
  /** Optional runtime/duration label shown at the right of the head. */
  runtime?: string;
}

/**
 * Aggregate counts shown in a thread head / subthread summary line.
 * Mirrors the prototype's `thread.summary`.
 */
export interface ThreadSummary {
  /** Number of turns in this thread. */
  turns?: number;
  /** Number of tool calls across this thread. */
  tools?: number;
  /** Roll-up status for the subthread status mark. */
  status?: ThreadStatus;
  /** Optional duration label (e.g. "48s"). */
  dur?: string;
}

// ===========================================================================
// Messages — the discriminated union rendered by <EventRow>.
//
// `type` is the discriminant. The prototype renders `system` with the user
// vocabulary (quiet, collapsible) but it is a first-class kind here.
// ===========================================================================

/**
 * Fields common to every message. `evt` is a stable per-message id used for
 * selection (`selectedEvt === m.evt`) and as a React key.
 */
export interface BaseMessage {
  /** Stable selection id / React key for this row. */
  evt: string;
  /** Absolute timestamp for the timed gutter (hidden in bare mode). */
  at?: string;
  /** Relative offset for the timed gutter (hidden in bare mode). */
  rel?: string;
  /**
   * Optional id shown as an IdChip in the timed gutter (turn id, error id,
   * wait id, …). Distinct from `evt`, which is the selection key.
   */
  id?: string;
}

/**
 * Role of a user-vocabulary message.
 *   · "human"  → the accent "You" row (a real human turn).
 *   · "prompt" → quiet, collapsible interpolated step input (trace only;
 *                chat hides it via reveal="shallow").
 */
export type UserRole = "human" | "prompt";

/** A user turn — a human prompt, or an interpolated step prompt. */
export interface UserMessage extends BaseMessage {
  type: "user";
  role?: UserRole;
  /** Eyebrow label (e.g. "You", "Prompt · interpolated"). */
  label?: string;
  /** The visible message text. */
  text?: string;
  /**
   * Optional raw/expandable input body (the full interpolated prompt). Shown
   * behind a "show input" toggle.
   */
  body?: ReactNode;
}

/**
 * A system message — first-class, rendered with the quiet user/prompt
 * vocabulary but readable (wraps). Dropped entirely when reveal="shallow".
 */
export interface SystemMessage extends BaseMessage {
  type: "system";
  label?: string;
  text?: string;
  body?: ReactNode;
}

/**
 * A tool invocation. Merges the prototype's "fn card" and "shell line": a bare
 * line by default, a bordered collapsible card only when it has output (`body`).
 * `kind: "shell"` (or `cmd` without `name`) renders the `$` prompt form.
 */
export interface ToolMessage extends BaseMessage {
  type: "tool";
  /** Function-style tool name (mutually exclusive-ish with `cmd`). */
  name?: string;
  /** Shell command name when `kind === "shell"`. */
  cmd?: string;
  /** Explicit shell vs fn discriminator; inferred from cmd/name when absent. */
  kind?: "shell" | "fn";
  /** Pre-rendered args node (overrides flag/em composition). */
  args?: ReactNode;
  /** Shell flag fragment (e.g. "-n"), composed into args when `args` absent. */
  flag?: string;
  /** Emphasised arg fragment (e.g. the pattern / path), rendered accented. */
  em?: string;
  /** Short inline summary (e.g. result count) shown after args. */
  summary?: string;
  /** Expandable output body; presence upgrades the row to a bordered card. */
  body?: ReactNode;
  /** Duration label (e.g. "142ms"). */
  dur?: string;
  /** Tool status; "pending" shows a spinner, "err" the error treatment. */
  status?: "pending" | "ok" | "err" | "done";
  /** Convenience error flag (equivalent to status "err"). */
  error?: boolean;
  /** Whether the output body starts collapsed. */
  collapsed?: boolean;
  /** Toggle handler for the body (interactive surfaces only). */
  onToggle?: () => void;
}

/**
 * An agent turn — speaker + optional model badge + inline tools + prose.
 * In the production normalizer, `prose` is a markdown string rendered via the
 * shared MarkdownContent; the prototype passes JSX, hence `ReactNode`.
 */
export interface AgentMessage extends BaseMessage {
  type: "agent";
  /** Speaker eyebrow (e.g. "Agent · Codex", "sacrum"). */
  speaker?: string;
  /** Optional model badge (e.g. "claude-sonnet-4.5"). */
  model?: string;
  /** Rendered prose (markdown string in production, JSX in the prototype). */
  prose?: ReactNode;
  /**
   * Tools emitted within this agent turn, rendered above the prose. NOTE:
   * tools may alternatively be standalone ToolMessages in the turn series;
   * both layouts are supported (the normalizer chooses one — see normalize.ts).
   */
  tools?: ToolMessage[];
  /** Streaming bubble: render a blinking cursor and a spinner speaker dot. */
  streaming?: boolean;
}

/**
 * A terminal wait message for `wait_for_children`. Rendered with the slate
 * "wait" treatment and an animated flow bar. Optional `childRunIds` become
 * navigable links to OTHER Runs — they are NEVER inlined as a child subtree
 * (constraint #3).
 */
export interface WaitMessage extends BaseMessage {
  type: "wait";
  /** The wait copy (e.g. "Waiting on 3 child tasks · running for 7h 36m"). */
  text?: string;
  /** Short trailing id/status note (e.g. "c794b783 still running"). */
  wid?: string;
  /**
   * task_run ids of the children being waited on. The surface MAY render
   * these as links that navigate to those runs. They do not nest.
   */
  childRunIds?: string[];
}

/** A salient, rare error row. */
export interface ErrorMessage extends BaseMessage {
  type: "error";
  /** Bold error title (e.g. "run_tests failed · exit 1"). */
  title?: string;
  /** Mono sub-line with detail. */
  sub?: string;
}

/**
 * A RESULT message — a step execution's final structured output (its `output`
 * or `handoff`). Rendered as a distinct, prominent terminal card with the body
 * pretty-printed when it parses as JSON / an Elixir map.
 */
export interface ResultMessage extends BaseMessage {
  type: "result";
  /** Short label, e.g. "output" or "handoff". */
  label?: string;
  /** The structured output text (pretty-printed at render time). */
  body: string;
}

/**
 * Compact live activity sourced from provider telemetry. These rows are status
 * signals rather than transcript prose: thinking heartbeats, subagent progress,
 * task notifications, and rate-limit banners.
 */
export interface ActivityMessage extends BaseMessage {
  type: "activity";
  variant: "heartbeat" | "progress" | "banner" | "notification";
  label: string;
  text: string;
  tone?: "info" | "warn";
}

/**
 * A SPAWN message — the recursion point. Carries a child `Thread` (an
 * intra-run subagent linked by `parent_tool_use_id`). The Turn renderer
 * detects `type === "spawn"` and renders a nested <Thread> in place of an
 * <EventRow>.
 */
export interface SpawnMessage {
  type: "spawn";
  /** The nested subagent thread. */
  thread: Thread;
  /** Optional stable selection id / React key (falls back to thread.id). */
  evt?: string;
}

/** The discriminated union of everything that can appear in a Turn. */
export type Message =
  | UserMessage
  | SystemMessage
  | AgentMessage
  | ToolMessage
  | WaitMessage
  | ErrorMessage
  | ResultMessage
  | ActivityMessage
  | SpawnMessage;

// ===========================================================================
// Turn / Thread — the recursive tree.
// ===========================================================================

/**
 * A conversational turn: an ordered series of messages. In chat, each user
 * message opens a new turn and following agent messages attach to it. In a
 * trace, a step execution may be a single turn or several.
 */
export interface Turn {
  /** Stable id / React key for the turn. */
  id: string;
  /** Ordered messages (a `spawn` becomes a nested Thread). */
  messages: Message[];
}

/**
 * A Thread — recursive.
 *   · depth 0 (root)  → a Run's step execution. Renders a step-divider HEAD
 *                       (from `step`) followed by its turns.
 *   · depth > 0       → an intra-run subagent. Renders a collapsible summary
 *                       line with a kind-colored spine, then its turns.
 *
 * Mirrors the prototype's thread shape (RUN1_THREADS entries, SUB_* trees,
 * and msgsToThread's `{ id, turns }`).
 */
export interface Thread {
  /** Stable id — selection key, rail-nav key, scroll-into-view target. */
  id: string;
  /** Display label (subthread name, or chat-thread fallback for the head). */
  label?: string;
  /**
   * Step head for a ROOT thread. Present on depth-0 threads (one per
   * step_execution). Subthreads use `kind` + `label` instead.
   */
  step?: ThreadStep;
  /**
   * Direct kind for a subthread (when there is no `step`). Falls back to
   * "execute". For root threads, `step.kind` takes precedence.
   */
  kind?: StepKind;
  /** Eyebrow tag for a subthread summary (e.g. "subagent"). */
  spawnLabel?: string;
  /** Aggregate counts / status for the head / summary line. */
  summary?: ThreadSummary;
  /** Ordered turns. */
  turns: Turn[];
}

// ===========================================================================
// Run — a SINGLE task_run (constraint #1). NO cross-run recursion.
// ===========================================================================

/**
 * A Run = exactly one `task_run`. Its `threads` are its `step_executions`
 * (root threads, depth 0). This is the unit the normalizer produces and the
 * Traces stream renders. There is intentionally no `children` / `subRuns`
 * field — cross-run links live only inside `WaitMessage.childRunIds`.
 */
export interface Run {
  /** task_run id. */
  id: string;
  /** Root threads = this run's step executions, in order. */
  threads: Thread[];
}

// ===========================================================================
// Rail navigation — flattened thread nodes for the Traces rail.
// ===========================================================================

/**
 * A flattened thread node for the run's rail tree (output of `flattenThreads`).
 * Depth is clamped at the rendering layer (l0/l1/l2 indents).
 */
export interface ThreadNavNode {
  id: string;
  label: string;
  kind: StepKind;
  depth: number;
  summary: ThreadSummary;
}
