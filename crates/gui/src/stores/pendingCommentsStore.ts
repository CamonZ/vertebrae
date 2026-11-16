import { create } from "zustand";
import type { PendingComment } from "../components/ChatWindow/assistantTextComments";

/**
 * Comments staged for the next reply, per chat scope (session + worktree).
 * They live outside the chat window so closing the panel by accident (Escape,
 * ⌥⌥) or switching conversations does not throw them away; they are cleared
 * when the reply carrying them is sent or the conversation is deleted. A
 * conversation that moves to another worktree keeps its earlier worktree's
 * comments while the conversation lives.
 */
interface PendingCommentsState {
  byScope: Record<string, PendingComment[]>;
  update(
    scope: string,
    update: (comments: PendingComment[]) => PendingComment[]
  ): void;
  /** Drop every scope of a deleted conversation. */
  clearSession(sessionId: string): void;
}

const NONE: PendingComment[] = [];

export const usePendingCommentsStore = create<PendingCommentsState>((set) => ({
  byScope: {},
  update: (scope, update) =>
    set((state) => {
      const current = state.byScope[scope] ?? NONE;
      const next = update(current);
      // Nothing staged before or after (e.g. a send without comments).
      if (next === current || (!next.length && !current.length)) return state;
      const byScope = { ...state.byScope };
      if (next.length) byScope[scope] = next;
      else delete byScope[scope];
      return { byScope };
    }),
  clearSession: (sessionId) =>
    set((state) => {
      const prefix = `${sessionId}:`;
      const kept = Object.entries(state.byScope).filter(
        ([scope]) => !scope.startsWith(prefix)
      );
      if (kept.length === Object.keys(state.byScope).length) return state;
      return { byScope: Object.fromEntries(kept) };
    }),
}));

export function usePendingComments(scope: string): PendingComment[] {
  return usePendingCommentsStore((state) => state.byScope[scope] ?? NONE);
}
