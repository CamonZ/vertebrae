/**
 * In-pane find over the Thread model.
 *
 * Matching reads message fields (prose, tool input and recorded results,
 * subagent labels), not rendered DOM text, so collapsed tool bodies and
 * subagent threads can be force-opened when they contain a match. Matched
 * rows carry `data-find-match` for the find bar to step through.
 */

import { createContext, useContext } from "react";
import type { Message, Thread } from "./types";

/** Normalized (trimmed, lowercased) query; empty when find is closed. */
export const ThreadFindContext = createContext("");

export function useThreadFindQuery(): string {
  return useContext(ThreadFindContext);
}

export function normalizeFindQuery(query: string): string {
  return query.trim().toLowerCase();
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "number") return String(value);
  // ReactNode bodies (prototype fixtures) carry no searchable model text.
  if (typeof value === "object" && "$$typeof" in value) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** The searchable text a message contributes (subagent threads excluded). */
export function messageSearchText(message: Message): string {
  switch (message.type) {
    case "user":
    case "system":
      return [message.label, message.text].map(text).join("\n");
    case "agent":
      return [
        message.speaker,
        message.prose,
        ...(message.tools ?? []).map(messageSearchText),
      ]
        .map(text)
        .join("\n");
    case "tool":
      return [
        message.name,
        message.cmd,
        message.args,
        message.summary,
        message.rawInput ?? message.activityInput?.input,
        message.recordedResult ?? message.body,
      ]
        .map(text)
        .join("\n");
    case "wait":
      return text(message.text);
    case "error":
      return [message.title, message.sub].map(text).join("\n");
    case "result":
      return [message.label, message.body].map(text).join("\n");
    case "activity":
      return [message.label, message.text].join("\n");
    case "gate_evaluation":
      return text(message.verdict);
    case "resolution_submission":
      return [message.artifact, text(message.values)].join("\n");
    case "spawn":
      return [message.thread.label, message.thread.spawnLabel]
        .map(text)
        .join("\n");
  }
}

export function messageMatches(message: Message, query: string): boolean {
  if (!query) return false;
  if (messageSearchText(message).toLowerCase().includes(query)) return true;
  return message.type === "spawn" && threadMatches(message.thread, query);
}

const threadMatchCache = new WeakMap<Thread, Map<string, boolean>>();

/** Whether the thread's label or any (nested) message matches. Memoized. */
export function threadMatches(thread: Thread, query: string): boolean {
  if (!query) return false;
  let byQuery = threadMatchCache.get(thread);
  const cached = byQuery?.get(query);
  if (cached !== undefined) return cached;

  const label = [thread.label, thread.step?.to].map(text).join("\n");
  const matches =
    label.toLowerCase().includes(query) ||
    (thread.turns ?? []).some((turn) =>
      (turn.messages ?? []).some((message) => messageMatches(message, query))
    );

  if (!byQuery) {
    byQuery = new Map();
    threadMatchCache.set(thread, byQuery);
  }
  byQuery.set(query, matches);
  return matches;
}
