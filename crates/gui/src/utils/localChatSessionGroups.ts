import type { SavedProject, Task, TaskRun } from "../bindings";
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
  query: unknown,
  excludedProviderThreadIds?: ReadonlySet<string>
): LocalChatSessionGroup[] {
  const normalizedQuery = normalizeLocalChatSessionQuery(query);

  if (!normalizedQuery && !excludedProviderThreadIds) return groups;

  return groups
    .map((group) => {
      const sourceSessions = group.allSessions ?? group.sessions;
      const byThread = new Map(
        sourceSessions
          .filter((session) => session.providerResumeId)
          .map((session) => [
            `${session.harness}:${session.providerResumeId}`,
            session,
          ])
      );

      const matches = new Set<string>();

      for (const session of sourceSessions) {
        if (
          !localChatSessionDisplayTitle(session)
            .toLowerCase()
            .includes(normalizedQuery)
        )
          continue;

        let row: LocalChatSessionSummary | undefined = session;
        while (row && !matches.has(row.id)) {
          matches.add(row.id);
          row = byThread.get(`${row.harness}:${row.providerParentResumeId}`);
        }
      }

      const sessions = sourceSessions.filter(
        (session) =>
          matches.has(session.id) &&
          (!session.providerResumeId ||
            !excludedProviderThreadIds?.has(session.providerResumeId))
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
  currentProjectPath: string | null,
  includeEmptyProjects = false
): LocalChatSessionGroup[] {
  const context = buildProjectResolutionContext(projects, currentProjectPath);
  const groups = new Map<string, LocalChatSessionGroup>();

  if (includeEmptyProjects) {
    for (const project of projects) {
      const group = resolveLocalChatSessionProject(project.path, context);
      groups.set(group.id, { ...group, sessions: [] });
    }
  }

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
    .filter((group) => includeEmptyProjects || group.sessions.length > 0)
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

/** The legacy ticketId field holds epic, ticket and task UUIDs. */
export function localChatSessionTaskId(
  session: LocalChatSessionSummary
): string | null {
  const association = session.association;

  if (
    !association ||
    typeof association !== "object" ||
    Array.isArray(association)
  )
    return null;

  return typeof association.ticketId === "string" && association.ticketId.trim()
    ? association.ticketId
    : null;
}

/** A durable TaskRun listed in history under its task's group. */
export interface LocalChatRunRow {
  /** TaskRun id. */
  id: string;
  taskId: string;
  run: TaskRun;
  /** Row label; the task title is the group label. */
  label: string;
  /** Last activity used to order rows alongside sessions. */
  updatedAt: string;
  completed: boolean;
}

export interface LocalChatTicketGroup {
  id: string;
  ticketId: string | null;
  entityLevel?: "epic" | "task";
  label: string;
  sessions: LocalChatSessionSummary[];
  runs?: LocalChatRunRow[];
  children?: LocalChatTicketGroup[];
}

function timestampMs(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newestGroupActivity(group: LocalChatTicketGroup): number {
  return Math.max(
    0,
    ...group.sessions.map((session) => timestampMs(session.updatedAt)),
    ...(group.runs ?? []).map((run) => timestampMs(run.updatedAt))
  );
}

/** A group's sessions and runs interleaved newest first (sessions win ties). */
export function localChatGroupRows(
  group: Pick<LocalChatTicketGroup, "sessions" | "runs">
): (
  | { kind: "session"; session: LocalChatSessionSummary }
  | { kind: "run"; run: LocalChatRunRow }
)[] {
  const rows = [
    ...group.sessions.map((session) => ({
      kind: "session" as const,
      session,
      at: timestampMs(session.updatedAt),
    })),
    ...(group.runs ?? []).map((run) => ({
      kind: "run" as const,
      run,
      at: timestampMs(run.updatedAt),
    })),
  ];
  // Stable sort keeps the existing session order among equal timestamps.
  return rows
    .sort((a, b) => b.at - a.at)
    .map((row) =>
      row.kind === "session"
        ? { kind: row.kind, session: row.session }
        : { kind: row.kind, run: row.run }
    );
}

/** Preserve recency within groups and collect unassociated chats after tickets. */
export function groupLocalChatSessionsByTicket(
  sessions: LocalChatSessionSummary[]
): LocalChatTicketGroup[] {
  const groups = new Map<string, LocalChatTicketGroup>();

  for (const session of sessions) {
    const association = session.association;
    const record =
      association &&
      typeof association === "object" &&
      !Array.isArray(association)
        ? association
        : null;

    const ticketId =
      typeof record?.ticketId === "string" && record.ticketId.trim()
        ? record.ticketId
        : null;

    const id = ticketId ? `ticket:${ticketId}` : "ungrouped";
    const title =
      typeof record?.ticketTitle === "string" ? record.ticketTitle.trim() : "";
    const group = groups.get(id) ?? {
      id,
      label: ticketId ? title || ticketId : "Other chats",
      ticketId,
      ...(record?.entityLevel === "epic" || record?.entityLevel === "task"
        ? { entityLevel: record.entityLevel }
        : {}),
      sessions: [],
    };

    // Another association can supply a title missing from the first row.
    if (ticketId && title && group.label === ticketId) group.label = title;

    group.sessions.push(session);
    groups.set(id, group);
  }

  const ungrouped = groups.get("ungrouped");
  groups.delete("ungrouped");

  return [...groups.values(), ...(ungrouped ? [ungrouped] : [])];
}

/** Build only ancestors of visible rows, preserving first-seen sibling recency.
 * Missing metadata leaves a UUID-labelled ancestor; cycles stop at the last
 * valid edge so no conversation can disappear into an unreachable group.
 * Inputs must belong to one project (as selected by the project grouping).
 */
export function groupLocalChatSessionsByHierarchy(
  sessions: LocalChatSessionSummary[],
  tasks: ReadonlyMap<
    string,
    Pick<Task, "id" | "title" | "level" | "parent_id">
  >,
  runs: readonly LocalChatRunRow[] = []
): LocalChatTicketGroup[] {
  const groups = new Map<string, LocalChatTicketGroup>();
  const parentById = new Map<string, string>();
  const direct = groupLocalChatSessionsByTicket(sessions).map((group) => ({
    ...group,
  }));
  const ungroupedIndex = direct.findIndex((group) => !group.ticketId);
  const ungrouped = ungroupedIndex >= 0 ? direct.splice(ungroupedIndex, 1) : [];

  // Runs join their task's group, creating it when no chat is associated.
  for (const run of runs) {
    const id = `ticket:${run.taskId}`;
    let group = direct.find((candidate) => candidate.id === id);
    if (!group) {
      group = { id, ticketId: run.taskId, label: run.taskId, sessions: [] };
      direct.push(group);
    }
    group.runs = [...(group.runs ?? []), run];
  }
  // Order groups by their newest session or run, as rows are within a group.
  if (runs.length)
    direct.sort((a, b) => newestGroupActivity(b) - newestGroupActivity(a));
  direct.push(...ungrouped);

  for (const group of direct) groups.set(group.id, { ...group, children: [] });

  for (const group of direct) {
    let id = group.ticketId;
    const visited = new Set<string>();

    while (id) {
      visited.add(id);

      const metadata = tasks.get(id);
      const node = groups.get(`ticket:${id}`)!;

      if (metadata) {
        node.label = metadata.title.trim() || node.label;

        if (metadata.level === "epic" || metadata.level === "task")
          node.entityLevel = metadata.level;
        else delete node.entityLevel;
      }

      const parentId = metadata?.parent_id;
      if (!parentId || visited.has(parentId)) break;

      const parentGroupId = `ticket:${parentId}`;

      if (!groups.has(parentGroupId)) {
        groups.set(parentGroupId, {
          id: parentGroupId,
          ticketId: parentId,
          label: parentId,
          sessions: [],
          children: [],
        });
      }

      // Detect edges already established by another starting entity as well.
      let ancestor: string | undefined = parentId;
      const chain = new Set([id]);

      while (ancestor && !chain.has(ancestor)) {
        chain.add(ancestor);
        ancestor = parentById.get(ancestor);
      }

      if (ancestor) break;

      parentById.set(id, parentId);
      id = parentId;
    }
  }

  const roots: LocalChatTicketGroup[] = [];

  for (const group of groups.values()) {
    const parentId = group.ticketId && parentById.get(group.ticketId);

    if (parentId) {
      const parent = groups.get(`ticket:${parentId}`)!;

      parent.children!.push(group);
    } else if (group.ticketId) {
      roots.push(group);
    }
  }

  // Ancestors are created after the groups that reach them; order every
  // level by its newest descendant so a recent run surfaces its epic.
  if (runs.length) {
    const newest = new Map<LocalChatTicketGroup, number>();
    const activity = (group: LocalChatTicketGroup): number => {
      const known = newest.get(group);
      if (known !== undefined) return known;
      const value = Math.max(
        newestGroupActivity(group),
        ...(group.children ?? []).map(activity)
      );
      newest.set(group, value);
      return value;
    };
    const byActivity = (a: LocalChatTicketGroup, b: LocalChatTicketGroup) =>
      activity(b) - activity(a);
    for (const group of groups.values()) group.children?.sort(byActivity);
    roots.sort(byActivity);
  }

  const other = groups.get("ungrouped");

  return [...roots, ...(other ? [other] : [])];
}

/** Preorder groups; consumers render each group's children before its rows. */
export function flattenLocalChatTicketGroups(
  groups: LocalChatTicketGroup[]
): LocalChatTicketGroup[] {
  return groups.flatMap((group) => [
    group,
    ...flattenLocalChatTicketGroups(group.children ?? []),
  ]);
}

export function selectedLocalChatProject(
  groups: LocalChatSessionGroup[],
  selectedId: string | null,
  activeSessionId: string | null,
  activeProjectPath?: string | null
): LocalChatSessionGroup | undefined {
  return (
    groups.find((group) => group.id === selectedId) ??
    groups.find((group) =>
      (group.allSessions ?? group.sessions).some(
        (session) => session.id === activeSessionId
      )
    ) ??
    groups.find(
      (group) =>
        activeProjectPath &&
        group.projectPath === normalizeProjectPath(activeProjectPath)
    ) ??
    groups.find((group) => group.isCurrentProject) ??
    groups[0]
  );
}
