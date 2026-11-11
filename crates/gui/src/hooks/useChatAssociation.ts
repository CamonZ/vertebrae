import { useCallback, useEffect, useState } from "react";
import {
  commands,
  type AssociationResult,
  type AssociationEntity,
} from "../bindings";
import { useChatStore, type ChatMessage } from "../stores/chatStore";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { cachedAssociationCandidates } from "../utils/chatAssociation/candidates";

import { creationEvidence } from "../utils/chatAssociation/creation";

type Worktree = { path: string; branch: string | null };

/**
 * Tiny per-session record. `lastProcessedAt`/`processedAtCount` locate the newest
 * handled event (several events can share a timestamp). `awaitingWorktree` holds
 * the worktree paths that existed when the user asked to create one.
 */
export type AssociationRecord = {
  /** Legacy keys retained for existing saved conversations; may identify any level. */
  ticketId: string | null;
  entityLevel?: AssociationEntity["level"];
  ticketTitle: string | null;
  worktreePath: string | null;
  branch: string | null;
  lastProcessedAt: string | null;
  processedAtCount: number;
  awaitingWorktree: string[] | null;
  awaitingTicket?: { timestamp: string; n: number; generation: number } | null;
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

export function readRecord(value: unknown): AssociationRecord {
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
  if (
    !valid ||
    (v.entityLevel !== undefined &&
      !["epic", "ticket", "task"].includes(String(v.entityLevel)))
  )
    return EMPTY;
  if (v.awaitingTicket != null) {
    const pending = v.awaitingTicket as Record<string, unknown>;
    if (
      typeof pending !== "object" ||
      typeof pending.timestamp !== "string" ||
      !Number.isSafeInteger(pending.generation) ||
      !Number.isSafeInteger(pending.n) ||
      Number(pending.n) < 0
    )
      return EMPTY;
  }
  return v as AssociationRecord;
}

type Event = {
  kind: "user" | "tool" | "end";
  messageIndex: number;
  text: string;
  timestamp: string;
  n: number;
};

function associationEvents(messages: readonly ChatMessage[]): Event[] {
  const events: Event[] = [];
  for (const [messageIndex, m] of messages.entries()) {
    if ("parentToolUseId" in m && m.parentToolUseId) continue;
    // Assistant text never selects entities; tool output requires correlated creation evidence to select a ticket.
    const text =
      m.kind === "user"
        ? m.text
        : m.kind === "tool_call"
          ? m.input
          : m.kind === "tool_result" && !m.isError
            ? m.result
            : m.kind === "session_end"
              ? ""
              : null;
    if (text === null) continue;
    const previous = events[events.length - 1];
    events.push({
      kind:
        m.kind === "user" ? "user" : m.kind === "session_end" ? "end" : "tool",
      messageIndex,
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

/** The single worktree whose directory or branch contains the entity's short ID. */
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

/** In-flight decision per session; replaced or cleared to drop its result. */
const inflight = new Map<string, object>();

/**
 * Recording target last sent to each backend runtime: the value passed on
 * create, then every pushed change. Missing means never sent.
 */
const recordingTargets = new Map<string, string>();
const recordingKey = (path: string | null, branch: string | null) =>
  JSON.stringify([path, branch]);

/** Remember the target a runtime was created with, so it is not re-sent. */
export function noteRecordingTarget(
  backendSessionId: string,
  worktreePath: string | null,
  branch: string | null = null
) {
  recordingTargets.set(backendSessionId, recordingKey(worktreePath, branch));
}

/** Forget a runtime's target once the runtime is gone or never started. */
export function forgetRecordingTarget(backendSessionId: string) {
  recordingTargets.delete(backendSessionId);
}

/** Worktree a persisted association binds, for starting a runtime. */
export const associationRecordingTarget = (association: unknown) => {
  const { worktreePath, branch } = readRecord(association);
  return { worktreePath, branch };
};

const setDiagnostic = (sessionId: string, diagnostic: string | null) =>
  useChatStore
    .getState()
    .setSessionAssociationDiagnostic(sessionId, diagnostic);

/**
 * Processes new user/tool events of one session in order, one request at a time.
 * User messages may select an entity (discussing, implementing or tying it by
 * name or ID), tie an existing project worktree, or request a new worktree,
 * which does not exist yet, so later tool events reveal it as a new Git
 * worktree. Once both are known, tool events are skipped; pending ticket creation is
 * checked separately at turn completion. A failed or unresolved decision
 * keeps the record with a diagnostic so later events still progress; the next
 * user message is the retry. Mounted once per live or open session by the
 * global driver, so association keeps progressing without a chat window;
 * whenever the bound worktree changes, the live runtime records into it.
 */
export function useChatAssociationDriver(sessionId: string) {
  const messages = useChatStore((s) => s.sessions[sessionId]?.messages);
  const root = useChatStore((s) => s.sessions[sessionId]?.projectPath) ?? "";
  const stored = useChatStore((s) => s.sessions[sessionId]?.association);
  const replayLoading = useChatStore(
    (s) => s.sessions[sessionId]?.providerReplay?.loading
  );
  const backendSessionId = useChatStore(
    (s) => s.sessions[sessionId]?.backendSessionId ?? null
  );
  const lifecycle = useChatStore((s) => s.sessions[sessionId]?.lifecycle);
  const record = readRecord(stored);
  const [tick, setTick] = useState(0);

  const save = useCallback(
    (next: AssociationRecord) =>
      useChatStore.getState().setSessionAssociation(sessionId, next),
    [sessionId]
  );

  useEffect(
    () => () => {
      inflight.delete(sessionId);
    },
    [sessionId]
  );

  useEffect(() => {
    if (
      !root ||
      !messages ||
      inflight.has(sessionId) ||
      replayLoading === "initial"
    )
      return;
    const pending = associationEvents(messages).filter((e) => isNew(e, record));
    const processed = (next: AssociationRecord, last: Event) => {
      next.lastProcessedAt = last.timestamp;
      next.processedAtCount = last.n + 1;
      save(next);
    };
    // A known worktree needs only user decisions or a pending creation at turn
    // completion; skip everything before the next event that can change it.
    const needed = pending.findIndex(
      (e) =>
        e.kind === "user" ||
        (e.kind === "tool" && !record.worktreePath) ||
        (e.kind === "end" && !!record.awaitingTicket)
    );
    if (needed !== 0) {
      const last = pending[(needed < 0 ? pending.length : needed) - 1];
      if (last) processed({ ...record }, last);
      return;
    }

    const event = pending[0];

    const mine = {};
    inflight.set(sessionId, mine);
    const lastUser = (list: readonly ChatMessage[] | undefined) =>
      list?.filter((m) => m.kind === "user").pop();
    const userAtStart = lastUser(messages);

    void (async () => {
      let result: AssociationResult | null = null;
      let failure: string | null = null;
      let diagnostic: string | null = null;
      const generation = getProjectScopeGeneration();
      const attempt = crypto.randomUUID();
      const started = performance.now();
      const trace = (outcome: string) =>
        console.info("[chat_association]", {
          attempt,
          event: event.kind,
          generation,
          outcome,
          elapsed_ms: Math.round(performance.now() - started),
        });
      trace("request");
      const candidates: AssociationEntity[] =
        event.kind === "user" ? cachedAssociationCandidates(generation) : [];
      try {
        if (event.kind === "end") {
          result = {
            selection: { kind: "keep" },
            worktree: null,
            worktrees: [],
            create_worktree: false,
            create_ticket: false,
            diagnostic: null,
          };
          const origin = associationEvents(messages).find(
            (e) =>
              e.kind === "user" &&
              e.timestamp === record.awaitingTicket?.timestamp &&
              e.n === record.awaitingTicket.n
          );
          const end = messages[event.messageIndex];
          if (record.awaitingTicket?.generation !== generation)
            diagnostic =
              "Ticket creation detection retired after the project changed.";
          else if (end.kind !== "session_end" || end.successful !== true)
            diagnostic =
              "Ticket creation was not confirmed by a successful turn completion.";
          else if (
            origin &&
            !messages
              .slice(origin.messageIndex + 1)
              .some((m) => m.kind === "user")
          ) {
            const turnMessages = messages.slice(
              origin.messageIndex + 1,
              event.messageIndex
            );
            const evidence = await creationEvidence(turnMessages);

            diagnostic = evidence.diagnostic;

            if (evidence.id) {
              const entity = await commands.resolveChatAssociationEntity(
                root,
                evidence.id
              );

              if (entity.status === "error") failure = entity.error.message;
              else if (
                entity.data.id.toLowerCase() !== evidence.id ||
                entity.data.level !== "ticket"
              )
                diagnostic =
                  "The created ID is not an eligible ticket in this project.";
              else result.selection = { kind: "entity", ...entity.data };
            }
          }
        } else {
          const response = await commands.resolveChatAssociation({
            attempt_id: attempt,
            project_root: root,
            event_kind: event.kind,
            text: event.text,
            candidates,
            candidate_project_root:
              event.kind === "user" ? await cacheRoot(generation) : null,
            entity: record.ticketId
              ? {
                  id: record.ticketId,
                  title: record.ticketTitle ?? "",
                  level: record.entityLevel ?? "ticket",
                }
              : null,
            worktree_path: record.worktreePath,
          });

          if (response.status === "error") failure = response.error.message;
          else {
            result = response.data;
            diagnostic = result.diagnostic;
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      // Drop the result if the session changed, a correction replaced the record,
      // or a newer user message arrived; the event is then retried in order.
      const live = useChatStore.getState().sessions[sessionId];
      if (
        inflight.get(sessionId) !== mine ||
        generation !== getProjectScopeGeneration() ||
        live?.projectPath !== root ||
        live?.association !== stored ||
        lastUser(live?.messages) !== userAtStart
      ) {
        trace("stale_response");
        if (inflight.get(sessionId) === mine) inflight.delete(sessionId);
        setTick((t) => t + 1);
        return;
      }
      inflight.delete(sessionId);
      setDiagnostic(sessionId, failure ?? diagnostic);
      const next = { ...readRecord(live?.association) };
      if (event.kind === "end" || event.kind === "user")
        next.awaitingTicket = null;
      if (failure || !result) {
        // Skipped: a recurring failure must not stall later events.
      } else if (event.kind === "user" || event.kind === "end") {
        if (event.kind === "user" && result.create_ticket)
          next.awaitingTicket = {
            timestamp: event.timestamp,
            n: event.n,
            generation,
          };
        const { selection } = result;
        if (selection.kind === "entity" && !result.create_ticket) {
          // Replacing an entity never keeps its worktree or pending creation.
          if (next.ticketId && next.ticketId !== selection.id) {
            Object.assign(next, {
              worktreePath: null,
              branch: null,
              awaitingWorktree: null,
            });
          }
          Object.assign(next, {
            ticketId: selection.id,
            ticketTitle: selection.title,
            entityLevel: selection.level,
          });

          if (!next.worktreePath) {
            const matchingWorktree = worktreeFor(
              selection.id,
              next.recentWorktrees
            );
            attach(next, matchingWorktree);
          }
        }
        // An explicitly tied worktree never changes the entity.
        attach(next, result.worktree ?? undefined);
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
        const candidateWorktrees = awaiting ? created : touched;
        const matchingWorktree =
          created.length === 1
            ? created[0]
            : worktreeFor(next.ticketId, candidateWorktrees);

        attach(next, matchingWorktree);
      }
      trace(
        failure
          ? "failure"
          : next.worktreePath
            ? "worktree_bound"
            : event.kind === "tool"
              ? (result?.worktrees.length ?? 0) > 1
                ? "ambiguous_worktree"
                : "no_worktree_match"
              : result?.selection.kind === "unknown"
                ? "no_entity_match"
                : result?.selection.kind === "entity"
                  ? "entity_bound"
                  : "keep"
      );
      processed(next, event);
    })();
  }, [messages, root, replayLoading, record, tick, sessionId, save, stored]);

  const worktreePath = record.worktreePath;
  const intendedBranch = record.branch;
  // Targets are per runtime: drop the entry when the runtime or driver goes.
  useEffect(
    () => () => {
      if (backendSessionId) forgetRecordingTarget(backendSessionId);
    },
    [backendSessionId]
  );
  useEffect(() => {
    // A starting runtime receives its target with the create request.
    if (
      !backendSessionId ||
      lifecycle === "starting" ||
      lifecycle === "resuming"
    )
      return;
    const key = recordingKey(worktreePath, intendedBranch);
    if (recordingTargets.get(backendSessionId) === key) return;
    recordingTargets.set(backendSessionId, key);
    const generation = getProjectScopeGeneration();
    const isStale = () =>
      generation !== getProjectScopeGeneration() ||
      useChatStore.getState().sessions[sessionId]?.backendSessionId !==
        backendSessionId;
    void commands
      .setLocalChatRecordingWorktree(
        backendSessionId,
        worktreePath,
        intendedBranch
      )
      .then((result) => {
        if (isStale() || result.status === "ok") return;
        // Rejected by backend validation: retrying the same path cannot help.
        console.warn("[chat_association] recording target rejected", {
          sessionId,
          error: result.error,
        });
      })
      .catch((error: unknown) => {
        if (isStale()) return;
        // The request never completed; the next change re-sends it. No
        // immediate retry, so a persistent failure cannot loop.
        recordingTargets.delete(backendSessionId);
        console.warn("[chat_association] recording target failed", {
          sessionId,
          error,
        });
      });
  }, [backendSessionId, lifecycle, worktreePath, intendedBranch, sessionId]);
}

/** Blank clears; otherwise resolve one eligible entity in this session's project. */
export async function correctChatAssociation(sessionId: string, input: string) {
  const session = useChatStore.getState().sessions[sessionId];
  if (!session?.projectPath)
    throw new Error("The conversation has no project.");
  const mine = {};
  inflight.set(sessionId, mine);
  const correctedThrough = associationEvents(session.messages)
    .filter((event) => event.kind === "user")
    .at(-1);
  const id = input.trim().toLowerCase();
  let entity: AssociationEntity | null = null;
  try {
    if (id) {
      const response = await commands.resolveChatAssociationEntity(
        session.projectPath,
        id
      );
      if (response.status === "error") throw new Error(response.error.message);
      entity = response.data;
    }

    const live = useChatStore.getState().sessions[sessionId];
    if (
      inflight.get(sessionId) !== mine ||
      live?.projectPath !== session.projectPath
    )
      return;

    const record = readRecord(live.association);
    const next: AssociationRecord = {
      ...record,
      ticketId: entity?.id ?? null,
      ticketTitle: entity?.title ?? null,
      entityLevel: entity?.level,
      worktreePath: null,
      branch: null,
      awaitingWorktree: null,
      awaitingTicket: null,
    };

    // Manual intent supersedes earlier user messages, including any inference
    // we just retired. Later tool events must still reveal the worktree.
    if (correctedThrough && isNew(correctedThrough, record)) {
      next.lastProcessedAt = correctedThrough.timestamp;
      next.processedAtCount = correctedThrough.n + 1;
    }

    const matchingWorktree = worktreeFor(next.ticketId, next.recentWorktrees);
    attach(next, matchingWorktree);

    setDiagnostic(sessionId, null);
    useChatStore.getState().setSessionAssociation(sessionId, next);
  } finally {
    if (inflight.get(sessionId) === mine) inflight.delete(sessionId);
  }
}

/** The session's association record and diagnostic, as the driver keeps them. */
export function useChatAssociation(sessionId: string) {
  const stored = useChatStore((s) => s.sessions[sessionId]?.association);
  const diagnostic = useChatStore(
    (s) => s.sessions[sessionId]?.associationDiagnostic ?? null
  );
  const record = readRecord(stored);
  const correct = (input: string) => correctChatAssociation(sessionId, input);
  return { record, diagnostic, correct };
}
