import { useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../bindings";
import { providerReplayErrorMessage } from "../stores/providerReplay";
import type { LocalChatHarnessKind } from "../bindings";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
  paneSessionIds,
  providerThreadSessionId,
} from "../stores/chatStore";
import { isLocalChatSessionCleared } from "../utils/localChatPersistence";
import type { SpawnOutlineItem } from "../components/ChatWindow/sessionListUtils";

// Tauri invokes cannot be aborted. Serialize command ownership across close/open
// and Strict Mode rechecks; a retired queued request never starts native work.
let discoveryTail: Promise<unknown> = Promise.resolve();
function discoverWhenCurrent(
  input: Parameters<typeof commands.discoverLocalChatChildSessions>[0],
  retired: () => boolean
) {
  const result = discoveryTail.then(() =>
    retired() ? null : commands.discoverLocalChatChildSessions(input)
  );
  discoveryTail = result.catch(() => {});
  return result;
}

// Discovery rows are in ancestor-first order. Suppress a deleted branch even
// when its deeper IDs have not yet been found by background deletion.
function visibleChildRows(
  rows: SpawnOutlineItem[],
  harness: LocalChatHarnessKind
) {
  const blocked = new Set<string>();
  const deleted = (thread: string) =>
    blocked.has(thread) ||
    isLocalChatSessionCleared(providerThreadSessionId(harness, thread));
  return rows.filter((row) => {
    if (
      (row.threadId && deleted(row.threadId)) ||
      (row.parentThreadId && deleted(row.parentThreadId))
    ) {
      if (row.threadId) blocked.add(row.threadId);
      return false;
    }
    return true;
  });
}

/** Discovers provider-owned child conversations. Refreshes are single-flight;
 * only visible child conversations request transcript replay. */
export function useChildChatSessions(
  sessionToken: string,
  enabled: boolean
): ReadonlyMap<string, SpawnOutlineItem[]> {
  const [outlines, setOutlines] = useState<Map<string, SpawnOutlineItem[]>>(
    () => new Map()
  );

  const previousBusy = useRef(new Set<string>());
  const wake = useRef<() => void>(() => {});
  const liveToken = useChatStore(
    (state) =>
      Object.values(state.sessions)
        .map((session) =>
          session.providerChild
            ? `${session.id}:${session.providerChild.active}:${session.providerChild.turnId}`
            : `${session.id}:${session.providerChildrenStopped ?? false}:${getLocalChatLifecycle(session)}:${session.providerResumeId}`
        )
        .join("\0") +
      `:${state.activeSessionId}:${paneSessionIds(state.paneLayout.panes).join(",")}`
  );

  useEffect(() => {
    wake.current();
  }, [sessionToken, liveToken]);

  useEffect(() => {
    if (!enabled) return;

    let retired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let pendingWake = false;
    let failures = 0;
    const reportedFailures = new Set<string>();

    const diagnostic = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);

      if (!reportedFailures.has(message) && reportedFailures.size < 64) {
        console.warn("Could not discover child chat sessions", error);
        reportedFailures.add(message);
      }
    };

    const refresh = async () => {
      if (running || retired) return;
      running = true;

      try {
        const stateAtStart = useChatStore.getState();
        const selected = new Set(
          paneSessionIds(stateAtStart.paneLayout.panes)
        );
        if (stateAtStart.activeSessionId)
          selected.add(stateAtStart.activeSessionId);
        // Selecting a child also refreshes its owner so sibling/terminal evidence
        // is retained. Idle history is discovered only when selected again.
        for (const id of [...selected]) {
          const owner =
            stateAtStart.sessions[id]?.providerChild?.ownerSessionId;
          if (owner) selected.add(owner);
        }
        const busyIds = new Set(
          Object.values(stateAtStart.sessions)
            .filter(
              (session) =>
                session.providerChild?.active === true ||
                isLocalChatLifecycleBusy(getLocalChatLifecycle(session))
            )
            .map(
              (session) => session.providerChild?.ownerSessionId ?? session.id
            )
        );
        const sessions = Object.values(stateAtStart.sessions).filter(
          (session) =>
            session.status === "open" &&
            !!session.providerResumeId &&
            (selected.has(session.id) ||
              busyIds.has(session.id) ||
              previousBusy.current.has(session.id))
        );
        previousBusy.current = busyIds;

        let discoveryFailed = false;
        const liveAtStart = new Map(
          Object.values(stateAtStart.sessions).map((session) => [
            session.id,
            session.updatedAt,
          ])
        );
        const next = new Map<string, SpawnOutlineItem[]>();
        const discovered = new Map<string, Promise<SpawnOutlineItem[]>>();

        const visit = (
          harness: LocalChatHarnessKind,
          resumeId: string,
          projectPath: string | null | undefined,
          ancestors: ReadonlySet<string>
        ): Promise<SpawnOutlineItem[]> => {
          const key = `${harness}:${resumeId}`;

          if (
            ancestors.has(key) ||
            retired ||
            isLocalChatSessionCleared(
              providerThreadSessionId(harness, resumeId)
            )
          )
            return Promise.resolve([]);

          const cached = discovered.get(key);
          if (cached) return cached;

          if (discovered.size >= 256 || ancestors.size >= 32)
            return Promise.reject(
              new Error("Child discovery exceeds its conversation/depth budget")
            );

          const pending = (async () => {
            const result = await discoverWhenCurrent(
              {
                session_id: key,
                harness,
                provider_resume_id: resumeId,
                project_path: projectPath ?? null,
                created_at: null,
                cursor: null,
                limit: null,
              },
              () => retired
            );

            if (retired || !result) return [];
            if (result.status === "error")
              throw new Error(providerReplayErrorMessage(result.error));

            if (result.data.length > 2048)
              throw new Error("Child discovery exceeds its row budget");
            const rows: SpawnOutlineItem[] = [];
            const lineage = new Set([...ancestors, key]);

            for (const child of result.data) {
              if (
                isLocalChatSessionCleared(
                  providerThreadSessionId(harness, child.provider_resume_id)
                ) ||
                isLocalChatSessionCleared(
                  providerThreadSessionId(harness, resumeId)
                ) ||
                lineage.has(`${harness}:${child.provider_resume_id}`)
              )
                continue;

              if (rows.length >= 2048)
                throw new Error("Child discovery exceeds its row budget");
              rows.push({
                id: `${harness}:${child.provider_resume_id}`,
                spawnId: child.spawn_tool_call_id ?? child.provider_resume_id,
                threadId: child.provider_resume_id,
                parentThreadId: resumeId,
                label: child.label,
                detail: "",
                ...(child.is_active === null
                  ? {}
                  : { isWorking: child.is_active }),
                depth: 0,
              });

              try {
                const nested = await visit(
                  harness,
                  child.provider_resume_id,
                  projectPath,
                  lineage
                );
                if (rows.length + nested.length > 2048)
                  throw new Error("Child discovery exceeds its row budget");
                rows.push(
                  ...nested.map((row) => ({
                    ...row,
                    depth: (row.depth ?? 0) + 1,
                  }))
                );
              } catch (error) {
                discoveryFailed = true;
                diagnostic(error);
              }
            }
            return rows;
          })();

          discovered.set(key, pending);
          return pending;
        };

        for (const session of sessions) {
          if (retired) return;

          try {
            const rows = await visit(
              session.harness,
              session.providerResumeId!,
              session.projectPath,
              new Set()
            );

            const current = useChatStore.getState().sessions[session.id];
            if (
              !current ||
              current.providerResumeId !== session.providerResumeId ||
              current.harness !== session.harness ||
              current.projectPath !== session.projectPath
            )
              continue;

            const visibleRows = visibleChildRows(rows, session.harness);
            next.set(session.id, visibleRows);
            for (const row of visibleRows) {
              if (!row.threadId) continue;
              const childId = useChatStore
                .getState()
                .ensureProviderThreadSession({
                  harness: session.harness,
                  providerResumeId: row.threadId,
                  projectPath: session.projectPath,
                  providerId: session.providerId,
                  label: row.label,
                  ownerSessionId: session.id,
                  providerParentResumeId: row.parentThreadId,
                });
              const child = useChatStore.getState().sessions[childId];

              // Claude terminal evidence may arrive only in persisted task
              // notifications/metadata. Do not overwrite live work that arrived
              // while this older discovery request was in flight.
              if (
                row.isWorking === false &&
                child?.providerChild?.active === true &&
                liveAtStart.has(childId) &&
                child.updatedAt === liveAtStart.get(childId)
              ) {
                useChatStore
                  .getState()
                  .setProviderChildActivity(childId, false);
              }
            }
          } catch (error) {
            discoveryFailed = true;
            diagnostic(error);
          }
        }

        if (retired) return;

        setOutlines((previous) => {
          const merged = new Map(previous);
          for (const [id, rows] of next) {
            merged.delete(id);
            merged.set(id, rows);
          }
          for (const id of merged.keys()) {
            if (!useChatStore.getState().sessions[id]) merged.delete(id);
          }
          // Detailed snapshots are expendable: persisted child lineage in the
          // store/history projection preserves older outlines after eviction.
          let retainedBytes = 0;
          let retainedEntries = 0;
          for (const [id, rows] of [...merged].reverse()) {
            const bytes = JSON.stringify(rows).length * 2;
            if (
              retainedEntries >= 128 ||
              retainedBytes + bytes > 8 * 1024 * 1024
            )
              merged.delete(id);
            else {
              retainedBytes += bytes;
              retainedEntries += 1;
            }
          }
          return JSON.stringify([...merged]) === JSON.stringify([...previous])
            ? previous
            : merged;
        });

        const state = useChatStore.getState();

        for (const paneSessionId of paneSessionIds(state.paneLayout.panes)) {
          const selected = state.sessions[paneSessionId];
          if (!selected?.providerResumeId) continue;

          // Refresh terminal transitions too: final output may have landed since
          // the preceding poll. Store paging owns revision invalidation.
          const child = [...next.values()]
            .flat()
            .some((row) => row.threadId === selected.providerResumeId);
          const ownerId = selected.providerChild?.ownerSessionId;
          const owner = ownerId ? state.sessions[ownerId] : null;
          const needsAssignment = !selected.messages.some(
            (message) => message.kind === "user"
          );

          if (
            child &&
            !selected.backendSessionId &&
            (!owner?.backendSessionId ||
              !selected.providerReplay?.loaded ||
              needsAssignment)
          )
            state.refreshProviderThreadSession(selected.id);
        }

        failures = discoveryFailed ? Math.min(failures + 1, 5) : 0;

        if (!discoveryFailed) reportedFailures.clear();

        const busy =
          busyIds.size > 0 ||
          sessions.some((session) =>
            isLocalChatLifecycleBusy(getLocalChatLifecycle(session))
          ) ||
          [...next.values()].some((rows) => rows.some((row) => row.isWorking));

        const delay = discoveryFailed
          ? Math.min(3000 * 2 ** (failures - 1), 30000)
          : busy
            ? 3000
            : 15000;

        timer = setTimeout(() => void refresh(), delay);
      } finally {
        running = false;
        if (pendingWake && !retired) {
          pendingWake = false;
          clearTimeout(timer);
          timer = setTimeout(() => void refresh(), 0);
        }
      }
    };

    // Metadata/activity changes wake the existing owner; they never retire an
    // in-flight request merely because another streamed message arrived.
    wake.current = () => {
      if (retired) return;
      if (running) {
        pendingWake = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 0);
    };

    void refresh();

    return () => {
      retired = true;
      wake.current = () => {};
      clearTimeout(timer);
    };
  }, [enabled]);

  return useMemo(() => {
    void liveToken;
    const sessions = useChatStore.getState().sessions;
    const merged = new Map(
      [...outlines]
        .filter(([id]) => !!sessions[id])
        .map(([id, rows]) => [id, visibleChildRows(rows, sessions[id].harness)])
    );

    for (const session of Object.values(useChatStore.getState().sessions)) {
      const child = session.providerChild;

      if (!child || !session.providerResumeId) continue;
      const rows = merged.get(child.ownerSessionId) ?? [];
      const index = rows.findIndex(
        (row) => row.threadId === session.providerResumeId
      );

      if (index >= 0)
        rows[index] = {
          ...rows[index],
          isWorking: child.active ?? rows[index].isWorking,
        };
      else
        rows.push({
          id: session.id,
          spawnId: session.providerResumeId,
          threadId: session.providerResumeId,
          label: session.title || session.label,
          detail: "",
          isWorking: child.active === true,
        });

      merged.set(child.ownerSessionId, rows);
    }

    return merged;
  }, [outlines, liveToken]);
}
