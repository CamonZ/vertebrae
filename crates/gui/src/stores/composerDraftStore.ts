import { create } from "zustand";

/**
 * Unsent composer text per chat session. It lives outside the chat window so
 * a remount (split or maximize, a pane switching layout) does not drop what
 * the user was typing; sending clears it.
 */
interface ComposerDraftState {
  bySession: Record<string, string>;
  setDraft(sessionId: string, text: string): void;
}

export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  bySession: {},
  setDraft: (sessionId, text) =>
    set((state) => {
      if ((state.bySession[sessionId] ?? "") === text) return state;
      const bySession = { ...state.bySession };
      if (text) bySession[sessionId] = text;
      else delete bySession[sessionId];
      return { bySession };
    }),
}));
