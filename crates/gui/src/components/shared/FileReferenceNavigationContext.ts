import { createContext } from "react";

export interface FileTarget {
  root: string | null;
  path: string;
  line: number | null;
  column: number | null;
  history?: { sessionId: string; turnId: string | null };
}

export const FileReferenceNavigationContext = createContext<
  ((target: FileTarget) => void) | null
>(null);
