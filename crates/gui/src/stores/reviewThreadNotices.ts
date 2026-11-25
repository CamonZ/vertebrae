import type { GithubPrReviewThreads, GithubReviewThread } from "../bindings";
import { useNotificationStore } from "./notificationStore";

/**
 * Thread IDs already seen per PR read target. The first read only records
 * them; later reads tell the notifications panel about threads not seen
 * before. Kept across project switches so coming back announces nothing old.
 */
const seen = new Map<string, Set<string>>();

export function noticeNewThreads(
  target: string,
  threads: GithubPrReviewThreads
): void {
  const before = seen.get(target);
  seen.set(target, new Set(threads.threads.map((thread) => thread.id)));
  if (!before) return;
  const fresh = threads.threads.filter((thread) => !before.has(thread.id));
  if (fresh.length === 0) return;
  useNotificationStore.getState().addNotification({
    message: newThreadsMessage(threads.repo, threads.prNumber, fresh),
    type: "info",
    entity: "application",
    entityId: `${threads.repo}#${threads.prNumber}`,
  });
}

/** The notification text for threads not seen before. */
function newThreadsMessage(
  repo: string,
  prNumber: number,
  fresh: readonly GithubReviewThread[]
): string {
  const authors = [
    ...new Set(
      fresh.flatMap((thread) => thread.comments[0]?.author?.login ?? [])
    ),
  ];
  const from = authors.length > 0 ? ` from ${authors.join(", ")}` : "";
  if (fresh.length === 1) {
    const { path, line } = fresh[0].anchor;
    const at = line ? `${path}:${line}` : path;
    return `New GitHub review thread on ${repo}#${prNumber}${from} at ${at}.`;
  }
  return `${fresh.length} new GitHub review threads on ${repo}#${prNumber}${from}.`;
}

/** Forget what was seen (tests). */
export function resetReviewThreadNotices(): void {
  seen.clear();
}
