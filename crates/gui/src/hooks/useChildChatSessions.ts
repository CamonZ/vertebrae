import { useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../bindings";
import { providerReplayErrorMessage } from "../stores/providerReplay";
import type { LocalChatHarnessKind } from "../bindings";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
} from "../stores/chatStore";
import type { SpawnOutlineItem } from "../components/ChatWindow/sessionListUtils";

/** Discovers provider-owned child conversations. Refreshes are single-flight;
 * only visible child conversations request transcript replay. */
export function useChildChatSessions(
  sessionToken: string,
  enabled: boolean
): ReadonlyMap<string, SpawnOutlineItem[]> {
  const [outlines, setOutlines] = useState<Map<string, SpawnOutlineItem[]>>(
    () => new Map()
  );
  const wake = useRef<() => void>(() => {});
  const liveToken = useChatStore((state) =>
    Object.values(state.sessions)
      .map((session) =>
        session.providerChild
          ? `${session.id}:${session.providerChild.active}:${session.providerChild.turnId}`
          : `${session.id}:${session.providerChildrenStopped ?? false}`
      )
      .join("\0")
  );
  useEffect(() => {
    wake.current();
  }, [sessionToken, liveToken]);
  useEffect(() => {
    if (!enabled) return;
    let retired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
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
        const sessions = Object.values(useChatStore.getState().sessions).filter(
          (session) => session.status === "open" && !!session.providerResumeId
        );
        let discoveryFailed = false;
        const liveAtStart = new Map(
          sessions.map((session) => [session.id, session.updatedAt])
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
          if (ancestors.has(key) || retired) return Promise.resolve([]);
          const cached = discovered.get(key);
          if (cached) return cached;
          const pending = (async () => {
            const result = await commands.discoverLocalChatChildSessions({
              session_id: key,
              harness,
              provider_resume_id: resumeId,
              project_path: projectPath ?? null,
              created_at: null,
              cursor: null,
              limit: null,
            });
            if (retired) return [];
            if (result.status === "error")
              throw new Error(providerReplayErrorMessage(result.error));
            const rows: SpawnOutlineItem[] = [];
            const lineage = new Set([...ancestors, key]);
            for (const child of result.data) {
              if (lineage.has(`${harness}:${child.provider_resume_id}`))
                continue;
              rows.push({
                id: `${harness}:${child.provider_resume_id}`,
                spawnId: child.spawn_tool_call_id ?? child.provider_resume_id,
                threadId: child.provider_resume_id,
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
            next.set(session.id, rows);
            for (const row of rows) {
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
                });
              const child = useChatStore.getState().sessions[childId];
              // Claude terminal evidence may arrive only in persisted task
              // notifications/metadata. Do not overwrite live work that arrived
              // while this older discovery request was in flight.
              if (
                row.isWorking === false &&
                child.providerChild?.active === true &&
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
          for (const [id, rows] of next) merged.set(id, rows);
          for (const id of merged.keys()) {
            if (!sessions.some((session) => session.id === id))
              merged.delete(id);
          }
          return JSON.stringify([...merged]) === JSON.stringify([...previous])
            ? previous
            : merged;
        });
        const state = useChatStore.getState();
        for (const pane of state.paneLayout.panes) {
          const selected = state.sessions[pane.sessionId];
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
          Object.values(useChatStore.getState().sessions).some(
            (session) => session.providerChild?.active === true
          ) ||
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
      }
    };
    // Metadata/activity changes wake the existing owner; they never retire an
    // in-flight request merely because another streamed message arrived.
    wake.current = () => {
      if (running || retired) return;
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
    const merged = new Map([...outlines].map(([id, rows]) => [id, [...rows]]));
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
