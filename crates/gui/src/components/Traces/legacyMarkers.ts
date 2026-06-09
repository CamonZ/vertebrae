/**
 * Legacy timeline marker types.
 *
 * These describe the lane/marker model the OLD FlightStrip projected. The
 * single-run FlightStrip now uses {@link import("./timeline").FlightProjection}
 * instead, but the chat-style conversation surface (ConversationLogViewer →
 * EventRenderer → EventGlyph, plus the StepBoundary / TransitionMarker boundary
 * affordances) still consumes these glyph/threshold shapes. They live here,
 * decoupled from the strip's projection, so both surfaces compile independently.
 */

export type LaneKind = "threshold" | "tool" | "main" | "delegation";

export type ThresholdMarkerKind =
  | "transition"
  | "retry"
  | "rejection"
  | "approval"
  | "model_fallback"
  | "execution_start"
  | "execution_end";

export interface ThresholdMarker {
  lane: "threshold";
  kind: ThresholdMarkerKind;
  /** Normalized [0, 1] x position. */
  x: number;
  timestampMs: number;
  executionId: string;
  taskId: string;
  fromStep: string | null;
  toStep: string | null;
  label: string;
}

export interface ToolMarker {
  lane: "tool";
  kind: "tool_use" | "tool_result";
  x: number;
  timestampMs: number;
  executionId: string;
  taskId: string;
  toolId: string;
  toolName: string;
  isError: boolean;
}

export interface MainMarker {
  lane: "main";
  kind: "message";
  x: number;
  timestampMs: number;
  executionId: string;
  taskId: string;
  rowIndex: number;
}

export interface DelegationEdge {
  lane: "delegation";
  x: number;
  timestampMs: number;
  parentTaskId: string;
  childTaskId: string;
  parentTaskRunId: string | null;
  childTaskRunId: string | null;
  parentRowIndex: number;
  childRowIndex: number;
  childLevel: string | null;
}

export type TimelineMarker = ThresholdMarker | ToolMarker | MainMarker;
