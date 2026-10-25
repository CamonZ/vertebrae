import { useEffect, useRef, useState } from "react";
import {
  commands,
  type AssociationResult,
  type AssociationTicket,
} from "../bindings";
import { useChatStore, type ChatMessage } from "../stores/chatStore";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { cachedAssociationCandidates } from "../utils/chatAssociation/candidates";

type Worktree = { path: string; branch: string | null };

/**
 * Tiny per-session record. `lastProcessedAt`/`processedAtCount` locate the newest
 * handled event (several events can share a timestamp). `awaitingWorktree` holds
 * the worktree paths that existed when the user asked to create one.
 */
export type AssociationRecord = {
  ticketId: string | null;
  ticketTitle: string | null;
  worktreePath: string | null;
  branch: string | null;
  lastProcessedAt: string | null;
  processedAtCount: number;
  awaitingWorktree: string[] | null;
  recentWorktrees: Worktree[];
};
const EMPTY: AssociationRecord = {
  ticketId: null,
  ticketTitle: null,
  worktreePath: null,
  branch: null,
  lastProcessedAt: null,
  processedAtCount: 0,
  awaitingWorktree: null,
  recentWorktrees: [],
};
const RECENT_WORKTREES = 8;

const isText = (v: unknown) => v === null || typeof v === "string";
const isWorktree = (v: unknown): v is Worktree =>
  !!v &&
  typeof (v as Worktree).path === "string" &&
  isText((v as Worktree).branch);

function readRecord(value: unknown): AssociationRecord {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") return EMPTY;
  const texts = [
    "ticketId",
    "ticketTitle",
    "worktreePath",
    "branch",
    "lastProcessedAt",
  ] as const;
  const awaiting = v.awaitingWorktree;
  const valid =
    texts.every((k) => isText(v[k])) &&
    typeof v.processedAtCount === "number" &&
    (awaiting === null ||
      (Array.isArray(awaiting) &&
        awaiting.every((p) => typeof p === "string"))) &&
    Array.isArray(v.recentWorktrees) &&
    v.recentWorktrees.every(isWorktree);
  return valid ? (v as AssociationRecord) : EMPTY;
}

type Event = {
  kind: "user" | "tool";
  text: string;
  timestamp: string;
  n: number;
};

function associationEvents(messages: readonly ChatMessage[]): Event[] {
  const events: Event[] = [];
  for (const m of messages) {
    if ("parentToolUseId" in m && m.parentToolUseId) continue;
    // Assistant text never selects tickets; tool output only identifies worktrees.
    const text =
      m.kind === "user"
        ? m.text
        : m.kind === "tool_call"
          ? m.input
          : m.kind === "tool_result" && !m.isError
            ? m.result
            : null;
    if (text === null) continue;
    const previous = events[events.length - 1];
    events.push({
      kind: m.kind === "user" ? "user" : "tool",
      text: text.slice(0, 12_000),
      timestamp: m.timestamp,
      n: previous?.timestamp === m.timestamp ? previous.n + 1 : 0,
    });
  }
  return events;
}

const isNew = (e: Event, r: AssociationRecord) =>
  !r.lastProcessedAt ||
  e.timestamp > r.lastProcessedAt ||
  (e.timestamp === r.lastProcessedAt && e.n >= r.processedAtCount);

async function cacheRoot(generation: number): Promise<string | null> {
  try {
    const response = await commands.getCurrentProjectPath();
    return response.status === "ok" &&
      generation === getProjectScopeGeneration()
      ? response.data
      : null;
  } catch {
    return null;
  }
}

/** The single worktree whose directory or branch contains the ticket's short ID. */
function worktreeFor(ticketId: string | null, worktrees: readonly Worktree[]) {
  const short = ticketId?.slice(0, 8).toLowerCase();
  if (!short) return undefined;
  const matches = worktrees.filter(
    (w) =>
      w.path.split("/").pop()?.toLowerCase().includes(short) ||
      w.branch?.toLowerCase().includes(short)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function attach(record: AssociationRecord, worktree: Worktree | undefined) {
  if (!worktree) return;
  record.worktreePath = worktree.path;
  record.branch = worktree.branch;
  record.awaitingWorktree = null;
}

/**
 * Processes new user/tool events of one session in order, one request at a time,
 * until both a ticket and a worktree are known. User messages are asked whether
 * they request implementing a ticket or creating a worktree; a requested worktree
 * does not exist yet, so later tool events reveal it as a new Git worktree.
 * A failed decision is skipped with a diagnostic so later events still progress;
 * the next user message is the retry.
 */
export function useChatAssociation(sessionId: string) {
  const messages = useChatStore((s) => s.sessions[sessionId]?.messages);
  const root = useChatStore((s) => s.sessions[sessionId]?.projectPath) ?? "";
  const stored = useChatStore((s) => s.sessions[sessionId]?.association);
  const replayLoading = useChatStore(
    (s) => s.sessions[sessionId]?.providerReplay?.loading
  );
  const record = readRecord(stored);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const inflight = useRef<object | null>(null);

  const save = (next: AssociationRecord) =>
    useChatStore.getState().setSessionAssociation(sessionId, next);

  useEffect(() => {
    setDiagnostic(null);
    return () => {
      inflight.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!root || !messages || inflight.current || replayLoading === "initial")
      return;
    const pending = associationEvents(messages).filter((e) => isNew(e, record));
    const processed = (next: AssociationRecord, last: Event) => {
      next.lastProcessedAt = last.timestamp;
      next.processedAtCount = last.n + 1;
      save(next);
    };
    // Once the worktree is known only a user message can still add a ticket;
    // skip everything before the next event that can change the record.
    const needed = pending.findIndex(
      (e) => !record.worktreePath || (e.kind === "user" && !record.ticketId)
    );
    if (needed !== 0) {
      const last = pending[(needed < 0 ? pending.length : needed) - 1];
      if (last) processed({ ...record }, last);
      return;
    }
    const event = pending[0];

    const mine = {};
    inflight.current = mine;
    const lastUser = (list: readonly ChatMessage[] | undefined) =>
      list?.filter((m) => m.kind === "user").pop()?.timestamp;
    const userAtStart = lastUser(messages);

    void (async () => {
      let result: AssociationResult | null = null;
      let failure: string | null = null;
      const generation = getProjectScopeGeneration();
      const candidates: AssociationTicket[] =
        event.kind === "user" ? cachedAssociationCandidates(generation) : [];
      try {
        const response = await commands.resolveChatAssociation({
          project_root: root,
          event_kind: event.kind,
          text: event.text,
          candidates,
          candidate_project_root:
            event.kind === "user" ? await cacheRoot(generation) : null,
          ticket_id: record.ticketId,
          worktree_path: record.worktreePath,
        });
        if (response.status === "error") failure = response.error.message;
        else {
          result = response.data;
          failure = result.diagnostic;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      // Drop the result if the session changed, a correction replaced the record,
      // or a newer user message arrived; the event is then retried in order.
      const live = useChatStore.getState().sessions[sessionId];
      if (
        inflight.current !== mine ||
        lastUser(live?.messages) !== userAtStart
      ) {
        if (inflight.current === mine) inflight.current = null;
        setTick((t) => t + 1);
        return;
      }
      inflight.current = null;
      setDiagnostic(failure);
      const next = { ...readRecord(live?.association) };
      if (failure || !result) {
        // Skipped: a recurring failure must not stall later events.
      } else if (event.kind === "user") {
        const { selection } = result;
        const ticket =
          selection.kind === "ticket"
            ? candidates.find((t) => t.id === selection.id)
            : undefined;
        if (ticket && ticket.id !== next.ticketId) {
          Object.assign(next, {
            ticketId: ticket.id,
            ticketTitle: ticket.title,
          });
          attach(next, worktreeFor(ticket.id, next.recentWorktrees));
        }
        if (result.create_worktree && !next.worktreePath)
          next.awaitingWorktree = result.worktrees.map((w) => w.path);
      } else {
        const touched = result.worktrees;
        next.recentWorktrees = [
          ...next.recentWorktrees.filter(
            (w) => !touched.some((t) => t.path === w.path)
          ),
          ...touched,
        ].slice(-RECENT_WORKTREES);
        const awaiting = next.awaitingWorktree;
        const created = awaiting
          ? touched.filter((w) => !awaiting.includes(w.path))
          : [];
        attach(
          next,
          created.length === 1
            ? created[0]
            : worktreeFor(next.ticketId, awaiting ? created : touched)
        );
      }
      processed(next, event);
    })();
  }, [messages, root, replayLoading, record, tick, sessionId]);

  /** User intent: blank clears; otherwise one cached ticket matching a full or short ID. */
  const correct = (input: string) => {
    const id = input.trim().toLowerCase();
    const match = id
      ? cachedAssociationCandidates(getProjectScopeGeneration()).filter((t) =>
          t.id.startsWith(id)
        )
      : [];
    if (id && (id.length < 8 || match.length !== 1))
      throw new Error(
        "Enter one ticket ID from this project's cached tickets."
      );
    inflight.current = null; // an in-flight inference must not overwrite this
    setDiagnostic(null);
    const next = {
      ...record,
      ticketId: match[0]?.id ?? null,
      ticketTitle: match[0]?.title ?? null,
      worktreePath: null,
      branch: null,
    };
    attach(next, worktreeFor(next.ticketId, next.recentWorktrees));
    save(next);
    setTick((t) => t + 1);
  };

  return { record, diagnostic, correct };
}
