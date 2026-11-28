/**
 * Thread writes against a synthetic GitHub. The landed check is tested
 * against GitHub's own application of a write (`applyThreadWrite`): a write
 * applied shows as landed, one not applied as absent, and threads that
 * cannot tell say so.
 *
 * The drafts store is then checked two ways:
 *
 * - Failure sequences by construction: one plan is attempted round after
 *   round (Post, or Retry once a write failed) with edits between rounds,
 *   while GitHub answers each write from a failure-heavy mix (posted, 403,
 *   rejected, transient, an answer lost after it did or did not apply, a
 *   port that threw) and the read after it (fresh, failed, or blind to the
 *   viewer). A reference model of the plan's progress predicts, after every
 *   round, the slot and what GitHub has; GitHub itself is the oracle that
 *   nothing posted twice. Timeouts that landed, edits between attempts and
 *   reply-and-resolve recovery are reached by every multi-round case, not
 *   by chance.
 * - Random user actions across two slots, for the properties that hold
 *   whatever the order: sends only from Post or Retry, Discard and Undo
 *   round trips, and each started thread reported once.
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
  threadOffers,
  type FailureKind,
  type WriteAnswer,
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
  pullRequestId: "PR_kwDOsynthetic7",
  viewerLogin,
  headOid: "1".repeat(40),
  baseOid: "2".repeat(40),
  threads,
  truncated,
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
        pullRequestId: "PR_kwDOsynthetic7",
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

const SCOPE = "example/demo-repo#7";
const PR_ID = "PR_kwDOsynthetic7";
const REPLY = replySlot("PRRT_a");
const COMMENT = commentSlot(SCOPE, "discussion-1");
const PLACE = {
  path: "src/lib.rs",
  side: "RIGHT" as const,
  startLine: null,
  line: 20,
};

/** GitHub's answer to one write. `lost_*`: no answer, applied or not. */
type Answer =
  | "posted"
  | "forbidden"
  | "rejected"
  | "transient"
  | "lost_landed"
  | "lost_absent"
  | "threw_landed"
  | "threw_absent";

/** The threads read after a write, or by Retry's check. */
type Read = "fresh" | "failed" | "blind";

const ANSWERS: Answer[] = [
  "posted",
  "forbidden",
  "rejected",
  "transient",
  "lost_landed",
  "lost_absent",
  "threw_landed",
  "threw_absent",
];
const READS: Read[] = ["fresh", "failed", "blind"];

const WIRE_KIND: Record<
  "forbidden" | "rejected" | "transient" | "lost_landed" | "lost_absent",
  GithubFailure["kind"]
> = {
  forbidden: "forbidden",
  rejected: "rejected",
  transient: "other",
  lost_landed: "ambiguous",
  lost_absent: "ambiguous",
};

const lands = (answer: Answer) =>
  answer === "posted" || answer === "lost_landed" || answer === "threw_landed";

const sameWrite = (left: GithubThreadWrite, right: GithubThreadWrite) =>
  JSON.stringify(left) === JSON.stringify(right);

/** A synthetic GitHub for one PR, answering as a test case says. */
class FakeGithub {
  threads: GithubReviewThread[];
  sends: GithubThreadWrite[] = [];
  rereads = 0;
  private nodes = 0;
  constructor(
    threads: GithubReviewThread[],
    /** The answer to a send, and the read right after it. */
    private next: () => { answer: Answer; read: Read },
    /** What Retry's check reads. */
    private recheck: () => Read
  ) {
    this.threads = threads;
  }
  private view(read: Read) {
    if (read === "failed") return null;
    return prThreads(this.threads, read === "blind" ? null : VIEWER);
  }
  port(scope = SCOPE): WritePort {
    return {
      scope,
      shown: () => prThreads(this.threads),
      send: async (write): Promise<WriteAnswer> => {
        this.sends.push(write);
        const { answer, read } = this.next();
        const id = `PRRT_n${++this.nodes}`;
        if (lands(answer))
          this.threads = applyThreadWrite(this.threads, write, VIEWER, id);
        if (answer === "threw_landed" || answer === "threw_absent")
          throw new Error("the port threw");
        const threads = this.view(read);
        if (answer === "posted")
          return {
            outcome: {
              ok: true,
              data: write.kind === "start" ? id : write.threadId,
            },
            threads,
          };
        return {
          outcome: {
            ok: false,
            failure: {
              kind: WIRE_KIND[answer],
              message: `${answer} from GitHub`,
              retryAfterSecs: null,
            },
          },
          threads,
        };
      },
      reread: async () => {
        this.rereads += 1;
        return this.view(this.recheck());
      },
    };
  }
}

type PlanKind = "reply" | "reply_resolve" | "resolve" | "reopen" | "start";
type WriteKind = GithubThreadWrite["kind"];

const planOf = (kind: PlanKind): WritePlan =>
  kind === "start"
    ? { kind: "start", pullRequestId: PR_ID, place: PLACE }
    : kind === "reply" || kind === "reply_resolve"
      ? { kind: "reply", threadId: "PRRT_a", resolve: kind === "reply_resolve" }
      : { kind, threadId: "PRRT_a" };

const writesOfPlan = (kind: PlanKind): WriteKind[] =>
  kind === "reply_resolve" ? ["reply", "resolve"] : [kind === "reply" ? "reply" : kind];

const isText = (kind: WriteKind) => kind === "reply" || kind === "start";

/**
 * What the store should hold after each round: the plan's writes still to
 * land, the composer, the failure, and the bodies GitHub took. Written from
 * the spec of a write's outcome, not from the store's code.
 */
interface Model {
  remaining: WriteKind[];
  draft: string | null;
  discarded: string | null;
  failure: {
    kind: FailureKind;
    write: WriteKind;
    /** GitHub applied it (a lost answer that landed). */
    applied: boolean;
    /** The body it was sent with. */
    body: string | null;
  } | null;
  refused: WriteKind[];
  /** Bodies of the viewer's replies or new threads on GitHub. */
  posted: string[];
  sends: number;
  rereads: number;
}

const trimmed = (text: string | null) => text?.trim() ?? "";

/** The model's send of the remaining writes, as GitHub answers each. */
function modelSend(
  model: Model,
  next: () => { answer: Answer; read: Read }
) {
  while (model.remaining.length > 0) {
    const write = model.remaining[0];
    const body = isText(write) ? trimmed(model.draft) : null;
    if (body === "") return;
    const { answer, read } = next();
    model.sends += 1;
    const applied = lands(answer);
    if (applied && body !== null) model.posted.push(body);
    let failed: FailureKind | null = null;
    if (answer === "forbidden") failed = "forbidden";
    else if (answer === "rejected") failed = "rejected";
    else if (answer === "transient") failed = "transient";
    else if (answer !== "posted") {
      const threw = answer.startsWith("threw");
      // The write's own read settles a lost answer at once.
      if (threw || read === "failed") failed = "ambiguous";
      else if (read === "blind" && isText(write)) failed = "unconfirmed";
      else if (!applied) failed = "ambiguous";
    }
    if (failed) {
      model.failure = { kind: failed, write, applied, body };
      if (failed === "forbidden" && !model.refused.includes(write))
        model.refused.push(write);
      return;
    }
    model.failure = null;
    model.remaining.shift();
    if (body !== null) {
      model.draft = null;
      model.discarded = null;
    }
  }
}

/** The model's Retry: a lost answer is checked before anything is resent. */
function modelRetry(
  model: Model,
  retryRead: Read,
  next: () => { answer: Answer; read: Read }
) {
  const { failure } = model;
  if (!failure) return;
  if (failure.kind !== "ambiguous" && failure.kind !== "transient") return;
  if (failure.kind === "ambiguous") {
    model.rereads += 1;
    if (retryRead === "failed") return;
    if (retryRead === "blind" && isText(failure.write)) {
      model.failure = { ...failure, kind: "unconfirmed" };
      return;
    }
    if (failure.applied) {
      model.failure = null;
      model.remaining.shift();
      if (failure.body !== null) {
        // Text edited after the post that landed stays for Undo.
        const edited =
          model.draft !== null && trimmed(model.draft) !== failure.body;
        model.discarded = edited ? model.draft : null;
        model.draft = null;
      }
      modelSend(model, next);
      return;
    }
  }
  modelSend(model, next);
}

describe("the drafts store through failure sequences", () => {
  it("settles a lost answer from the write's own read, without a second read", async () => {
    const answers: Answer[] = ["lost_landed"];
    const github = new FakeGithub(
      [reviewThread("PRRT_a", { body: "Please fix" })],
      () => ({ answer: answers.shift() ?? "posted", read: "fresh" }),
      () => "fresh"
    );
    const store = new ThreadWrites();
    store.open(REPLY, "Fixed.");
    await store.post(REPLY, planOf("reply"), github.port());
    expect(store.slot(REPLY)).toMatchObject({ draft: null, failure: null });
    expect(github.sends).toHaveLength(1);
    expect(github.rereads).toBe(0);
  });

  it("resolves after a reply whose lost answer landed, though the text was cleared", async () => {
    // The read after the reply fails, so only Retry's check settles it.
    const answers: Answer[] = ["lost_landed"];
    const github = new FakeGithub(
      [reviewThread("PRRT_a", { body: "Please fix" })],
      () => ({
        answer: answers.shift() ?? "posted",
        read: answers.length === 0 ? "failed" : "fresh",
      }),
      () => "fresh"
    );
    const store = new ThreadWrites();
    store.open(REPLY, "Fixed.");
    await store.post(REPLY, planOf("reply_resolve"), github.port());
    expect(store.slot(REPLY).failure?.kind).toBe("ambiguous");
    store.edit(REPLY, "");
    await store.retry(REPLY, github.port());
    expect(github.sends.map(({ kind }) => kind)).toEqual(["reply", "resolve"]);
    expect(github.threads[0].resolved).toBe(true);
    expect(store.slot(REPLY).failure).toBeNull();
  });

  it("agrees with the reference model after every round", () =>
    hegel.testAsync(
      async (tc) => {
        const kind = tc.draw(
          gs.sampledFrom<PlanKind>([
            "reply",
            "reply_resolve",
            "resolve",
            "reopen",
            "start",
          ])
        );
        const key = kind === "start" ? COMMENT : REPLY;
        const draw = () => ({
          answer: tc.draw(gs.sampledFrom(ANSWERS)),
          read: tc.draw(gs.sampledFrom(READS)),
        });
        // Each send's answer and read are drawn once, and the model replays
        // the same draws.
        let queued: { answer: Answer; read: Read }[] = [];
        const take = () => {
          const drawn = draw();
          queued.push(drawn);
          return drawn;
        };
        let replay: { answer: Answer; read: Read }[] = [];
        let retryRead: Read = "fresh";
        const github = new FakeGithub(
          [
            reviewThread("PRRT_a", {
              body: "Please fix",
              resolved: kind === "reopen",
              viewerCanUnresolve: true,
            }),
          ],
          take,
          () => retryRead
        );
        const text = writesOfPlan(kind).some(isText);
        const store = new ThreadWrites();
        const model: Model = {
          remaining: writesOfPlan(kind),
          draft: null,
          discarded: null,
          failure: null,
          refused: [],
          posted: [],
          sends: 0,
          rereads: 0,
        };
        if (text) {
          store.open(key, "Fixed.");
          model.draft = "Fixed.";
        }
        const rounds = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
        for (let round = 0; round < rounds; round += 1) {
          if (round > 0 && model.draft !== null) {
            const edit = tc.draw(
              gs.sampledFrom(["keep", "change", "clear"] as const)
            );
            const next =
              edit === "keep" ? model.draft : edit === "change" ? "Fixed, thanks." : "";
            store.edit(key, next);
            model.draft = next;
          }
          queued = [];
          const failure = model.failure;
          if (model.remaining.length === 0) break;
          // A rejected text is changed and posted again; a rejected resolve
          // or reopen is finished on GitHub, like a 403.
          if (failure?.kind === "rejected" && !isText(failure.write)) break;
          if (!failure || failure.kind === "rejected") {
            await store.post(key, planOf(kind), github.port());
            replay = queued;
            modelSend(model, () => replay.shift()!);
          } else {
            retryRead = tc.draw(gs.sampledFrom(READS));
            await store.retry(key, github.port());
            replay = queued;
            modelRetry(model, retryRead, () => replay.shift()!);
          }

          const slot = store.slot(key);
          expect(slot.pending).toBeNull();
          expect(slot.draft).toBe(model.draft);
          expect(slot.discarded).toBe(model.discarded);
          expect(slot.failure?.kind ?? null).toBe(model.failure?.kind ?? null);
          expect(slot.failure?.sent.kind ?? null).toBe(
            model.failure?.write ?? null
          );
          expect(slot.failure?.replied ?? false).toBe(
            kind === "reply_resolve" && model.failure?.write === "resolve"
          );
          expect(slot.failure?.scope ?? SCOPE).toBe(SCOPE);
          expect([...slot.refused].sort()).toEqual([...model.refused].sort());
          expect(github.sends).toHaveLength(model.sends);
          expect(github.rereads).toBe(model.rereads);

          // GitHub is the oracle: nothing the slot wrote is on it twice,
          // and a plan with nothing left is all there.
          const mine = github.threads[0].comments
            .filter((comment) => comment.author?.login === VIEWER)
            .map((comment) => comment.body);
          const started = github.threads.filter(
            ({ comments }) => comments[0]?.author?.login === VIEWER
          );
          expect(mine.length + started.length).toBeLessThanOrEqual(1);
          expect(mine.concat(started.map((t) => t.comments[0].body))).toEqual(
            model.posted
          );
          if (model.remaining.length === 0 && model.failure === null) {
            if (text) expect(model.posted).toHaveLength(1);
            if (kind === "reply_resolve" || kind === "resolve")
              expect(github.threads[0].resolved).toBe(true);
            if (kind === "reopen") expect(github.threads[0].resolved).toBe(false);
          }
        }
      },
      { testCases: 400 }
    ));
});

describe("the drafts store's scope", () => {
  it("never retries a failure through another PR, and keeps each PR's comment apart", async () => {
    const github = new FakeGithub(
      [],
      () => ({ answer: "transient", read: "fresh" }),
      () => "fresh"
    );
    const store = new ThreadWrites();
    store.open(COMMENT, "On PR 7");
    await store.post(COMMENT, planOf("start"), github.port());
    expect(store.slot(COMMENT).failure?.scope).toBe(SCOPE);
    const other = commentSlot("example/demo-repo#8", "discussion-1");
    expect(other).not.toBe(COMMENT);
    expect(store.slot(other).draft).toBeNull();
    await store.retry(COMMENT, github.port("example/demo-repo#8"));
    expect(github.sends).toHaveLength(1);
    await store.retry(COMMENT, github.port());
    expect(github.sends).toHaveLength(2);
  });

  it("offers no Resolve after GitHub refused it with a 403, and keeps that past Forget", async () => {
    const github = new FakeGithub(
      [reviewThread("PRRT_a")],
      () => ({ answer: "forbidden", read: "fresh" }),
      () => "fresh"
    );
    const store = new ThreadWrites();
    const thread = github.threads[0];
    expect(threadOffers(thread, store.slot(REPLY)).toggle).toBe("resolve");
    await store.post(REPLY, planOf("resolve"), github.port());
    expect(threadOffers(thread, store.slot(REPLY))).toEqual({
      reply: true,
      toggle: null,
      replyAndResolve: false,
    });
    store.forget(REPLY);
    expect(store.slot(REPLY).refused).toEqual(["resolve"]);
    expect(store.slot(REPLY).failure).toBeNull();
    // An open composer stands in for the buttons.
    store.open(REPLY, "Why not?");
    expect(threadOffers(thread, store.slot(REPLY))).toMatchObject({
      reply: false,
      toggle: null,
    });
  });
});

describe("the drafts store under random user actions", () => {
  it("posts only on request, round-trips Discard and Undo, and reports each started thread once", () =>
    hegel.testAsync(
      async (tc) => {
        const started: string[] = [];
        const github = new FakeGithub(
          [reviewThread("PRRT_a", { body: "Please fix" })],
          () => ({
            answer: tc.draw(gs.sampledFrom(ANSWERS)),
            read: tc.draw(gs.sampledFrom(READS)),
          }),
          () => tc.draw(gs.sampledFrom(READS))
        );
        const port = (): WritePort => ({
          ...github.port(),
          started: (threadId) => {
            started.push(threadId);
            if (tc.draw(gs.booleans())) throw new Error("following up threw");
          },
        });
        const store = new ThreadWrites();
        const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
        for (let step = 0; step < steps; step += 1) {
          const key = tc.draw(gs.sampledFrom([REPLY, COMMENT]));
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
          const sent = github.sends.length;
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
                ? planOf("start")
                : op === "toggle"
                  ? planOf(github.threads[0].resolved ? "reopen" : "resolve")
                  : planOf(tc.draw(gs.booleans()) ? "reply_resolve" : "reply");
            await store.post(key, plan, port());
            const posted = github.sends.slice(sent);
            const needsText = plan.kind === "reply" || plan.kind === "start";
            if (needsText && !slot.draft?.trim()) expect(posted).toEqual([]);
            else {
              expect(posted.length).toBeGreaterThan(0);
              if (needsText)
                expect(posted[0]).toMatchObject({ body: slot.draft!.trim() });
            }
          } else {
            await store.retry(key, port());
            const { failure } = slot;
            if (
              !failure ||
              failure.kind === "forbidden" ||
              failure.kind === "rejected" ||
              failure.kind === "unconfirmed"
            )
              expect(github.sends.length).toBe(sent);
            else if (failure.kind === "ambiguous")
              // Never resent as it was before the check said it is absent.
              expect(
                github.sends
                  .slice(sent)
                  .filter((write) => sameWrite(write, failure.sent)).length
              ).toBeLessThanOrEqual(1);
          }
          if (op !== "post" && op !== "toggle" && op !== "retry")
            expect(github.sends.length).toBe(sent);
          expect(store.slot(key).pending).toBeNull();
        }
        expect(new Set(started).size).toBe(started.length);
        for (const id of started)
          expect(github.threads.some((thread) => thread.id === id)).toBe(true);
      },
      { testCases: 300 }
    ));
});
