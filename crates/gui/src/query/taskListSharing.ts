import { replaceEqualDeep } from "@tanstack/react-query";
import type { Task } from "../bindings";

/**
 * Task lists are dense, ordered arrays under our query contract. Avoid the
 * generic deep-sharing path's repeated Object.keys(array) and plain-array
 * validation for every websocket patch. Changed tasks still get deep sharing,
 * so duplicate payloads and unchanged nested controls retain their references.
 */
export function shareTaskList(previous: unknown, next: unknown): unknown {
  if (previous === next) return previous;
  if (!Array.isArray(previous) || !Array.isArray(next)) {
    return replaceEqualDeep(previous, next);
  }
  const before = previous as Task[];
  const after = next as Task[];
  let unchanged = before.length === after.length;
  const shared = after.map((task, index) => {
    const value =
      before[index] === task ? task : replaceEqualDeep(before[index], task);
    if (value !== before[index]) unchanged = false;
    return value;
  });
  return unchanged ? previous : shared;
}
