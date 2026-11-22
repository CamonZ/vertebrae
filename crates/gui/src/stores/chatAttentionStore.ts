import { create } from "zustand";
import type {
  ChatAttentionRecord,
  TurnDecision,
} from "../utils/chatAttention";

/**
 * Turn-end decisions and viewed markers per chat. Decisions are runtime
 * state (the durable answer lives in the chat catalog); the viewed marker is
 * saved locally so a turn the user already read stays quiet after restart.
 */
const VIEWED_STORAGE_KEY = "vertebrae-chat-attention-viewed-v1";
/** Bounded: the oldest viewed markers are dropped first. */
const MAX_VIEWED = 512;

type ViewedMarkers = Record<string, string>;

function loadViewed(): ViewedMarkers {
  try {
    const raw = localStorage.getItem(VIEWED_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

function saveViewed(viewed: ViewedMarkers) {
  try {
    const entries = Object.entries(viewed);
    localStorage.setItem(
      VIEWED_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(-MAX_VIEWED)))
    );
  } catch (error) {
    console.warn("[chat_attention] could not save viewed markers", error);
  }
}

const EMPTY_DECISIONS: Readonly<Record<string, TurnDecision>> = {};

interface ChatAttentionStore {
  decisions: Readonly<Record<string, Readonly<Record<string, TurnDecision>>>>;
  viewed: Readonly<ViewedMarkers>;
  /** Record the decision for one completed turn of a chat. */
  setTurnDecision: (
    sessionId: string,
    turnKey: string,
    decision: TurnDecision
  ) => void;
  /** The user has seen the chat's latest completed turn. */
  markTurnViewed: (sessionId: string, turnKey: string) => void;
  /** Forget a chat's runtime decisions (its viewed marker is kept). */
  forgetSession: (sessionId: string) => void;
  reset: () => void;
}

export const useChatAttentionStore = create<ChatAttentionStore>()((set) => ({
  decisions: {},
  viewed: loadViewed(),
  setTurnDecision: (sessionId, turnKey, decision) =>
    set((state) => {
      const current = state.decisions[sessionId] ?? EMPTY_DECISIONS;
      if (current[turnKey] === decision) return state;
      return {
        decisions: {
          ...state.decisions,
          [sessionId]: { ...current, [turnKey]: decision },
        },
      };
    }),
  markTurnViewed: (sessionId, turnKey) =>
    set((state) => {
      if (state.viewed[sessionId] === turnKey) return state;
      // Re-insert so the newest markers survive the bound.
      const rest = Object.fromEntries(
        Object.entries(state.viewed).filter(([id]) => id !== sessionId)
      );
      const viewed = { ...rest, [sessionId]: turnKey };
      saveViewed(viewed);
      return { viewed };
    }),
  forgetSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.decisions)) return state;
      const decisions = { ...state.decisions };
      delete decisions[sessionId];
      return { decisions };
    }),
  reset: () => set({ decisions: {} }),
}));

/** The attention record of one chat, as `deriveChatAttention` reads it. */
export function chatAttentionRecord(
  state: Pick<ChatAttentionStore, "decisions" | "viewed">,
  sessionId: string
): ChatAttentionRecord {
  return {
    decisions: state.decisions[sessionId] ?? EMPTY_DECISIONS,
    viewedTurnKey: state.viewed[sessionId] ?? null,
  };
}
