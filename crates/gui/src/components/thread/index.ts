/**
 * Thread primitive — public barrel.
 *
 * The unified recursive event-log rendering primitive (P1). One model, two
 * surfaces: the Traces stream and the chat surfaces render the SAME tree
 * through <Thread> / <EventRow>, differing only by capability flags.
 *
 * The co-located stylesheet is imported here ONCE so any consumer of the
 * barrel gets the styles automatically (no self-injecting IIFE).
 */

import "./thread.css";

// ── Recursive thread primitive ──
export { Thread, flattenThreads } from "./Thread";
export type { ThreadProps } from "./Thread";

// ── Event-log atom family ──
export {
  EventLog,
  EventRow,
  ToolRow,
  StepDivider,
} from "./EventRow";
export type {
  EventLogProps,
  EventRowProps,
  StepDividerProps,
} from "./EventRow";

// ── Normalizers (backend → Thread model) ──
export {
  runToThreads,
  runToRun,
  msgsToThread,
  conversationEventsToThread,
  stepKindFromStepType,
  humanDuration,
} from "./normalize";
export type { RunInput, ChatMsg } from "./normalize";

// ── Canonical types (re-exported for convenience) ──
export type {
  ThreadMode,
  ThreadReveal,
  ThreadCapabilities,
  StepKind,
  ThreadStatus,
  ThreadStep,
  ThreadSummary,
  BaseMessage,
  UserRole,
  UserMessage,
  SystemMessage,
  ToolMessage,
  AgentMessage,
  WaitMessage,
  ErrorMessage,
  SpawnMessage,
  Message,
  Turn,
  Thread as ThreadModel,
  Run,
  ThreadNavNode,
} from "./types";
