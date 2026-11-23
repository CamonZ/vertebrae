import { useMemo, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useLocalChatProjectHistory } from "../../hooks/useLocalChatProjectHistory";
import {
  filterLocalChatSessionGroups,
  groupLocalChatSessionsByTicket,
  type LocalChatSessionGroup,
} from "../../utils/localChatSessionGroups";
import {
  buildHistoryChildOutlines,
  buildSessionChildOutline,
  type SpawnOutlineItem,
} from "./sessionListUtils";

/** Load state of the selected project's history read, for the sidebar. */
export interface HistoryLoadState {
  isError: boolean;
  isFetching: boolean;
  retry: () => void;
}

/**
 * The maximized sidebar's view of the selected project: catalog-filtered rows,
 * their child outlines and the completed-chat preference.
 */
export function useHistorySidebarModel({
  visible,
  selectedProject,
  historyProjectGroups,
  sessionList,
  spawnOutlineToken,
  discoveredChildOutlines,
  sessionQuery,
}: {
  visible: boolean;
  selectedProject: LocalChatSessionGroup | undefined;
  historyProjectGroups: LocalChatSessionGroup[];
  sessionList: string[];
  /** Changes when an open session's agent tool calls change. */
  spawnOutlineToken: string;
  discoveredChildOutlines: ReadonlyMap<string, SpawnOutlineItem[]>;
  sessionQuery: string;
}) {
  // Sidebar-only, mount-scoped preference. Filtering never closes a pane or
  // stops runtime work.
  const [showCompletedHistory, setShowCompletedHistory] = useState(false);
  const history = useLocalChatProjectHistory({
    projectId: selectedProject?.projectId ?? null,
    projectPath: selectedProject?.projectPath ?? null,
    visible,
    includeCompleted: showCompletedHistory,
  });
  const { excludedIds } = history;

  const visibleHistoryProject = useMemo(() => {
    if (!selectedProject) return undefined;
    const shown = (session: { id: string }) => !excludedIds.has(session.id);
    return {
      ...selectedProject,
      sessions: selectedProject.sessions.filter(shown),
      ...(selectedProject.allSessions && {
        allSessions: selectedProject.allSessions.filter(shown),
      }),
    };
  }, [selectedProject, excludedIds]);
  const visibleHistoryGroups = useMemo(
    () =>
      historyProjectGroups.map((group) =>
        group.id === visibleHistoryProject?.id ? visibleHistoryProject : group
      ),
    [historyProjectGroups, visibleHistoryProject]
  );

  const hiddenSessions = useMemo(
    () =>
      selectedProject?.sessions.filter((session) =>
        excludedIds.has(session.id)
      ) ?? [],
    [selectedProject, excludedIds]
  );
  const hiddenCompletedCount = useMemo(
    () =>
      selectedProject && hiddenSessions.length
        ? filterLocalChatSessionGroups(
            [{ ...selectedProject, sessions: hiddenSessions, allSessions: undefined }],
            sessionQuery
          ).flatMap((group) => group.sessions).length
        : 0,
    [selectedProject, hiddenSessions, sessionQuery]
  );
  const hiddenThreads = useMemo(
    () =>
      new Set(
        hiddenSessions.flatMap((session) =>
          session.providerResumeId
            ? [`${session.harness}:${session.providerResumeId}`]
            : []
        )
      ),
    [hiddenSessions]
  );

  const historyChildOutlines = useMemo(
    () => buildHistoryChildOutlines(visibleHistoryProject?.sessions ?? []),
    [visibleHistoryProject]
  );

  const spawnOutlineBySessionId = useMemo(() => {
    const outlines = new Map(historyChildOutlines);
    for (const sessionId of sessionList) {
      const session = useChatStore.getState().sessions[sessionId];
      if (!session) continue;
      outlines.set(
        session.id,
        buildSessionChildOutline(
          session,
          discoveredChildOutlines.get(session.id) ?? [],
          historyChildOutlines.get(session.id) ?? [],
          hiddenThreads
        )
      );
    }
    return outlines;
    // Intentionally keyed by top-level agent tool-call inputs only; assistant
    // streaming text should not re-render the mini-panel outline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionList,
    spawnOutlineToken,
    discoveredChildOutlines,
    hiddenThreads,
    historyChildOutlines,
  ]);

  const childProviderThreadIds = useMemo(
    () =>
      new Set(
        [...spawnOutlineBySessionId.values()].flatMap((outline) =>
          outline.flatMap((spawn) => (spawn.threadId ? [spawn.threadId] : []))
        )
      ),
    [spawnOutlineBySessionId]
  );

  const nestedHistoryIds = useMemo(
    () =>
      new Set(
        [...historyChildOutlines.values()].flatMap((outline) =>
          outline.flatMap((row) => (row.sessionId ? [row.sessionId] : []))
        )
      ),
    [historyChildOutlines]
  );

  const matchingHistorySessions = useMemo(
    () =>
      groupLocalChatSessionsByTicket(
        filterLocalChatSessionGroups(
          visibleHistoryProject ? [visibleHistoryProject] : [],
          sessionQuery,
          childProviderThreadIds,
          nestedHistoryIds
        ).flatMap((group) => group.sessions)
      ).flatMap((group) => group.sessions),
    [visibleHistoryProject, sessionQuery, childProviderThreadIds, nestedHistoryIds]
  );

  const historyLoad: HistoryLoadState = useMemo(
    () => ({
      isError: history.isError,
      isFetching: history.isFetching,
      retry: history.retry,
    }),
    [history.isError, history.isFetching, history.retry]
  );

  return {
    visibleHistoryGroups,
    spawnOutlineBySessionId,
    childProviderThreadIds,
    nestedHistoryIds,
    matchingHistorySessions,
    completedHistoryIds: history.completedIds,
    hiddenCompletedCount: showCompletedHistory ? 0 : hiddenCompletedCount,
    showCompletedHistory,
    setShowCompletedHistory,
    historyLoad,
  };
}
