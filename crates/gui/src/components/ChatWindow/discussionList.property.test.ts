import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { MappedReviewThread, ReviewMappingStatus } from "../../bindings";
import type { DiffCommentHome } from "./assistantTextComments";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";
import { parsePatch } from "../thread/toolChange/diffLineMapper";
import {
  captureCodeSelection,
  discussionList,
  drawnOn,
  SelectionDiscussions,
  THREAD_PLACES,
  type SelectionThread,
  type ThreadPlace,
} from "./selectionDiscussions";

/*
 * The side column's Discussions invariant (db5160ff, criterion 3): through
 * any sequence of new threads, catalog refreshes (the anchors re-mapped
 * against the current Changes) and removals,
 *
 * - every thread is listed exactly once, and the count is the list length;
 * - each is grouped where it is drawn, in creation order: detached first;
 * - Changes draws exactly the threads grouped "In Changes", and a Changes
 *   thread is never drawn on a tool call's patch in the transcript.
 *
 * A GitHub thread's private discussion (3e4d738d) is always grouped under
 * GitHub threads, never drawn at an anchor of its own and never moved by a
 * mapping; revealing it opens it and asks Changes for its GitHub thread (a
 * thread sent without a discussion is asked for without opening anything),
 * and every discussion keeps its unsent draft through close and reopen
 * until it is removed.
 *
 * The model derives each thread's place from the mapping it last received,
 * not from the controller's statuses.
 */

const file = parsePatch(
  "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,3 @@\n-old\n+one\n+two\n+three\n"
)[0];
/** Lines 1–3 are changed rows of `a`; 4–5 are outside its hunk. */
const ROWS = 3;
const snapshot: WorktreeSnapshot = { wholeBranch: true, files: [file] };

type Kind = "worktree" | "tool" | "file" | "github";
const KINDS: Kind[] = ["worktree", "tool", "file", "github"];
const githubId = (id: string) => `PRRT_${id}`;
const TOOL_USE = "tu-1";

function thread(id: string, kind: Kind): SelectionThread {
  const home: DiffCommentHome =
    kind === "tool"
      ? { kind: "tool_call", toolUseId: TOOL_USE }
      : { kind: "worktree", wholeBranch: true };
  const captured = captureCodeSelection(
    file,
    { start: 1, end: 1, side: "additions" },
    home
  )!;
  const anchor =
    kind === "file"
      ? { ...captured, fullFile: { checkout: "/w", turn: null } }
      : captured;
  return {
    id,
    anchor,
    status: { kind: "inline" },
    git: {
      original: anchor,
      capture: { originalBlobId: "blob", originalCommitId: "commit" },
    },
    outdatedNoted: false,
    sessionId: null,
    githubThreadId: kind === "github" ? githubId(id) : null,
  };
}

/** Where a freshly asked thread of `kind` is drawn. */
const HOME_PLACE: Record<Kind, ThreadPlace> = {
  worktree: "changes",
  tool: "transcript",
  file: "document",
  github: "github",
};

/** Where a mapping puts a thread; tool-call threads are not re-mapped. */
function mappedPlace(
  kind: Kind,
  status: ReviewMappingStatus,
  line: number
): ThreadPlace {
  if (kind === "tool") return "transcript";
  if (kind === "github") return "github";
  if (status !== "open") return "detached";
  if (kind === "file") return "document";
  return line <= ROWS ? "changes" : "detached";
}

interface Machine {
  controller: SelectionDiscussions;
  next: number;
  /** Model: live threads in creation order, with their kind and place. */
  live: { id: string; kind: Kind; place: ThreadPlace }[];
  /** Model: unsent drafts by thread. */
  drafts: Map<string, string>;
  /** Model: the open discussion and the GitHub thread Changes was asked to show. */
  activeId: string | null;
  reveal: string | null;
}

const machine: hegel.stateful.StateMachine<Machine> = {
  rules: {
    add: (tc, m) => {
      const id = `t${m.next++}`;
      const kind = tc.draw(gs.sampledFrom<Kind>(KINDS));
      m.controller.restore([thread(id, kind)]);
      m.live.push({ id, kind, place: HOME_PLACE[kind] });
    },
    refresh: (tc, m) => {
      tc.assume(m.live.length > 0);
      // A catalog refresh maps some of the threads against the snapshot.
      const mappings: MappedReviewThread[] = [];
      for (const entry of m.live) {
        if (!tc.draw(gs.booleans())) continue;
        const status = tc.draw(
          gs.sampledFrom<ReviewMappingStatus>([
            "open",
            "outdated",
            "unavailable",
          ])
        );
        const line = tc.draw(gs.integers({ minValue: 1, maxValue: ROWS + 2 }));
        mappings.push({ threadId: entry.id, startLine: line, line, status });
        entry.place = mappedPlace(entry.kind, status, line);
      }
      m.controller.reconcile(snapshot);
      m.controller.applyMappings(snapshot, mappings);
    },
    remove: (tc, m) => {
      tc.assume(m.live.length > 0);
      const index = tc.draw(
        gs.integers({ minValue: 0, maxValue: m.live.length - 1 })
      );
      const { id } = m.live[index];
      m.controller.remove(id);
      m.live.splice(index, 1);
      m.drafts.delete(id);
      if (m.activeId === id) m.activeId = null;
      expect(m.controller.draft(id)).toBe("");
    },
    draft: (tc, m) => {
      tc.assume(m.live.length > 0);
      const { id } = tc.draw(gs.sampledFrom(m.live));
      const text = tc.draw(gs.sampledFrom(["", "why?", "and here"]));
      m.controller.setDraft(id, text);
      if (text) m.drafts.set(id, text);
      else m.drafts.delete(id);
    },
    open: (tc, m) => {
      tc.assume(m.live.length > 0);
      const { id } = tc.draw(gs.sampledFrom(m.live));
      m.controller.reopen(id);
      m.activeId = id;
    },
    close: (_tc, m) => {
      m.controller.reopen(null);
      m.activeId = null;
    },
    reveal: (tc, m) => {
      tc.assume(m.live.length > 0);
      const { id, kind } = tc.draw(gs.sampledFrom(m.live));
      m.controller.reveal(id);
      // Only a GitHub thread's discussion is shown with another thread.
      if (kind === "github") {
        m.activeId = id;
        m.reveal = githubId(id);
      }
    },
    revealGithub: (tc, m) => {
      // A thread sent without discussion: shown, nothing opened.
      const id = tc.draw(gs.sampledFrom(["PRRT_sent", "PRRT_other"]));
      m.controller.revealGithub(id);
      m.reveal = id;
    },
    revealed: (tc, m) => {
      const pending = m.controller.getSnapshot().reveal;
      tc.assume(pending !== null);
      m.controller.revealed(pending!.nonce + 1);
      expect(m.controller.getSnapshot().reveal).toEqual(pending);
      m.controller.revealed(pending!.nonce);
      m.reveal = null;
    },
  },
  invariants: {
    listedOnceWhereDrawn: {
      alwaysCheck: true,
      check: (_tc, m) => {
        const { threads } = m.controller.getSnapshot();
        const groups = discussionList(threads);
        const listed = THREAD_PLACES.flatMap((place) =>
          groups[place].map((t) => t.id)
        );

        expect(threads).toHaveLength(m.live.length);
        expect(listed).toHaveLength(threads.length);
        for (const place of THREAD_PLACES)
          expect(groups[place].map((t) => t.id)).toEqual(
            m.live
              .filter((entry) => entry.place === place)
              .map((entry) => entry.id)
          );
      },
    },
    draftsAndRevealKept: {
      alwaysCheck: true,
      check: (_tc, m) => {
        const state = m.controller.getSnapshot();
        expect(state.activeId).toBe(m.activeId);
        expect(state.reveal?.githubThreadId ?? null).toBe(m.reveal);
        for (const { id, kind } of m.live) {
          expect(m.controller.draft(id)).toBe(m.drafts.get(id) ?? "");
          if (kind === "github")
            expect(m.controller.forGithubThread(githubId(id))?.id).toBe(id);
        }
      },
    },
    drawnWhereGrouped: {
      alwaysCheck: true,
      check: (_tc, m) => {
        const anchors = m.controller.getAnchors();
        const drawn = m.live.filter((entry) => entry.kind !== "github");
        expect(anchors.map((a) => a.id)).toEqual(
          drawn.map((entry) => entry.id)
        );
        for (const [i, anchor] of anchors.entries()) {
          const { place } = drawn[i];
          expect(drawnOn(anchor, { kind: "worktree" })).toBe(
            place === "changes"
          );
          expect(
            drawnOn(anchor, { kind: "tool_call", toolUseId: TOOL_USE })
          ).toBe(place === "transcript");
          expect(
            drawnOn(anchor, { kind: "tool_call", toolUseId: "other" })
          ).toBe(false);
        }
      },
    },
  },
};

test(
  "Discussions lists every thread once where it is drawn, and Changes draws only its own",
  () =>
    hegel.test(
      (tc) => {
        hegel.stateful.run(tc, machine, {
          controller: new SelectionDiscussions(),
          next: 0,
          live: [],
          drafts: new Map(),
          activeId: null,
          reveal: null,
        });
      },
      { testCases: 100 }
    ),
  // Stateful cases run ~20 ms each, several times that under a full run.
  30_000
);
