/**
 * Public writes to a PR's review threads: reply, resolve, reopen, and start
 * a thread from a private line discussion. Each slot holds one composer's
 * draft (a GitHub thread's reply, or a discussion's new comment) and the
 * write it last sent. Drafts live per chat, apart from the unsent private
 * questions of `SelectionDiscussions`, so closing a card, Esc or another
 * comparison keeps them. Nothing is sent without a call from a user action;
 * a timed-out write is checked against GitHub before it is sent again.
 */
import type {
  GithubFailure,
  GithubPrReviewThreads,
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
  | { kind: "start"; place: NewThreadPlace };

/**
 * Why a write failed, as what the user can do about it: `forbidden` and
 * `unconfirmed` (a timeout GitHub's threads could not settle) only go to
 * GitHub; `timeout` retries after checking the write is not there; anything
 * else retries.
 */
export type FailureKind = "forbidden" | "timeout" | "unconfirmed" | "transient";

export interface WriteFailure {
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
}

export const EMPTY_SLOT: WriteSlot = {
  draft: null,
  discarded: null,
  pending: null,
  failure: null,
};

export const replySlot = (githubThreadId: string) => `thread:${githubThreadId}`;
export const commentSlot = (discussionId: string) => `comment:${discussionId}`;

export function failureKind({ kind }: GithubFailure): FailureKind {
  return kind === "forbidden" || kind === "timeout" ? kind : "transient";
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
      return body ? [{ kind: "start", ...plan.place, body }] : null;
  }
}

/** Where a slot's writes go: one PR, as the user saw it. */
export interface WritePort {
  /** The PR's threads as shown now, to tell later whether a write landed. */
  shown(): GithubPrReviewThreads | null;
  /** Sends one write once; answers the written thread. */
  send(write: GithubThreadWrite): Promise<GithubOutcome<string>>;
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
      next.failure === null
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
      // A failure of the discarded text goes with it; a posted reply's
      // resolve recovery stays.
      failure: failure?.replied ? failure : null,
    });
  }

  /** Drops the slot of a composer that is gone; a post that is out stays. */
  forget(key: string) {
    if (!this.slot(key).pending && this.slots.delete(key))
      this.listeners.forEach((listener) => listener());
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
   * Posts the failed plan again. A timeout first reads the threads: a write
   * that landed counts as posted, and one GitHub's threads cannot settle is
   * left to GitHub, so nothing posts twice.
   */
  async retry(key: string, port: WritePort) {
    const { failure, pending, draft } = this.slot(key);
    if (!failure || pending) return;
    if (failure.kind === "forbidden" || failure.kind === "unconfirmed") return;
    const { plan, replied } = failure;
    if (failure.kind === "timeout") {
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
          failure: {
            ...failure,
            kind: "unconfirmed",
            message:
              "GitHub’s threads here can’t show whether it posted; check on GitHub.",
          },
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
      const outcome = await port.send(write).catch(
        (error: unknown): Awaited<ReturnType<WritePort["send"]>> => ({
          ok: false,
          failure: {
            kind: "timeout",
            message: error instanceof Error ? error.message : String(error),
            retryAfterSecs: null,
          },
        })
      );
      if (!outcome.ok) {
        this.set(key, {
          pending: null,
          failure: {
            plan: index === 0 ? plan : restPlan(plan),
            kind: failureKind(outcome.failure),
            message: outcome.failure.message,
            replied: replied || index > 0,
            sent: write,
            before,
          },
        });
        return;
      }
      await this.wrote(key, write, outcome.data, port);
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

/** What is left of a plan once its first write posted. */
function restPlan(plan: WritePlan): WritePlan {
  return plan.kind === "reply"
    ? { kind: "resolve", threadId: plan.threadId }
    : plan;
}
