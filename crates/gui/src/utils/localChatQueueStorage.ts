import { commands, type LocalChatSessionIndexEntry } from "../bindings";

const queueWrites = new Map<string, Promise<boolean>>();

export function writeLocalChatQueue(
  id: string,
  entry: LocalChatSessionIndexEntry | null
): Promise<boolean> {
  if (!commands.saveLocalChatQueue) return Promise.resolve(true);
  const write = (queueWrites.get(id) ?? Promise.resolve(true))
    .then(async () => {
      try {
        const result = await commands.saveLocalChatQueue(id, entry);
        if (result.status === "ok") return true;
        console.warn(
          "Could not save local chat queue",
          id,
          result.error.message
        );
      } catch {
        console.warn("Could not save local chat queue", id);
      }
      return false;
    })
    .finally(() => {
      if (queueWrites.get(id) === write) queueWrites.delete(id);
    });
  queueWrites.set(id, write);
  return write;
}
