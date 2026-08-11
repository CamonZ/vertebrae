import { useDebugStore } from "../stores/debugStore";

export type LocalChatTraceDirection =
  | "gui_to_tauri"
  | "tauri_to_gui"
  | "harness_to_provider"
  | "provider_to_harness"
  | "internal";

export interface LocalChatTraceInput {
  source: string;
  kind: string;
  direction?: LocalChatTraceDirection;
  sessionId?: string | null;
  backendSessionId?: string | null;
  turnId?: string | null;
  state?: string | null;
  detail?: string | null;
  payload?: string | null;
}

/**
 * Local-only diagnostics for tracing a chat from the webview to the provider.
 * Trace records intentionally live in the debug store, never in chat history.
 */
export function recordLocalChatTrace(input: LocalChatTraceInput): void {
  useDebugStore.getState().addTrace({
    ...input,
    sessionId: input.sessionId ?? undefined,
    backendSessionId: input.backendSessionId ?? undefined,
    turnId: input.turnId ?? undefined,
    state: input.state ?? undefined,
    detail: input.detail ?? undefined,
    payload: input.payload ?? undefined,
  });
}
