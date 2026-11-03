import type { BackgroundTask } from "./types";
import type { ChatMessage } from "../stores/chatStore";

/** Conservative structured-data budget; avoids serializing payloads on the UI thread. */
export function dataWeight(value: unknown, limit: number): number {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  let bytes = 0;

  while (pending.length > 0 && bytes <= limit) {
    const current = pending.pop();

    if (typeof current === "function") {
      throw new Error("Background tasks must contain data, not callbacks.");
    }

    if (typeof current === "string") {
      bytes += current.length * 2 + 16;
    } else if (current !== null && typeof current === "object") {
      if (visited.has(current)) continue;
      visited.add(current);
      bytes += 64;

      for (const key of Object.keys(current)) {
        bytes += key.length * 2 + 16;
        pending.push(Reflect.get(current, key));
      }
    } else {
      bytes += 8;
    }
  }

  return bytes;
}

/** Known flat message fields avoid walking every scalar twice before structured cloning. */
function messagesWeight(
  messages: readonly ChatMessage[],
  limit: number
): number {
  let bytes = 64;

  for (const message of messages) {
    // Covers the fixed schema's object, keys and primitive slots conservatively.
    bytes += 1024;

    for (const value of Object.values(message)) {
      if (typeof value === "string") bytes += value.length * 2;
      else if (value !== null && typeof value === "object")
        bytes += dataWeight(value, limit - bytes);
      else if (typeof value === "function")
        throw new Error("Background tasks must contain data, not callbacks.");
    }

    if (bytes > limit) break;
  }

  return bytes;
}

export function taskWeight(task: BackgroundTask, limit: number): number {
  let bytes = 512;

  switch (task.kind) {
    case "patch":
      for (const patch of task.patches) {
        bytes += patch.length * 2 + 32;
        if (bytes > limit) break;
      }

      return bytes;

    case "replay":
      for (const line of task.input.lines) {
        bytes += line.length * 2 + 32;
        if (bytes > limit) return bytes;
      }

      bytes += messagesWeight(task.input.messages, limit - bytes);
      if (bytes > limit) return bytes;

      bytes += messagesWeight(task.input.previousInstalled, limit - bytes);

      return bytes + dataWeight(task.input.context, limit);

    case "tool_chain":
      return dataWeight(task, limit);
  }
}
