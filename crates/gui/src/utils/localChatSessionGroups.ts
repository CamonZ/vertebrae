import type { SavedProject } from "../bindings";
import type { LocalChatSessionSummary } from "./localChatPersistence";
import {
  compareLocalChatSessionRecency,
  normalizeProjectPath,
} from "./localChatPersistence";

export const FALLBACK_CHAT_PROJECT_LABEL = "Unknown project";
export const LOCAL_CHAT_SESSION_ROW_LIMIT = 7;

/**
 * Returns a stable, filesystem-safe label from the project path captured by a
 * local chat session. This deliberately does not consult the active project
 * or the current working directory.
 */
export function localChatSessionProjectDisplayName(
  projectPath: string | null | undefined
): string {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath || !isAbsoluteProjectPath(normalizedPath)) {
    return FALLBACK_CHAT_PROJECT_LABEL;
  }

  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  const name = segments[segments.length - 1];
  return name && !/^[A-Za-z]:$/.test(name) ? name : FALLBACK_CHAT_PROJECT_LABEL;
}

function isAbsoluteProjectPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

export interface LocalChatSessionGroup {
  id: string;
  label: string;
  /** Stable saved-project identity represented by this group, when known. */
  projectId: string | null;
  /** Project directory captured from the saved-project record, when known. */
  projectPath: string | null;
  isCurrentProject: boolean;
  isFallback: boolean;
  sessions: LocalChatSessionSummary[];
  /** Full source rows retained by a capped projection for future expansion. */
  allSessions?: LocalChatSessionSummary[];
}

export function normalizeLocalChatSessionQuery(query: unknown): string {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

/** Search must use the same title-then-label display rule as the session row. */
export function localChatSessionDisplayTitle(
  session: Pick<LocalChatSessionSummary, "title" | "label">
): string {
  const title = typeof session.title === "string" ? session.title.trim() : "";
  if (title) return title;

  const label = typeof session.label === "string" ? session.label.trim() : "";
  return label || "New Chat";
}

/**
 * Filters before any display cap while preserving group/session ordering and
 * removing groups that no longer contain matching rows.
 */
export function filterLocalChatSessionGroups(
  groups: LocalChatSessionGroup[],
  query: unknown
): LocalChatSessionGroup[] {
  const normalizedQuery = normalizeLocalChatSessionQuery(query);
  if (!normalizedQuery) return groups;

  return groups
    .map((group) => {
      const sourceSessions = group.allSessions ?? group.sessions;
      const sessions = sourceSessions.filter((session) =>
        localChatSessionDisplayTitle(session)
          .toLowerCase()
          .includes(normalizedQuery)
      );
      return {
        ...group,
        sessions,
        ...(group.allSessions ? { allSessions: sessions } : {}),
      };
    })
    .filter((group) => group.sessions.length > 0);
}

/**
 * Projects already-grouped, already-filtered sessions into the default row
 * view without changing their established ordering.
 */
export function projectLocalChatSessionGroups(
  groups: LocalChatSessionGroup[]
): LocalChatSessionGroup[] {
  return groups
    .map((group) => {
      const allSessions = [...(group.allSessions ?? group.sessions)];
      return {
        ...group,
        sessions: allSessions.slice(0, LOCAL_CHAT_SESSION_ROW_LIMIT),
        allSessions,
      };
    })
    .filter((group) => group.sessions.length > 0);
}

interface ResolvedProjectGroup {
  id: string;
  label: string;
  projectId: string | null;
  projectPath: string | null;
  isCurrentProject: boolean;
  isFallback: boolean;
}

interface ProjectResolutionContext {
  projectsByPath: Map<string, SavedProject>;
  currentProjectPath: string | null;
}

export function savedProjectDisplayName(project: SavedProject): string {
  const slug = project.slug.trim();
  if (slug) return slug;

  const pathLabel = localChatSessionProjectDisplayName(project.path);
  return pathLabel === FALLBACK_CHAT_PROJECT_LABEL ? "Project" : pathLabel;
}

function buildProjectLookup(
  projects: SavedProject[]
): Map<string, SavedProject> {
  const lookup = new Map<string, SavedProject>();
  for (const project of projects) {
    const normalizedPath = normalizeProjectPath(project.path);
    if (normalizedPath) lookup.set(normalizedPath, project);
  }
  return lookup;
}

function buildProjectResolutionContext(
  projects: SavedProject[],
  currentProjectPath: string | null
): ProjectResolutionContext {
  return {
    projectsByPath: buildProjectLookup(projects),
    currentProjectPath: normalizeProjectPath(currentProjectPath),
  };
}

function resolveLocalChatSessionProject(
  projectPath: string | null | undefined,
  context: ProjectResolutionContext
): ResolvedProjectGroup {
  const normalizedPath = normalizeProjectPath(projectPath);
  const project = normalizedPath
    ? context.projectsByPath.get(normalizedPath)
    : null;

  if (!project || !normalizedPath) {
    return {
      id: "fallback",
      label: FALLBACK_CHAT_PROJECT_LABEL,
      projectId: null,
      projectPath: null,
      isCurrentProject: false,
      isFallback: true,
    };
  }

  const slug = project.slug.trim() || normalizedPath;
  return {
    id: `project:${slug}`,
    label: savedProjectDisplayName(project),
    projectId: project.project_id,
    projectPath: normalizedPath,
    isCurrentProject: normalizedPath === context.currentProjectPath,
    isFallback: false,
  };
}

export function groupLocalChatSessionsByProject(
  sessions: LocalChatSessionSummary[],
  projects: SavedProject[],
  currentProjectPath: string | null
): LocalChatSessionGroup[] {
  const context = buildProjectResolutionContext(projects, currentProjectPath);
  const groups = new Map<string, LocalChatSessionGroup>();

  for (const session of sessions) {
    const baseGroup = resolveLocalChatSessionProject(
      session.projectPath,
      context
    );
    const group = groups.get(baseGroup.id) ?? {
      ...baseGroup,
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(group.id, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort(compareLocalChatSessionRecency),
    }))
    .filter((group) => group.sessions.length > 0)
    .sort((a, b) => {
      if (a.isCurrentProject !== b.isCurrentProject) {
        return a.isCurrentProject ? -1 : 1;
      }
      if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;

      const aNewest = a.sessions[0];
      const bNewest = b.sessions[0];
      if (!aNewest || !bNewest) return b.sessions.length - a.sessions.length;

      const newestDelta = compareLocalChatSessionRecency(aNewest, bNewest);
      if (newestDelta !== 0) return newestDelta;

      return a.label.localeCompare(b.label);
    });
}
