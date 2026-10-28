import { createContext } from "react";

/** Persistent root ChatSession.id that tool-call annotations are keyed by. */
export const ChatSessionContext = createContext<string | null>(null);
