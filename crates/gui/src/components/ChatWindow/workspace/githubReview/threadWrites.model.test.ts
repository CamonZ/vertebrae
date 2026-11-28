/**
 * Thread writes against a synthetic GitHub. The landed check is tested
 * against GitHub's own application of a write (`applyThreadWrite`): a write
 * applied shows as landed, one not applied as absent, and threads that
 * cannot tell say so. The drafts store is driven by random user actions
 * while GitHub answers each write at random (posted, 403, a transient
 * failure, a timeout that did or did not apply), and must:
 *
 * - send only from Post or Retry, the draft's text, at most its plan;
 * - keep the draft whenever a post fails, and close it once posted;
 * - after reply and resolve whose resolve failed, keep the posted reply
 *   and offer only the resolve again;
 * - never retry a 403, and never post twice after a timeout that landed;
 * - treat a send that threw (before or after GitHub applied it) as a
 *   timeout, and never stay pending when the port throws;
 * - finish a reply and resolve whose reply landed with the resolve, even
 *   when the text was changed or cleared before the retry;
 * - bring a discarded draft back with Undo;
 * - report each thread a comment started once.
 */
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type {
  GithubFailure,
  GithubPrReviewThreads,
  GithubReviewThread,
  GithubThreadWrite,
} from "../../../../bindings";
import { applyThreadWrite, reviewThread } from "./fixture";
import {
  ThreadWrites,
  commentSlot,
  landed,
  matching,
  replySlot,
  type WritePlan,
  type WritePort,
} from "./threadWrites";

const VIEWER = "octo-viewer";
const BODIES = ["Fixed.", "Thanks!", "Looks right", "Fixed.  "];

const prThreads = (
  threads: GithubReviewThread[],
  viewerLogin: string | null = VIEWER,
  truncated = false
): GithubPrReviewThreads => ({
  repo: "example/demo-repo",
  prNumber: 7,
  viewerLogin,
  headOid: "1".repeat(40),
  baseOid: "2".repeat(40),
  threads,
  truncated,
});

const failure = (kind: GithubFailure["kind"]): GithubFailure => ({
  kind,
  message: `${kind} from GitHub`,
  retryAfterSecs: null,
});

const drawThreads = (tc: hegel.TestCase) =>
  ["PRRT_a", "PRRT_b"].map((id) =>
    reviewThread(id, {
      resolved: tc.draw(gs.booleans()),
      line: tc.draw(gs.sampledFrom([13, 20])),
      author: tc.draw(gs.sampledFrom([VIEWER, "alice"])),
      body: tc.draw(gs.sampledFrom(BODIES)),
    })
  );

const drawWrite = (tc: hegel.TestCase): GithubThreadWrite => {
  const threadId = tc.draw(gs.sampledFrom(["PRRT_a", "PRRT_b"]));
  const body = tc.draw(gs.sampledFrom(BODIES)).trim();
  switch (tc.draw(gs.sampledFrom(["reply", "resolve", "reopen", "start"]))) {
    case "reply":
      return { kind: "reply", threadId, body };
    case "resolve":
      return { kind: "resolve", threadId };
    case "reopen":
      return { kind: "reopen", threadId };
    default:
      return {
        kind: "start",
        path: "src/lib.rs",
        side: tc.draw(gs.sampledFrom(["LEFT", "RIGHT"] as const)),
        startLine: null,
        line: tc.draw(gs.sampledFrom([13, 20])),
        body,
      };
  }
};

describe("whether a write landed", () => {
  it("agrees with GitHub applying it, and says unknown when the threads cannot tell", () =>
    hegel.test(
      (tc) => {
        const threads = drawThreads(tc);
        const write = drawWrite(tc);
        const viewer = tc.draw(gs.sampledFrom([VIEWER, null]));
        const truncated = tc.draw(gs.booleans());
        const before = matching(prThreads(threads, viewer, truncated), write);
        const after = prThreads(
          applyThreadWrite(threads, write, VIEWER, "PRRT_new"),
          viewer,
          truncated
        );
        const unchanged = prThreads(threads, viewer, truncated);
        const toggle = write.kind === "resolve" || write.kind === "reopen";
        const blind =
          !toggle && (viewer === null || (write.kind === "start" && truncated));
        if (blind) {
          expect(before).toBeNull();
          expect(landed(after, write, before)).toEqual({ kind: "unknown" });
          return;
        }
        expect(landed(unchanged, write, before)).toEqual({ kind: "absent" });
        const target = threads.find(
          ({ id }) => write.kind !== "start" && id === write.threadId
        );
        // Resolving a resolved thread (or reopening an open one) changes
        // nothing GitHub shows.
        const noop = toggle && target?.resolved === (write.kind === "resolve");
        expect(landed(after, write, before)).toEqual(
          noop
            ? { kind: "absent" }
            : {
                kind: "landed",
                threadId: write.kind === "start" ? "PRRT_new" : write.threadId,
              }
        );
      },
      { testCases: 300 }
    ));
});

type Answer =
  | "posted"
  | "forbidden"
  | "transient"
  | "timeout_applied"
  | "timeout_lost"
  | "threw_applied"
  | "threw_lost";

const ANSWERS: Answer[] = [
  "posted",
  "forbidden",
  "transient",
  "timeout_applied",
  "timeout_lost",
  "threw_applied",
  "threw_lost",
];

const REPLY = replySlot("PRRT_a");
const COMMENT = commentSlot("discussion-1");
const PLACE = {
  path: "src/lib.rs",
  side: "RIGHT" as const,
  startLine: null,
  line: 20,
};

const sameWrite = (left: GithubThreadWrite, right: GithubThreadWrite) =>
  JSON.stringify(left) === JSON.stringify(right);

describe("the drafts store against GitHub", () => {
  it("resolves after a reply whose timeout landed, though the text was cleared", async () => {
    let github = [reviewThread("PRRT_a", { body: "Please fix" })];
    const sends: GithubThreadWrite[] = [];
    let timeOut = true;
    const port: WritePort = {
      shown: () => prThreads(github),
      async send(write) {
        sends.push(write);
        github = applyThreadWrite(github, write, VIEWER, "PRRT_new");
        if (timeOut) {
          timeOut = false;
          return { ok: false, failure: failure("timeout") };
        }
        return { ok: true, data: "PRRT_a" };
      },
      reread: async () => prThreads(github),
    };
    const store = new ThreadWrites();
    store.open(REPLY, "Fixed.");
    await store.post(
      REPLY,
      { kind: "reply", threadId: "PRRT_a", resolve: true },
      port
    );
    expect(store.slot(REPLY).failure?.kind).toBe("timeout");
    store.edit(REPLY, "");
    await store.retry(REPLY, port);
    expect(sends.map(({ kind }) => kind)).toEqual(["reply", "resolve"]);
    expect(github[0].resolved).toBe(true);
    expect(store.slot(REPLY).failure).toBeNull();
  });

  it("posts only on request, keeps drafts, and never posts a landed write twice", () =>
    hegel.testAsync(
      async (tc) => {
        let github = [reviewThread("PRRT_a", { body: "Please fix" })];
        let nodes = 0;
        const sends: GithubThreadWrite[] = [];
        /** The last send per slot, and whether GitHub applied it. */
        const applied = new Map<string, boolean>();
        const started: string[] = [];
        let slotOfSend = "";
        const port: WritePort = {
          shown: () => prThreads(github),
          async send(write) {
            sends.push(write);
            const answer = tc.draw(gs.sampledFrom(ANSWERS));
            const lands =
              answer === "posted" ||
              answer === "timeout_applied" ||
              answer === "threw_applied";
            const id = `PRRT_n${++nodes}`;
            if (lands) github = applyThreadWrite(github, write, VIEWER, id);
            applied.set(slotOfSend, lands);
            if (answer === "threw_applied" || answer === "threw_lost")
              throw new Error("the port threw");
            if (answer === "posted")
              return {
                ok: true,
                data: write.kind === "start" ? id : write.threadId,
              };
            return {
              ok: false,
              failure: failure(
                answer === "forbidden"
                  ? "forbidden"
                  : answer === "transient"
                    ? "other"
                    : "timeout"
              ),
            };
          },
          reread: async () => {
            const read = tc.draw(gs.sampledFrom(["read", "null", "threw"]));
            if (read === "threw") throw new Error("the reread threw");
            return read === "read" ? prThreads(github) : null;
          },
          started: (threadId) => {
            started.push(threadId);
            if (tc.draw(gs.booleans())) throw new Error("following up threw");
          },
        };
        const store = new ThreadWrites();
        const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
        for (let step = 0; step < steps; step += 1) {
          const key = tc.draw(gs.sampledFrom([REPLY, COMMENT]));
          slotOfSend = key;
          const op = tc.draw(
            gs.sampledFrom([
              "open",
              "edit",
              "discard",
              "undo",
              "post",
              "toggle",
              "retry",
            ] as const)
          );
          const slot = store.slot(key);
          const sent = sends.length;
          const threadsBefore = github;
          if (op === "open") {
            store.open(key, tc.draw(gs.sampledFrom(["", ...BODIES])));
            if (slot.draft !== null)
              expect(store.slot(key).draft).toBe(slot.draft);
          } else if (op === "edit") {
            const text = tc.draw(gs.sampledFrom(["", "  ", ...BODIES]));
            store.edit(key, text);
            expect(store.slot(key).draft).toBe(
              slot.draft === null ? null : text
            );
          } else if (op === "discard") {
            store.discard(key);
            expect(store.slot(key).draft).toBeNull();
            // Discard then Undo is a round trip.
            if (slot.draft !== null) {
              expect(store.slot(key).discarded).toBe(slot.draft);
              store.undo(key);
              expect(store.slot(key).draft).toBe(slot.draft);
              store.discard(key);
            }
          } else if (op === "undo") {
            store.undo(key);
            if (slot.draft === null && slot.discarded !== null)
              expect(store.slot(key).draft).toBe(slot.discarded);
          } else if (op === "post" || op === "toggle") {
            const plan: WritePlan =
              key === COMMENT
                ? { kind: "start", place: PLACE }
                : op === "toggle"
                  ? {
                      kind: github[0].resolved ? "reopen" : "resolve",
                      threadId: "PRRT_a",
                    }
                  : {
                      kind: "reply",
                      threadId: "PRRT_a",
                      resolve: tc.draw(gs.booleans()),
                    };
            await store.post(key, plan, port);
            const posted = sends.slice(sent);
            const body = slot.draft?.trim() ?? "";
            const needsText = plan.kind === "reply" || plan.kind === "start";
            if (needsText && !body) {
              expect(posted).toEqual([]);
              continue;
            }
            expect(posted.length).toBeGreaterThan(0);
            expect(posted.length).toBeLessThanOrEqual(
              plan.kind === "reply" && plan.resolve ? 2 : 1
            );
            const first = posted[0];
            if (needsText) expect(first).toMatchObject({ body });
            const after = store.slot(key);
            const firstFailed =
              after.failure !== null && sameWrite(after.failure.sent, first);
            if (needsText)
              expect(after.draft).toBe(firstFailed ? slot.draft : null);
            if (after.failure && !firstFailed) {
              // The reply posted; its resolve failed. The reply stays.
              expect(after.failure.replied).toBe(true);
              expect(after.failure.plan.kind).toBe("resolve");
              expect(
                github[0].comments.some(
                  (comment) =>
                    comment.author?.login === VIEWER &&
                    comment.body === body &&
                    !threadsBefore[0].comments.includes(comment)
                )
              ).toBe(true);
            }
          } else {
            const { failure: failed } = slot;
            const appliedBefore = applied.get(key);
            await store.retry(key, port);
            const retried = sends.slice(sent);
            const after = store.slot(key);
            if (
              !failed ||
              failed.kind === "forbidden" ||
              failed.kind === "unconfirmed"
            ) {
              expect(retried).toEqual([]);
              expect(after).toEqual(slot);
              continue;
            }
            if (failed.kind === "timeout" && appliedBefore)
              expect(
                retried.some((write) => sameWrite(write, failed.sent))
              ).toBe(false);
            // A landed reply's resolve is never dropped: it is sent, or the
            // retry still says what is left.
            if (
              failed.plan.kind === "reply" &&
              failed.plan.resolve &&
              failed.kind === "timeout" &&
              appliedBefore
            )
              expect(
                after.failure !== null ||
                  retried.some((write) => write.kind === "resolve")
              ).toBe(true);
          }
          if (op !== "post" && op !== "toggle" && op !== "retry")
            expect(sends.length).toBe(sent);
          expect(store.slot(key).pending).toBeNull();
        }
        // Each thread a comment started is reported once, and is on GitHub.
        expect(new Set(started).size).toBe(started.length);
        for (const id of started)
          expect(github.some((thread) => thread.id === id)).toBe(true);
      },
      { testCases: 300 }
    ));
});
