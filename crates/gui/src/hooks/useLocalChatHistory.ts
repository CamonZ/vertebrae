import { useCallback, useEffect, useMemo, useState } from "react";
import { commands } from "../bindings";
import type { SavedProject } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import {
  filterLocalChatSessionGroups,
  groupLocalChatSessionsByProject,
  type LocalChatSessionGroup,
} from "../utils/localChatSessionGroups";

export type ProjectLoadStatus = "idle" | "loaded" | "error";

export const PROJECT_LOAD_WARNING =
  "Could not load saved projects. Showing current project chats only.";

const EMPTY_SAVED_PROJECTS: SavedProject[] = [];

interface ProjectGroupingState {
  generation: number;
  currentProjectPath: string | null;
  projects: SavedProject[];
  projectsStatus: ProjectLoadStatus;
}

interface UseLocalChatHistoryResult {
  /** Resolve the current project path from the backend. Returns null on miss. */
  loadCurrentProjectPath: () => Promise<string | null>;
  /** Persist a freshly-resolved project path + scope generation. */
  commitCurrentProjectPath: (projectPath: string | null) => void;
  /** Grouped, project-scoped local chat summaries for the history views. */
  localSessionGroups: LocalChatSessionGroup[];
  /** Raw search query controlled by the expanded history surface. */
  sessionQuery: string;
  /** Update the expanded history search query. */
  setSessionQuery: (query: string) => void;
  /** Warning string shown when saved-project loading failed; null when ok. */
  projectGroupingWarning: string | null;
  /** Bump to force the grouping memo to re-read the local chat index after deletes. */
  bumpHistoryRevision: () => void;
}

interface UseLocalChatHistoryOptions {
  /**
   * Token that changes whenever the in-memory session map changes. Used as a
   * dep of the grouping memo so updates reflect immediately.
   */
  sessionChangeToken: string;
}

/**
 * Async project loading + session-history grouping for local chats. Tracks the
 * project-scope generation so a stale load (e.g. mid-switch) is discarded, and
 * keeps a manual revision counter so persisted-only deletes invalidate.
 */
export function useLocalChatHistory({
  sessionChangeToken,
}: UseLocalChatHistoryOptions): UseLocalChatHistoryResult {
  const listLocalSessions = useChatStore((s) => s.listLocalSessions);
  const hydrateLocalSessionIndex = useChatStore(
    (s) => s.hydrateLocalSessionIndex
  );
  const projectScopeGeneration = useProjectScopeGeneration();
  const [historyRevision, setHistoryRevision] = useState(0);
  const [sessionQuery, setSessionQuery] = useState("");
  const [projectGroupingState, setProjectGroupingState] =
    useState<ProjectGroupingState>({
      generation: -1,
      currentProjectPath: null,
      projects: [],
      projectsStatus: "idle",
    });

  const loadCurrentProjectPath = useCallback(async () => {
    try {
      const result = await commands.getCurrentProjectPath();
      return result.status === "ok" && result.data ? result.data : null;
    } catch {
      return null;
    }
  }, []);

  const loadSavedProjects = useCallback(async () => {
    try {
      const result = await commands.getProjects();
      if (result.status === "ok") {
        return { projects: result.data, status: "loaded" as const };
      }
      console.warn("Failed to load saved projects for chat grouping", result);
    } catch (error) {
      console.warn("Failed to load saved projects for chat grouping", error);
    }
    return { projects: [], status: "error" as const };
  }, []);

  useEffect(() => {
    void hydrateLocalSessionIndex();
  }, [hydrateLocalSessionIndex]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadCurrentProjectPath(), loadSavedProjects()]).then(
      ([currentProjectPath, projectLoad]) => {
        if (!cancelled) {
          setProjectGroupingState((state) => ({
            generation: projectScopeGeneration,
            currentProjectPath,
            projects:
              projectLoad.status === "loaded"
                ? projectLoad.projects
                : state.projects,
            projectsStatus: projectLoad.status,
          }));
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loadCurrentProjectPath, loadSavedProjects, projectScopeGeneration]);

  const commitCurrentProjectPath = useCallback(
    (projectPath: string | null) => {
      setProjectGroupingState((state) => ({
        generation: projectScopeGeneration,
        currentProjectPath: projectPath,
        projects: state.projects,
        projectsStatus: state.projectsStatus,
      }));
    },
    [projectScopeGeneration]
  );

  const currentProjectPath =
    projectGroupingState.generation === projectScopeGeneration
      ? projectGroupingState.currentProjectPath
      : null;
  const projectsLoadFailed =
    projectGroupingState.generation === projectScopeGeneration &&
    projectGroupingState.projectsStatus === "error";
  const savedProjects =
    projectGroupingState.generation === projectScopeGeneration
      ? projectGroupingState.projects
      : EMPTY_SAVED_PROJECTS;

  const localSessionGroups = useMemo(() => {
    // Persisted-only deletes need a React-side invalidation even when the
    // in-memory session map is unchanged.
    void historyRevision;
    const summaries = listLocalSessions(
      projectsLoadFailed ? currentProjectPath : undefined
    );
    if (!sessionChangeToken && summaries.length === 0) return [];
    return filterLocalChatSessionGroups(
      groupLocalChatSessionsByProject(
        summaries,
        savedProjects,
        currentProjectPath
      ),
      sessionQuery
    );
  }, [
    currentProjectPath,
    historyRevision,
    listLocalSessions,
    projectsLoadFailed,
    savedProjects,
    sessionQuery,
    sessionChangeToken,
  ]);

  const projectGroupingWarning = projectsLoadFailed
    ? PROJECT_LOAD_WARNING
    : null;

  const bumpHistoryRevision = useCallback(
    () => setHistoryRevision((revision) => revision + 1),
    []
  );

  return {
    loadCurrentProjectPath,
    commitCurrentProjectPath,
    localSessionGroups,
    sessionQuery,
    setSessionQuery,
    projectGroupingWarning,
    bumpHistoryRevision,
  };
}
