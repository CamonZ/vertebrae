/**
 * Public writes to a PR's review threads: reply, resolve, reopen, and start
 * a thread from a private line discussion. Each slot holds one composer's
 * draft (a GitHub thread's reply, or a discussion's new comment) and the
 * write it last sent. Drafts live per chat, apart from the unsent private
 * questions of `SelectionDiscussions`, so closing a card, Esc or another
 * comparison keeps them. Slots are scoped to one PR: a thread's by its
 * GitHub node ID, a comment's or a selection's by the PR's identity, and a
 * failure remembers the PR it was sent to, so nothing left from one PR is
 * retried against another. Nothing is sent without a call from a user
 * action; a write whose outcome is unknown is settled against the threads
 * read right after it, and checked again before it is sent again.
 */
import type {
  GithubFailure,
  GithubPrReviewThreads,
  GithubReviewThread,
  GithubThreadWrite,
  ReviewThreadSide,
} from "../../../../bindings";
import type { GithubOutcome } from "../../../../stores/worktreePrStore";

/** The published lines a new thread goes on. */
export interface NewThreadPlace {
  path: string;
  side: ReviewThreadSide;
  /** Null for a single line. */
  startLine: number | null;
  line: number;
}

/** What the user asked to post; the slot's draft gives the text. */
export type WritePlan =
  | { kind: "reply"; threadId: string; resolve: boolean }
  | { kind: "resolve" | "reopen"; threadId: string }
  /** On the PR whose threads' read answered `pullRequestId`. */
  | { kind: "start"; pullRequestId: string; place: NewThreadPlace };

/**
 * Why a write failed, as what the user can do about it:
 * - `forbidden` (403) and `unconfirmed` (an unknown outcome GitHub's threads
 *   could not settle) only go to GitHub;
 * - `rejected`: the write is invalid and was refused before it was sent,
 *   so resending it unchanged cannot help;
 *   a draft is kept to be changed and posted again;
 * - `ambiguous`: it may have landed (a timeout, a dropped answer, a reread
 *   that failed), so Retry checks the threads before sending it again;
 * - `transient`: it never got through, so Retry sends it again.
 */
export type FailureKind =
  | "forbidden"
  | "rejected"
  | "ambiguous"
  | "unconfirmed"
  | "transient";

/** Whether Retry may act on a failure of `kind`. */
export const retryable = (kind: FailureKind) =>
  kind === "ambiguous" || kind === "transient";

export interface WriteFailure {
  /** The PR the write went to (its `WritePort.scope`). */
  scope: string;
  /** What Retry posts; after a posted reply, only its resolve. */
  plan: WritePlan;
  kind: FailureKind;
  message: string;
  /** A reply and resolve's reply posted; only the resolve failed. */
  replied: boolean;
  /** The write that failed, and what matched it before, to tell if it landed. */
  sent: GithubThreadWrite;
  before: readonly string[] | null;
}

export interface WriteSlot {
  /** The open composer's text; null while no composer is open. */
  draft: string | null;
  /** The last discarded draft, for Undo. */
  discarded: string | null;
  /** The write being sent or checked. */
  pending: GithubThreadWrite["kind"] | null;
  failure: WriteFailure | null;
  /** Writes GitHub refused with a 403 here: they are not offered again. */
  refused: readonly GithubThreadWrite["kind"][];
}

export const EMPTY_SLOT: WriteSlot = {
  draft: null,
  discarded: null,
  pending: null,
  failure: null,
  refused: [],
};

/** A GitHub thread's slot: its node ID is unique across PRs. */
export const replySlot = (githubThreadId: string) => `thread:${githubThreadId}`;
/** A discussion's new comment on the PR `scope`. */
export const commentSlot = (scope: string, discussionId: string) =>
  `comment:${scope}:${discussionId}`;

/**
 * Whether `failure` is the thread's own (a resolve or reopen, alone or after
 * a posted reply) rather than its composer's text: it shows with the
 * thread's buttons, and outlives the composer.
 */
export const threadLane = (failure: WriteFailure) =>
  failure.sent.kind === "resolve" || failure.sent.kind === "reopen";

/**
 * What a thread offers the viewer to write: what GitHub permits, less what
 * it refused here with a 403. While the reply composer is open the buttons
 * give way to it (it posts, and resolves, itself).
 */
export function threadOffers(
  thread: Pick<
    GithubReviewThread,
    "resolved" | "viewerCanReply" | "viewerCanResolve" | "viewerCanUnresolve"
  >,
  slot: Pick<WriteSlot, "draft" | "refused">
): {
  /** The Reply button. */
  reply: boolean;
  /** The Resolve or Reopen button. */
  toggle: "resolve" | "reopen" | null;
  /** The composer's Reply and resolve. */
  replyAndResolve: boolean;
} {
  const allowed = (kind: "resolve" | "reopen") => !slot.refused.includes(kind);
  const canResolve =
    !thread.resolved && thread.viewerCanResolve && allowed("resolve");
  const canReopen =
    thread.resolved && thread.viewerCanUnresolve && allowed("reopen");
  const closed = slot.draft === null;
  return {
    reply: closed && thread.viewerCanReply,
    toggle: !closed
      ? null
      : canResolve
        ? "resolve"
        : canReopen
          ? "reopen"
          : null,
    replyAndResolve: canResolve,
  };
}

export function failureKind({ kind }: GithubFailure): FailureKind {
  switch (kind) {
    case "forbidden":
    case "rejected":
    case "ambiguous":
      return kind;
    default:
      return "transient";
  }
}

const sameBody = (left: string, right: string) =>
  left.replace(/\r\n/g, "\n").trim() === right.replace(/\r\n/g, "\n").trim();

/**
 * The nodes GitHub's threads show for `write`: the viewer's comments with
 * its body, the threads it started, or the thread when it is in the state
 * it asks for. Null when the threads cannot tell (an unknown viewer, a
 * thread not among them, or a truncated list).
 */
export function matching(
  threads: GithubPrReviewThreads | null,
  write: GithubThreadWrite
): string[] | null {
  if (!threads) return null;
  const viewer = threads.viewerLogin;
  const byViewer = (login: string | undefined, body: string, wrote: string) =>
    login === viewer && sameBody(body, wrote);
  if (write.kind === "start") {
    if (viewer === null || threads.truncated) return null;
    return threads.threads
      .filter(({ anchor, comments }) => {
        const first = comments[0];
        return (
          anchor.path === write.path &&
          anchor.side === write.side &&
          (anchor.line ?? anchor.originalLine) === write.line &&
          !!first &&
          byViewer(first.author?.login, first.body, write.body)
        );
      })
      .map(({ id }) => id);
  }
  const thread = threads.threads.find(({ id }) => id === write.threadId);
  if (!thread) return null;
  switch (write.kind) {
    case "resolve":
      return thread.resolved ? [thread.id] : [];
    case "reopen":
      return thread.resolved ? [] : [thread.id];
    case "reply":
      if (viewer === null || thread.commentsTruncated) return null;
      return thread.comments
        .filter(({ author, body }) => byViewer(author?.login, body, write.body))
        .map(({ id }) => id);
  }
}

export type Landed =
  | { kind: "landed"; threadId: string }
  | { kind: "absent" }
  | { kind: "unknown" };

/** Whether `write` shows in `threads` beyond what matched it before. */
export function landed(
  threads: GithubPrReviewThreads,
  write: GithubThreadWrite,
  before: readonly string[] | null
): Landed {
  const now = matching(threads, write);
  if (now === null || before === null) return { kind: "unknown" };
  const fresh = now.find((id) => !before.includes(id));
  if (fresh === undefined) return { kind: "absent" };
  return {
    kind: "landed",
    threadId: write.kind === "start" ? fresh : write.threadId,
  };
}

/** The writes a plan sends, in order; null when its draft has no text. */
export function writesOf(
  plan: WritePlan,
  draft: string | null
): GithubThreadWrite[] | null {
  const body = draft?.trim() ?? "";
  switch (plan.kind) {
    case "resolve":
    case "reopen":
      return [{ kind: plan.kind, threadId: plan.threadId }];
    case "reply":
      if (!body) return null;
      return [
        { kind: "reply", threadId: plan.threadId, body },
        ...(plan.resolve
          ? [{ kind: "resolve" as const, threadId: plan.threadId }]
          : []),
      ];
    case "start":
      return body
        ? [
            {
              kind: "start",
              pullRequestId: plan.pullRequestId,
              ...plan.place,
              body,
            },
          ]
        : null;
  }
}

/** A sent write's answer, and the threads as read right after it. */
export interface WriteAnswer {
  outcome: GithubOutcome<string>;
  /** Null when the reread failed or the PR changed. */
  threads: GithubPrReviewThreads | null;
}

/** Where a slot's writes go: one PR, as the user saw it. */
export interface WritePort {
  /** The PR's identity: a failure is retried only through its own PR. */
  scope: string;
  /** The PR's threads as shown now, to tell later whether a write landed. */
  shown(): GithubPrReviewThreads | null;
  /** Sends one write once; answers the written thread and a fresh read. */
  send(write: GithubThreadWrite): Promise<WriteAnswer>;
  /** Reads the threads past every cache; null when that failed. */
  reread(): Promise<GithubPrReviewThreads | null>;
  /** The slot's new thread is on GitHub as `threadId`. */
  started?(threadId: string): Promise<void> | void;
}

export class ThreadWrites {
  private slots = new Map<string, WriteSlot>();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  slot(key: string): WriteSlot {
    return this.slots.get(key) ?? EMPTY_SLOT;
  }

  private set(key: string, patch: Partial<WriteSlot>) {
    const next = { ...this.slot(key), ...patch };
    if (
      next.draft === null &&
      next.discarded === null &&
      next.pending === null &&
      next.failure === null &&
      next.refused.length === 0
    )
      this.slots.delete(key);
    else this.slots.set(key, next);
    this.listeners.forEach((listener) => listener());
  }

  /** Opens the composer with `seed`, or as it was left. */
  open(key: string, seed = "") {
    const { draft } = this.slot(key);
    if (draft === null) this.set(key, { draft: seed, discarded: null });
  }

  edit(key: string, text: string) {
    if (this.slot(key).draft !== null) this.set(key, { draft: text });
  }

  /** Closes the composer; Undo brings the text back. */
  discard(key: string) {
    const { draft, pending, failure } = this.slot(key);
    if (draft === null || pending) return;
    this.set(key, {
      draft: null,
      discarded: draft,
      // A failure of the discarded text goes with it; the thread's own
      // (a resolve, or a posted reply's resolve recovery) stays.
      failure: failure && threadLane(failure) ? failure : null,
    });
  }

  /**
   * Drops the slot of a composer that is gone; a post that is out stays,
   * and so do the writes GitHub refused.
   */
  forget(key: string) {
    const { pending, refused } = this.slot(key);
    if (pending || !this.slots.has(key)) return;
    if (refused.length > 0)
      this.set(key, { ...EMPTY_SLOT, refused });
    else {
      this.slots.delete(key);
      this.listeners.forEach((listener) => listener());
    }
  }

  undo(key: string) {
    const { discarded, draft } = this.slot(key);
    if (discarded !== null && draft === null)
      this.set(key, { draft: discarded, discarded: null });
  }

  /** Posts `plan` with the slot's draft. Only ever called by a user action. */
  async post(key: string, plan: WritePlan, port: WritePort) {
    const slot = this.slot(key);
    const writes = writesOf(plan, slot.draft);
    if (slot.pending || !writes) return;
    await this.send(key, plan, writes, port, false);
  }

  /**
   * Posts the failed plan again, through the PR it was sent to only. An
   * ambiguous write first reads the threads: one that landed counts as
   * posted, and one GitHub's threads cannot settle is left to GitHub, so
   * nothing posts twice.
   */
  async retry(key: string, port: WritePort) {
    const { failure, pending, draft } = this.slot(key);
    if (!failure || pending || failure.scope !== port.scope) return;
    if (!retryable(failure.kind)) return;
    const { plan, replied } = failure;
    if (failure.kind === "ambiguous") {
      this.set(key, { pending: failure.sent.kind });
      const threads = await port.reread().catch(() => null);
      if (!threads) {
        this.set(key, {
          pending: null,
          failure: {
            ...failure,
            message: "Couldn’t read the thread to check whether it posted.",
          },
        });
        return;
      }
      const result = landed(threads, failure.sent, failure.before);
      if (result.kind === "unknown") {
        this.set(key, {
          pending: null,
          failure: { ...failure, kind: "unconfirmed", message: UNSETTLED },
        });
        return;
      }
      if (result.kind === "landed") {
        await this.wrote(key, failure.sent, result.threadId, port);
        // What the plan still has to do once its first write is in, from
        // the plan alone: the text may have been changed or cleared since.
        if (plan.kind === "reply" && plan.resolve) {
          const rest = restPlan(plan);
          await this.send(key, rest, writesOf(rest, null)!, port, true);
        } else this.set(key, { pending: null, failure: null });
        return;
      }
    }
    const writes = writesOf(plan, draft);
    if (!writes) {
      this.set(key, { pending: null });
      return;
    }
    await this.send(key, plan, writes, port, replied);
  }

  private async send(
    key: string,
    plan: WritePlan,
    writes: GithubThreadWrite[],
    port: WritePort,
    replied: boolean
  ) {
    for (const [index, write] of writes.entries()) {
      const before = matching(port.shown(), write);
      this.set(key, { pending: write.kind, failure: null });
      // A send that threw may or may not have reached GitHub: like a
      // timeout, it is checked before it is sent again.
      const { outcome, threads } = await port.send(write).catch(
        (error: unknown): WriteAnswer => ({
          outcome: {
            ok: false,
            failure: {
              kind: "ambiguous",
              message: error instanceof Error ? error.message : String(error),
              retryAfterSecs: null,
            },
          },
          threads: null,
        })
      );
      const settled = settle(outcome, threads, write, before);
      if (settled.kind === "failed") {
        const { failure } = settled;
        this.set(key, {
          pending: null,
          failure: {
            scope: port.scope,
            plan: index === 0 ? plan : restPlan(plan),
            kind: failure.kind,
            message: failure.message,
            replied: replied || index > 0,
            sent: write,
            before,
          },
          refused:
            failure.kind === "forbidden"
              ? [...new Set([...this.slot(key).refused, write.kind])]
              : this.slot(key).refused,
        });
        return;
      }
      await this.wrote(key, write, settled.threadId, port);
    }
    this.set(key, { pending: null, failure: null });
  }

  /** A reply or new thread posted: its draft is done. */
  private async wrote(
    key: string,
    write: GithubThreadWrite,
    threadId: string,
    port: WritePort
  ) {
    if (write.kind !== "reply" && write.kind !== "start") return;
    const { draft } = this.slot(key);
    // Text edited after a timed-out post that landed stays for Undo.
    const edited = draft !== null && !sameBody(draft, write.body);
    this.set(key, { draft: null, discarded: edited ? draft : null });
    // The thread is on GitHub whatever happens next here; a failure to
    // follow it up locally must not leave the slot pending.
    if (write.kind === "start")
      await Promise.resolve()
        .then(() => port.started?.(threadId))
        .catch((error: unknown) =>
          console.error("Following up a started GitHub thread failed", error)
        );
  }
}

const UNSETTLED =
  "GitHub’s threads here can’t show whether it posted; check on GitHub.";

/**
 * What a sent write did: posted as GitHub answered, or as the threads read
 * right after it show when GitHub's answer was lost; otherwise how it
 * failed. An unknown outcome the read cannot settle is left to GitHub, and
 * one with no read is checked again on Retry.
 */
export function settle(
  outcome: GithubOutcome<string>,
  threads: GithubPrReviewThreads | null,
  write: GithubThreadWrite,
  before: readonly string[] | null
):
  | { kind: "posted"; threadId: string }
  | { kind: "failed"; failure: { kind: FailureKind; message: string } } {
  if (outcome.ok) return { kind: "posted", threadId: outcome.data };
  const kind = failureKind(outcome.failure);
  const { message } = outcome.failure;
  if (kind !== "ambiguous" || !threads)
    return { kind: "failed", failure: { kind, message } };
  const result = landed(threads, write, before);
  switch (result.kind) {
    case "landed":
      return { kind: "posted", threadId: result.threadId };
    case "unknown":
      return {
        kind: "failed",
        failure: { kind: "unconfirmed", message: UNSETTLED },
      };
    case "absent":
      return { kind: "failed", failure: { kind, message } };
  }
}

/** What is left of a plan once its first write posted. */
function restPlan(plan: WritePlan): WritePlan {
  return plan.kind === "reply"
    ? { kind: "resolve", threadId: plan.threadId }
    : plan;
}
