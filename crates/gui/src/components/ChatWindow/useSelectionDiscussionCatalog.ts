import { useCallback, useEffect, useRef } from "react";
import { commands, events, type ReviewThread } from "../../bindings";
import { unwrapCommand } from "../../query/commandResult";
import { useChatStore } from "../../stores/chatStore";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../../stores/projectScopedStores";
import {
  findDiscussionSession,
  matchesDiscussion,
  placeWorktreeDiscussions,
  readSavedDiscussion,
} from "./restoreSelectionDiscussions";
import { reviewLocation, reviewRange, unwrapAnchor } from "./reviewAnchors";
import {
  mappedPosition,
  samePosition,
  SelectionDiscussionPositions,
  type PositionWrite,
} from "./selectionDiscussionPositions";
import { SelectionDiscussionCatalogRows } from "./selectionDiscussionCatalogRows";
import type { SelectionDiscussions } from "./selectionDiscussions";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";

interface Options {
  controller: SelectionDiscussions;
  projectPath?: string | null;
  parentChatId?: string;
  worktreePath: string;
  report(error: unknown): void;
  reportMapping(error: unknown | null): void;
}

export function useSelectionDiscussionCatalog({
  controller,
  projectPath,
  parentChatId,
  worktreePath,
  report,
  reportMapping,
}: Options) {
  const generation = useProjectScopeGeneration();
  const snapshot = useRef<WorktreeSnapshot | null>(null);
  const scope = useRef<{
    reconcile(next: WorktreeSnapshot, changed: boolean): void;
    noteWriter(): ((threadId: string) => Promise<void>) | undefined;
  }>(null);

  useEffect(() => {
    if (!parentChatId || !projectPath || !worktreePath) return;
    const parent = parentChatId;
    const binding = { projectPath, parentChatId, worktreePath };
    let disposed = false;
    let listening = true;
    let indexLoaded = false;
    let projectId: string | undefined;
    let refreshVersion = 0;
    let snapshotVersion = 0;
    const rows = new SelectionDiscussionCatalogRows();
    const snippets = new Map<string, Promise<string>>();
    const positions = new SelectionDiscussionPositions();
    const release: (() => void)[] = [];
    const current = () =>
      !disposed && generation === getProjectScopeGeneration();
    const reportCurrent = (error: unknown) => {
      if (current()) report(error);
    };

    function map(next: WorktreeSnapshot, ids?: ReadonlySet<string>) {
      if (!ids) snapshotVersion++;
      const version = snapshotVersion;
      const requests = controller
        .getSnapshot()
        .threads.flatMap(({ id, git, status }) =>
          git.original.home.kind === "worktree" &&
          status.kind !== "unreadable" &&
          (!ids || ids.has(id))
            ? [
                {
                  threadId: id,
                  ...git.capture,
                  range: reviewRange(git.original),
                  location: reviewLocation(
                    git.original,
                    parent,
                    next.comparison
                  ),
                },
              ]
            : []
        );
      if (!requests.length) return;
      void unwrapAnchor(commands.mapReviewThreads(worktreePath, requests))
        .then((positions) => {
          if (!current() || version !== snapshotVersion) return;
          const live = positions.filter(
            ({ threadId }) => !rows.isDeleted(threadId)
          );
          controller.applyMappings(next, live);
          reportMapping(null);
          for (const { threadId } of live) savePosition(threadId);
        })
        .catch((error: unknown) => {
          if (current() && version === snapshotVersion) reportMapping(error);
        });
    }

    function savePosition(id: string) {
      const stored = rows.row(id)?.payload;
      const thread = controller.thread(id);
      if (!projectId || !stored || !thread) return;
      const write = positions.stage(id, stored, mappedPosition(thread));
      if (write) void persistPosition(projectId, id, write);
    }

    async function persistPosition(
      project: string,
      id: string,
      write: PositionWrite
    ) {
      let succeeded = false;
      try {
        await unwrapCommand(
          commands.putReviewThread(project, id, {
            kind: "position",
            position: write.position,
          })
        );
        succeeded = true;
      } catch (error) {
        reportCurrent(error);
      } finally {
        const stored = rows.row(id)?.payload;
        if (current() && stored) {
          const next = positions.finish(id, stored, write, succeeded);
          if (next) void persistPosition(project, id, next);
        }
      }
    }

    const projectLookup = (async () => {
      const projects = await unwrapCommand(commands.getProjects());
      return projects.find(({ path }) => path === projectPath)?.project_id;
    })();

    scope.current = {
      reconcile(next, changed) {
        map(next);
        if (!changed) return;
        for (const thread of controller.getSnapshot().threads) {
          const row = rows.row(thread.id);
          if (row && thread.status.kind === "unreadable") observe(row);
        }
      },
      noteWriter() {
        return async (id) => {
          try {
            const project = await projectLookup;
            if (!project)
              throw new Error(
                "Could not find the project for the outdated discussion note."
              );
            await unwrapCommand(
              commands.putReviewThread(project, id, { kind: "outdated_note" })
            );
          } catch (error) {
            reportCurrent(error);
          }
        };
      },
    };

    async function apply(row: ReviewThread) {
      const id = row.threadId;
      if (rows.isDeleted(id) || row.payload.parentChatId !== parent) return;
      const previous = rows.row(id);
      const previousThread = controller.thread(id);
      if (
        previous &&
        (previous.revision > row.revision ||
          (previous.revision === row.revision &&
            samePosition(previous.payload, row.payload) &&
            previous.payload.outdatedNoted === row.payload.outdatedNoted &&
            previous.checkoutPath === row.checkoutPath &&
            previousThread &&
            previousThread.status.kind !== "unreadable"))
      ) {
        const session = findDiscussionSession(
          Object.values(useChatStore.getState().sessions),
          binding,
          id
        );
        if (session && previousThread && !previousThread.sessionId)
          controller.sent(id, session.id, false);
        return;
      }
      const preservePending = positions.preservesProjection(id);
      positions.observe(id, row.payload);
      rows.set(row);
      const sessions = Object.values(useChatStore.getState().sessions);
      const record = await readSavedDiscussion(
        row,
        binding,
        sessions,
        snippets
      );
      if (!record || !current() || rows.row(id) !== row) return;
      const [restored] = placeWorktreeDiscussions([record], snapshot.current);
      const latest = controller.thread(id);
      // A late acknowledgment must not roll back the latest local mapping.
      const preserveProjection =
        latest &&
        latest.status.kind !== "unreadable" &&
        !record.readError &&
        (preservePending ||
          (previous && samePosition(previous.payload, row.payload)));
      controller.restore([
        preserveProjection
          ? { ...restored, anchor: latest.anchor, status: latest.status }
          : restored,
      ]);
      return (
        !record.readError && (!previous || latest?.status.kind === "unreadable")
      );
    }

    function observe(row: ReviewThread) {
      void apply(row)
        .then((needsMapping) => {
          if (needsMapping && current() && snapshot.current)
            map(snapshot.current, new Set([row.threadId]));
        })
        .catch(reportCurrent);
    }

    async function refresh() {
      if (!projectId) return;
      const request = ++refreshVersion;
      const started = rows.checkpoint();
      const saved = await unwrapCommand(commands.listReviewThreads(projectId));
      if (!current() || refreshVersion !== request) return;
      const restored = await Promise.all(
        saved
          .filter(({ threadId }) => rows.includesSnapshotRow(threadId, started))
          .map(async (row) => {
            try {
              return (await apply(row)) ? row.threadId : null;
            } catch (error) {
              reportCurrent(error);
              return null;
            }
          })
      );
      if (current() && refreshVersion === request && snapshot.current) {
        map(snapshot.current, new Set(restored.filter((id) => id !== null)));
      }
    }

    function retire(id: string) {
      if (rows.isDeleted(id)) return;
      rows.delete(id);
      positions.remove(id);
      snippets.delete(id);
      controller.remove(id);
      const store = useChatStore.getState();
      const sessions = Object.values(store.sessions).filter((session) =>
        matchesDiscussion(session, binding, id)
      );
      for (const session of sessions) {
        if (session.backendSessionId) {
          void commands
            .closeLocalChatSession(session.backendSessionId)
            .then((result) => {
              if (
                result.status === "error" &&
                !("SessionNotFound" in result.error)
              )
                reportCurrent(
                  new Error("Could not close the deleted discussion process.")
                );
            })
            .catch(reportCurrent);
        }
        store.closeSession(session.id);
      }
    }

    const stopListening = () => {
      listening = false;
      release.splice(0).forEach((unlisten) => {
        try {
          unlisten();
        } catch (error) {
          reportCurrent(error);
        }
      });
    };
    const register = async (subscription: Promise<() => void>) => {
      const unlisten = await subscription;
      if (current() && listening) release.push(unlisten);
      else unlisten();
    };

    void (async () => {
      projectId = await projectLookup;
      if (!current()) return;
      if (!projectId) return;
      try {
        await Promise.all([
          register(
            events.reviewThreadChanged.listen(({ payload }) => {
              if (!current() || !listening || payload.projectId !== projectId)
                return;
              if (
                payload.thread &&
                payload.thread.payload.parentChatId !== parent
              )
                return;
              if (payload.thread) {
                rows.recordEvent(payload.threadId);
                observe(payload.thread);
              } else retire(payload.threadId);
            })
          ),
          register(
            events.reviewThreadCatalogRecovered.listen(({ payload }) => {
              if (
                current() &&
                listening &&
                indexLoaded &&
                payload.projectId === projectId
              )
                void refresh().catch(reportCurrent);
            })
          ),
        ]);
      } catch (error) {
        stopListening();
        reportCurrent(error);
      }
      if (!current()) return;
      // Hydration can emit recovery. The initial listing below includes it.
      await useChatStore.getState().hydrateLocalSessionIndex({
        isCurrent: current,
        include: (session) =>
          matchesDiscussion(session, binding) &&
          !rows.isDeleted(session.discussion.reviewThreadId),
      });
      indexLoaded = true;
      if (current()) await refresh();
    })().catch(reportCurrent);

    return () => {
      disposed = true;
      scope.current = null;
      stopListening();
    };
  }, [
    controller,
    generation,
    parentChatId,
    projectPath,
    report,
    reportMapping,
    worktreePath,
  ]);

  const mapSnapshot = useCallback((next: WorktreeSnapshot) => {
    const changed = snapshot.current !== next;
    snapshot.current = next;
    scope.current?.reconcile(next, changed);
  }, []);
  const noteWriter = useCallback(() => scope.current?.noteWriter(), []);
  const comparison = useCallback(() => snapshot.current?.comparison, []);
  return { mapSnapshot, noteWriter, comparison };
}
