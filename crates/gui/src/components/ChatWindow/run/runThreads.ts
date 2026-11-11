import type { Thread } from "../../thread/types";

/** Depth-first search of a run's thread tree, including spawned subagents. */
export function findThread(
  threads: readonly Thread[],
  id: string
): Thread | null {
  for (const thread of threads) {
    if (thread.id === id) return thread;
    for (const turn of thread.turns ?? []) {
      for (const message of turn.messages ?? []) {
        if (message.type !== "spawn") continue;
        const found = findThread([message.thread], id);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Total message count across a thread tree (tail-follow trigger). */
export function countThreadMessages(threads: readonly Thread[]): number {
  let count = 0;
  const walk = (thread: Thread): void => {
    for (const turn of thread.turns ?? []) {
      for (const message of turn.messages ?? []) {
        count += 1;
        if (message.type === "spawn") walk(message.thread);
      }
    }
  };
  threads.forEach(walk);
  return count;
}
