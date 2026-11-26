import { commands, type JsonValue } from "../bindings";
import type { ChatMessage, ChatSession } from "../stores/chatStore";

const writes = new Map<string, Promise<boolean>>();
const failedWrites = new Set<string>();
const recoveries = new Map<string, Promise<void>>();

export function writeAcpTranscript(
  id: string,
  messages: ChatMessage[]
): Promise<boolean> {
  if (!commands.saveAcpTranscript) return Promise.resolve(true);
  const write = (writes.get(id) ?? Promise.resolve(true))
    .then(async () => {
      const snapshot = JSON.parse(JSON.stringify(messages)) as JsonValue[];
      // A transient failure to delete private history should be retried even
      // when deletion has already removed the chat from the catalog.
      const attempts = messages.length ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          if (
            (await commands.saveAcpTranscript(id, snapshot)).status === "ok"
          ) {
            failedWrites.delete(id);
            return true;
          }
        } catch {
          // Transcript text and adapter data stay out of diagnostics.
        }
      }
      if (messages.length) failedWrites.add(id);
      console.warn("Could not save local ACP transcript", id);
      return false;
    })
    .finally(() => {
      if (writes.get(id) === write) writes.delete(id);
    });
  writes.set(id, write);
  return write;
}

export function persistAcpTranscript(
  id: string,
  previous: ChatMessage[] | undefined,
  messages: ChatMessage[]
): Promise<boolean> {
  if (
    messages.length &&
    (failedWrites.has(id) ||
      previous?.length !== messages.length ||
      messages.some((message, index) => message !== previous[index]))
  ) {
    return writeAcpTranscript(id, messages);
  }
  return writes.get(id) ?? Promise.resolve(true);
}

export function resetAcpTranscriptRetries() {
  failedWrites.clear();
}

export async function readAcpTranscript(
  id: string
): Promise<JsonValue[] | null> {
  if (!commands.loadAcpTranscript) return null;
  await writes.get(id);
  try {
    const result = await commands.loadAcpTranscript(id);
    if (result.status === "ok") return result.data;
  } catch {
    // A read failure must not hide the catalog row.
  }
  console.warn("Could not load local ACP transcript", id);
  return null;
}

export function recoverAcpHistory(
  session: ChatSession,
  install: (messages: ChatMessage[]) => void
) {
  const workingDir = session.discussion?.worktreePath ?? session.projectPath;
  if (
    !commands.recoverAcpTranscript ||
    !session.providerId ||
    !session.providerResumeId ||
    !workingDir ||
    session.backendSessionId ||
    session.messages.length ||
    !session.messageCount ||
    recoveries.has(session.id)
  ) {
    return;
  }

  const recovery = commands
    .recoverAcpTranscript(
      session.providerId,
      session.providerResumeId,
      workingDir
    )
    .then((result) => {
      if (
        recoveries.get(session.id) !== recovery ||
        result.status !== "ok" ||
        !result.data.length
      )
        return;
      const timestamp = session.createdAt ?? new Date().toISOString();
      install(
        result.data.map(({ user, text }) =>
          user
            ? { kind: "user", text, timestamp }
            : { kind: "assistant", text, timestamp }
        )
      );
    })
    .catch(() => {
      console.warn("Could not recover ACP adapter history", session.id);
    })
    .finally(() => {
      if (recoveries.get(session.id) === recovery)
        recoveries.delete(session.id);
    });
  recoveries.set(session.id, recovery);
}

export function pendingAcpHistory(sessionId: string) {
  return recoveries.get(sessionId);
}

export function resetAcpHistoryRecovery() {
  recoveries.clear();
}
