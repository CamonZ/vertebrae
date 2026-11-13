/**
 * The projection of one chat session's background work. Adapters only emit
 * updates (`vertebrae-harness-core` `background.rs`); these rules live here:
 * - A higher `generation` is a restart; older generations are ignored.
 * - A definitive outcome is only replaced by another definitive outcome, so
 *   late progress never reopens finished work.
 * - `unknown` (stopped without an outcome) never means success and is
 *   replaced by a later definitive outcome.
 * - Only live delivery confirms work is running now; replay never does.
 * - A roster replaces the previous one: tracked work missing from it becomes
 *   `unknown`. Losing the backend connection marks running work unconfirmed.
 */

import type {
  LocalChatBackgroundRosterEvent,
  LocalChatBackgroundWorkEvent,
} from "../bindings";
import type {
  BackgroundRosterConversationEvent,
  BackgroundWorkConversationEvent,
} from "../types/conversation";
import type { ChatMessage } from "./chatStore";

export type BackgroundWorkKind = "command" | "other";
export type BackgroundWorkStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface BackgroundWorkUpdate {
  eventId: string;
  workId: string;
  generation: number;
  kind: BackgroundWorkKind;
  providerKind: string | null;
  status: BackgroundWorkStatus;
  description: string | null;
  progress: string | null;
  launchToolId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  observedAt: string;
  turnId: string | null;
  threadId: string | null;
}

export interface BackgroundRosterUpdate {
  eventId: string;
  observedAt: string;
  turnId: string | null;
  work: Array<{
    workId: string;
    kind: BackgroundWorkKind;
    providerKind: string | null;
    description: string | null;
  }>;
}

export interface BackgroundWorkRecord {
  workId: string;
  generation: number;
  kind: BackgroundWorkKind;
  providerKind: string | null;
  status: BackgroundWorkStatus;
  description: string | null;
  progress: string | null;
  launchToolId: string | null;
  /** Turn in which the work was first seen; later turns never take it over. */
  originTurnId: string | null;
  ownerThreadId: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Running was confirmed by live delivery on the current connection. */
  fresh: boolean;
  rosterTracked: boolean;
  order: number;
}

export interface BackgroundWorkState {
  records: Record<string, BackgroundWorkRecord>;
  seenEventIds: string[];
  nextOrder: number;
}

export type BackgroundWorkTransition = BackgroundWorkRecord;

export interface BackgroundApplyResult {
  state: BackgroundWorkState;
  transitions: BackgroundWorkTransition[];
}

const MAX_SEEN_EVENT_IDS = 512;

export const EMPTY_BACKGROUND_WORK: BackgroundWorkState = {
  records: {},
  seenEventIds: [],
  nextOrder: 0,
};

const DEFINITIVE = new Set<BackgroundWorkStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isDefinitive(status: BackgroundWorkStatus): boolean {
  return DEFINITIVE.has(status);
}

export function isActiveBackgroundWork(record: BackgroundWorkRecord): boolean {
  return record.status === "running" && record.fresh;
}

export function backgroundWorkKind(
  value: string | undefined
): BackgroundWorkKind {
  return value === "command" ? value : "other";
}

export function backgroundWorkStatus(
  value: string | undefined
): BackgroundWorkStatus {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "unknown";
  }
}

export function backgroundUpdateFromEvent(
  payload: LocalChatBackgroundWorkEvent
): BackgroundWorkUpdate {
  return {
    eventId: payload.event_id,
    workId: payload.work_id,
    generation: payload.generation,
    kind: backgroundWorkKind(payload.kind),
    providerKind: payload.provider_kind ?? null,
    status: backgroundWorkStatus(payload.status),
    description: payload.description ?? null,
    progress: payload.progress ?? null,
    launchToolId: payload.launch_tool_id ?? null,
    startedAt: payload.started_at ?? null,
    finishedAt: payload.finished_at ?? null,
    error: payload.error ?? null,
    observedAt: payload.observed_at,
    turnId: payload.turn_id ?? null,
    threadId: payload.thread_id ?? null,
  };
}

export function backgroundRosterFromEvent(
  payload: LocalChatBackgroundRosterEvent
): BackgroundRosterUpdate {
  return {
    eventId: payload.event_id,
    observedAt: payload.observed_at,
    turnId: payload.turn_id ?? null,
    work: payload.work.map((entry) => ({
      workId: entry.work_id,
      kind: backgroundWorkKind(entry.kind),
      providerKind: entry.provider_kind ?? null,
      description: entry.description ?? null,
    })),
  };
}

function remember(state: BackgroundWorkState, eventId: string) {
  const seenEventIds = [...state.seenEventIds, eventId];

  if (seenEventIds.length > MAX_SEEN_EVENT_IDS) {
    seenEventIds.splice(0, seenEventIds.length - MAX_SEEN_EVENT_IDS);
  }

  return seenEventIds;
}

function freshRecord(
  update: BackgroundWorkUpdate,
  live: boolean,
  order: number
): BackgroundWorkRecord {
  const terminal = update.status !== "running";

  return {
    workId: update.workId,
    generation: update.generation,
    kind: update.kind,
    providerKind: update.providerKind,
    status: update.status,
    description: update.description,
    progress: update.progress,
    launchToolId: update.launchToolId,
    originTurnId: update.turnId,
    ownerThreadId: update.threadId,
    startedAt: update.startedAt,
    updatedAt: update.observedAt,
    finishedAt: terminal ? update.finishedAt : null,
    error: terminal ? update.error : null,
    fresh: !terminal && live,
    rosterTracked: false,
    order,
  };
}

function acceptsStatus(
  current: BackgroundWorkRecord,
  update: BackgroundWorkUpdate,
  live: boolean
): boolean {
  if (isDefinitive(current.status)) return isDefinitive(update.status);
  if (current.status === "unknown" && update.status === "running") return live;
  return true;
}

/** Returns `current` itself when nothing changes, so callers can skip copies. */
function nextRecord(
  current: BackgroundWorkRecord | undefined,
  update: BackgroundWorkUpdate,
  live: boolean,
  order: number
): BackgroundWorkRecord {
  if (!current) return freshRecord(update, live, order);
  if (update.generation < current.generation) return current;

  if (update.generation > current.generation) {
    const restarted = freshRecord(update, live, current.order);

    return {
      ...restarted,
      originTurnId: current.originTurnId ?? restarted.originTurnId,
      ownerThreadId: current.ownerThreadId ?? restarted.ownerThreadId,
      description: restarted.description ?? current.description,
      launchToolId: restarted.launchToolId ?? current.launchToolId,
    };
  }

  const merged: BackgroundWorkRecord = {
    ...current,
    kind:
      current.kind === "other" && update.kind !== "other"
        ? update.kind
        : current.kind,
    providerKind: current.providerKind ?? update.providerKind,
    description: update.description ?? current.description,
    launchToolId: current.launchToolId ?? update.launchToolId,
  };

  if (!acceptsStatus(current, update, live)) {
    return sameRecord(current, merged) ? current : merged;
  }

  const terminal = update.status !== "running";

  return {
    ...merged,
    status: update.status,
    progress: update.progress ?? merged.progress,
    startedAt: merged.startedAt ?? update.startedAt,
    updatedAt: update.observedAt,
    finishedAt: terminal ? (update.finishedAt ?? merged.finishedAt) : null,
    error: terminal ? (update.error ?? merged.error) : null,
    fresh: terminal ? false : live || merged.fresh,
  };
}

function sameRecord(a: BackgroundWorkRecord, b: BackgroundWorkRecord) {
  return (Object.keys(a) as Array<keyof BackgroundWorkRecord>).every(
    (key) => a[key] === b[key]
  );
}

function becameTerminal(
  before: BackgroundWorkRecord | undefined,
  after: BackgroundWorkRecord
): boolean {
  if (after.status === "running") return false;
  if (!before || before.generation !== after.generation) return true;

  return before.status !== after.status;
}

export function applyBackgroundUpdate(
  state: BackgroundWorkState,
  update: BackgroundWorkUpdate,
  options: { live: boolean }
): BackgroundApplyResult {
  if (state.seenEventIds.includes(update.eventId)) {
    return { state, transitions: [] };
  }

  const before = state.records[update.workId];
  const after = nextRecord(before, update, options.live, state.nextOrder);

  return {
    state: {
      records:
        after === before
          ? state.records
          : { ...state.records, [update.workId]: after },
      seenEventIds: remember(state, update.eventId),
      nextOrder: before ? state.nextOrder : state.nextOrder + 1,
    },
    transitions: becameTerminal(before, after) ? [after] : [],
  };
}

export function applyBackgroundRoster(
  state: BackgroundWorkState,
  roster: BackgroundRosterUpdate,
  options: { live: boolean }
): BackgroundApplyResult {
  if (state.seenEventIds.includes(roster.eventId)) {
    return { state, transitions: [] };
  }

  const listed = new Set(roster.work.map((entry) => entry.workId));
  const records = { ...state.records };
  const transitions: BackgroundWorkTransition[] = [];

  // A roster replaces the previous one: listed work that left it has ended
  // without a reported outcome.
  for (const record of Object.values(records)) {
    if (
      record.rosterTracked &&
      record.status === "running" &&
      !listed.has(record.workId)
    ) {
      const ended = {
        ...record,
        status: "unknown" as const,
        fresh: false,
        updatedAt: roster.observedAt,
      };

      records[record.workId] = ended;
      transitions.push(ended);
    }
  }

  let nextOrder = state.nextOrder;

  for (const entry of roster.work) {
    const before = records[entry.workId];
    const after = nextRecord(
      before,
      {
        eventId: roster.eventId,
        workId: entry.workId,
        generation: before?.generation ?? 0,
        kind: entry.kind,
        providerKind: entry.providerKind,
        status: "running",
        description: entry.description,
        progress: null,
        launchToolId: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        observedAt: roster.observedAt,
        turnId: roster.turnId,
        threadId: null,
      },
      options.live,
      nextOrder
    );

    if (!before) nextOrder += 1;
    records[entry.workId] = after.rosterTracked
      ? after
      : { ...after, rosterTracked: true };
  }

  return {
    state: {
      records,
      seenEventIds: remember(state, roster.eventId),
      nextOrder,
    },
    transitions,
  };
}

/**
 * After the provider connection is lost or replaced, running work stays listed
 * but unconfirmed until live evidence arrives again.
 */
export function markBackgroundWorkStale(
  state: BackgroundWorkState
): BackgroundWorkState {
  let changed = false;
  const records = { ...state.records };

  for (const record of Object.values(records)) {
    if (record.status === "running" && record.fresh) {
      records[record.workId] = { ...record, fresh: false };
      changed = true;
    }
  }

  return changed ? { ...state, records } : state;
}

export function backgroundWorkRows(
  state: BackgroundWorkState | null | undefined
): BackgroundWorkRecord[] {
  if (!state) return [];

  return Object.values(state.records)
    .filter((record) => record.status === "running")
    .sort((a, b) => a.order - b.order);
}

export function activeBackgroundWorkCount(
  state: BackgroundWorkState | null | undefined
): number {
  if (!state) return 0;

  return Object.values(state.records).filter(isActiveBackgroundWork).length;
}

export function backgroundOutcomeMessages(
  transitions: BackgroundWorkTransition[]
): ChatMessage[] {
  return transitions.flatMap((record) =>
    record.status === "running"
      ? []
      : [
          {
            kind: "background_outcome" as const,
            workId: record.workId,
            generation: record.generation,
            workKind: record.kind,
            status: record.status,
            description: record.description,
            summary: record.progress,
            error: record.error,
            launchToolId: record.launchToolId,
            timestamp: record.updatedAt,
          },
        ]
  );
}

export function foldBackgroundEvent(
  state: BackgroundWorkState,
  event: BackgroundWorkConversationEvent | BackgroundRosterConversationEvent,
  options: { live: boolean }
): BackgroundApplyResult {
  return event.kind === "background_roster"
    ? applyBackgroundRoster(state, event.roster, options)
    : applyBackgroundUpdate(state, event.update, options);
}
