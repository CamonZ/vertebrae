import { create } from "zustand";

/** The updater channel configured for this GUI build. */
export const GUI_UPDATE_CHANNEL = "release";

export interface GuiUpdateInfo {
  /** Optional for compatibility with one-shot callers; schedulers normalize it. */
  channel?: string;
  currentVersion: string;
  version: string;
}

export type GuiUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "error";

export interface GuiUpdateState {
  /** The result of the last successful signed manifest check, if any. */
  available: GuiUpdateInfo | null;
  /** The GUI version reported by the last successful check. */
  currentVersion: string | null;
  /** Whether a signed manifest check is currently in flight. */
  checking: boolean;
  /** The latest optional-check failure, without clearing the known result. */
  error: string | null;
  status: GuiUpdateStatus;
}

export const initialGuiUpdateState: GuiUpdateState = {
  available: null,
  currentVersion: null,
  checking: false,
  error: null,
  status: "idle",
};

export const useGuiUpdateStore = create<GuiUpdateState>()(() => ({
  ...initialGuiUpdateState,
}));

export function resetGuiUpdateState(): void {
  useGuiUpdateStore.setState(initialGuiUpdateState);
}
