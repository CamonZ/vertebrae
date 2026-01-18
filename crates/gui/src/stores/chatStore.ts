import { create } from "zustand";

/**
 * Session state for PTY session management
 */
export type PtySessionState = "idle" | "starting" | "running" | "ended" | "error";

/**
 * Chat store for global PTY session state
 */
export interface ChatStore {
  /** Current session state */
  sessionState: PtySessionState;
  /** Set the session state */
  setSessionState: (state: PtySessionState) => void;
  /** Whether the session is active (running) */
  isActive: () => boolean;
}

/**
 * Zustand store for chat session state.
 * This allows the sidebar to show an active indicator when a PTY session is running.
 */
export const useChatStore = create<ChatStore>((set, get) => ({
  sessionState: "idle",
  setSessionState: (state) => set({ sessionState: state }),
  isActive: () => get().sessionState === "running",
}));
