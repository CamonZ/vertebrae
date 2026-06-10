/**
 * Flight-strip projection for a SINGLE task_run.
 *
 * Maps the run's `Thread[]` (root threads = step executions, with intra-run
 * subagent SpawnMessages nested inside) onto a horizontal timeline of four
 * lanes:
 *
 *   · Steps     — one {@link StepSegment} per ROOT thread, positioned + sized
 *                 by its messages' time span, colored by step kind. A live
 *                 wait step renders as an open-ended `live` segment.
 *   · Tools     — one {@link ToolPip} per tool message (error pip on err).
 *   · Turns     — one {@link TurnPip} per agent message.
 *   · Subagents — one {@link SpawnSegment} per spawned subagent thread, colored
 *                 by the child's kind, with a {@link SpawnEdge} anchoring it to
 *                 the parent tool's x. Hidden gracefully when there are none.
 *
 * Positioning. Thread messages carry an `at` "HH:MM:SS" clock and a `rel`
 * offset string, but no raw epoch. We parse `at` into seconds-of-day and
 * normalize across the run's span to [0,1]; when timestamps are missing or
 * degenerate (all equal) we fall back to even index-based spacing so the strip
 * still renders sensibly.
 */

import type { Message, StepKind, Thread } from "../thread/types";

// ===========================================================================
// Output shapes.
// ===========================================================================

/** A step bar in the Steps lane (one per root thread). */
export interface StepSegment {
  threadId: string;
  kind: StepKind;
  /** Normalized [0,1] left edge. */
  left: number;
  /** Normalized [0,1] width. */
  width: number;
  /** Live (open-ended) wait segment. */
  live: boolean;
  label: string;
}

/** A pip in the Tools lane (one per tool message). */
export interface ToolPip {
  /** evt id of the tool message (selection / scroll target). */
  evt: string;
  /** Owning root thread id (scroll fallback target). */
  threadId: string;
  left: number;
  error: boolean;
}

/** A pip in the Turns lane (one per agent message). */
export interface TurnPip {
  evt: string;
  threadId: string;
  left: number;
}

/** A subagent bar in the Subagents lane. */
export interface SpawnSegment {
  threadId: string;
  kind: StepKind;
  left: number;
  width: number;
  label: string;
}

/** A connector from a parent tool's x down to its subagent segment. */
export interface SpawnEdge {
  /** Parent spawn tool x anchor. */
  x: number;
  childThreadId: string;
}

export interface FlightProjection {
  steps: StepSegment[];
  tools: ToolPip[];
  turns: TurnPip[];
  spawns: SpawnSegment[];
  spawnEdges: SpawnEdge[];
  /** True when there is at least one subagent (drives the 4th lane). */
  hasSpawns: boolean;
}

// ===========================================================================
// Time helpers.
// ===========================================================================

/** Parse an "HH:MM:SS(.mmm)" clock into seconds-of-day, or null. */
function clockSeconds(at: string | undefined): number | null {
  if (!at) return null;
  const m = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(at.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const frac = m[4] ? Number(m[4].padEnd(3, "0")) / 1000 : 0;
  return h * 3600 + min * 60 + s + frac;
}

function at(m: Message): string | undefined {
  return "at" in m ? m.at : undefined;
}

interface FlatMsg {
  msg: Message;
  threadId: string;
  /** Time in seconds-of-day, or null when unparseable. */
  t: number | null;
}

/** All renderable (non-spawn) messages of a single thread, with parsed time. */
function collectRootMessages(thread: Thread): FlatMsg[] {
  const out: FlatMsg[] = [];
  for (const turn of thread.turns ?? []) {
    for (const m of turn.messages ?? []) {
      if (m.type === "spawn") continue;
      out.push({ msg: m, threadId: thread.id, t: clockSeconds(at(m)) });
    }
  }
  return out;
}

/** Min/max seconds across every message in the run (root + nested). */
function runSpan(threads: Thread[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  const walk = (t: Thread): void => {
    for (const turn of t.turns ?? []) {
      for (const m of turn.messages ?? []) {
        if (m.type === "spawn") {
          walk(m.thread);
          continue;
        }
        const s = clockSeconds(at(m));
        if (s == null) continue;
        if (s < min) min = s;
        if (s > max) max = s;
      }
    }
  };
  threads.forEach(walk);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

// ===========================================================================
// buildFlightProjection — the single public entry point.
// ===========================================================================

export function buildFlightProjection(threads: Thread[]): FlightProjection {
  const steps: StepSegment[] = [];
  const tools: ToolPip[] = [];
  const turns: TurnPip[] = [];
  const spawns: SpawnSegment[] = [];
  const spawnEdges: SpawnEdge[] = [];

  const span = runSpan(threads);
  const norm = (t: number | null): number | null => {
    if (span == null || t == null) return null;
    const total = span.max - span.min;
    if (total <= 0) return null;
    return Math.max(0, Math.min(1, (t - span.min) / total));
  };
  const idxX = (i: number, n: number): number =>
    n <= 1 ? 0.02 : 0.02 + (0.96 * i) / (n - 1);

  threads.forEach((thread, ti) => {
    const kind: StepKind = thread.step?.kind ?? thread.kind ?? "execute";
    const isWait =
      kind === "wait" ||
      (thread.turns ?? []).some((t) =>
        (t.messages ?? []).some((m) => m.type === "wait")
      );

    const flat = collectRootMessages(thread);
    const times = flat.map((f) => f.t).filter((t): t is number => t != null);

    let left: number;
    let width: number;
    if (span && times.length > 0) {
      const lo = norm(Math.min(...times)) ?? idxX(ti, threads.length);
      const hi = norm(Math.max(...times)) ?? lo;
      left = lo;
      width = Math.max(0.01, hi - lo || 0.04);
    } else {
      left = idxX(ti, threads.length);
      width = 0.06;
    }
    if (isWait) {
      width = Math.max(width, 1 - left);
    }
    steps.push({
      threadId: thread.id,
      kind,
      left,
      width,
      live: isWait && thread.summary?.status === "waiting",
      label: thread.step?.to ?? thread.label ?? thread.id,
    });

    flat.forEach((f, i) => {
      const x = norm(f.t) ?? idxX(i, flat.length);
      if (f.msg.type === "tool") {
        tools.push({
          evt: f.msg.evt,
          threadId: thread.id,
          left: x,
          error: Boolean(f.msg.error) || f.msg.status === "err",
        });
      } else if (f.msg.type === "error") {
        tools.push({ evt: f.msg.evt, threadId: thread.id, left: x, error: true });
      } else if (f.msg.type === "agent") {
        turns.push({ evt: f.msg.evt, threadId: thread.id, left: x });
      }
    });

    for (const turn of thread.turns ?? []) {
      for (const m of turn.messages ?? []) {
        if (m.type !== "spawn") continue;
        const child = m.thread;
        const childTimes = collectRootMessages(child)
          .map((f) => f.t)
          .filter((t): t is number => t != null);
        const anchor =
          (childTimes.length > 0 ? norm(Math.min(...childTimes)) : null) ??
          left + width;
        const childKind: StepKind =
          child.step?.kind ?? child.kind ?? "execute";
        let sLeft = anchor;
        let sWidth = 0.06;
        if (span && childTimes.length > 1) {
          const lo = norm(Math.min(...childTimes)) ?? anchor;
          const hi = norm(Math.max(...childTimes)) ?? lo;
          sLeft = lo;
          sWidth = Math.max(0.01, hi - lo || 0.04);
        }
        spawns.push({
          threadId: child.id,
          kind: childKind,
          left: sLeft,
          width: sWidth,
          label: child.label ?? child.id,
        });
        spawnEdges.push({ x: anchor, childThreadId: child.id });
      }
    }
  });

  return {
    steps,
    tools,
    turns,
    spawns,
    spawnEdges,
    hasSpawns: spawns.length > 0,
  };
}
