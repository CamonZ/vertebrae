import type { SavedProject } from "../bindings";
import type { LocalChatSessionSummary } from "./localChatPersistence";
import { compareLocalChatSessionRecency } from "./localChatPersistence";

export const FALLBACK_CHAT_PROJECT_LABEL = "Unknown project";

export interface LocalChatSessionGroup {
  id: string;
  label: string;
  isCurrentProject: boolean;
  isFallback: boolean;
  sessions: LocalChatSessionSummary[];
}

/**
 * Normalize the value used by local-chat history search. Keeping this helper
 * independent from React makes the projection safe to reuse at any history
 * boundary and keeps whitespace-only queries equivalent to an empty query.
 */
export function normalizeLocalChatSessionQuery(query: unknown): string {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

/**
 * Resolve the title shown for a local-chat history row. Search must use this
 * same title-then-label display rule so a session cannot be found by text the
 * user does not see in the row.
 */
export function localChatSessionDisplayTitle(
  session: Pick<LocalChatSessionSummary, "title" | "label">
): string {
  const title = typeof session.title === "string" ? session.title.trim() : "";
  if (title) return title;

  const label = typeof session.label === "string" ? session.label.trim() : "";
  return label || "New Chat";
}

/**
 * Filter already-grouped local-chat history without changing group metadata,
 * group order, or the recency order established by the grouping projection.
 * A blank query returns the existing groups unchanged; a non-blank query
 * creates a new projection and removes groups that no longer contain rows.
 */
export function filterLocalChatSessionGroups(
  groups: LocalChatSessionGroup[],
  query: unknown
): LocalChatSessionGroup[] {
  const normalizedQuery = normalizeLocalChatSessionQuery(query);
  if (!normalizedQuery) return groups;

  return groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) =>
        localChatSessionDisplayTitle(session)
          .toLowerCase()
          .includes(normalizedQuery)
      ),
    }))
    .filter((group) => group.sessions.length > 0);
}

interface ResolvedProjectGroup {
  id: string;
  label: string;
  isCurrentProject: boolean;
  isFallback: boolean;
}

interface ProjectResolutionContext {
  projectsByPath: Map<string, SavedProject>;
  currentProjectPath: string | null;
}

function normalizeProjectPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;

  let normalized = trimmed;
  while (
    normalized.length > 1 &&
    /[\\/]$/.test(normalized) &&
    !/^[A-Za-z]:[\\/]$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function displayProjectName(project: SavedProject): string {
  const slug = project.slug.trim();
  if (slug) return slug;

  const normalizedPath = normalizeProjectPath(project.path);
  return normalizedPath?.split(/[\\/]/).filter(Boolean).pop() ?? "Project";
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
      isCurrentProject: false,
      isFallback: true,
    };
  }

  const slug = project.slug.trim() || normalizedPath;
  return {
    id: `project:${slug}`,
    label: displayProjectName(project),
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
