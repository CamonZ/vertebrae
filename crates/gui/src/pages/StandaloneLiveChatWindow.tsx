import { WindowLayout } from "../components/WindowLayout";
import { LiveChatWindow } from "../components/LiveChatWindow";

/**
 * Standalone page rendered by the `/live-chat` pop-out window.
 *
 * Each Tauri webview runs in its own JS process so this window has its own
 * `useLiveChatStore` instance — it bootstraps from `loadSessions()` /
 * `loadResumableSessionId()` inside LiveChatWindow on mount, identical to the
 * embedded panel. Backend events flow into every window's store via the
 * GlobalListeners mounted by `WindowLayout`.
 */
export function StandaloneLiveChatWindow() {
  return (
    <WindowLayout>
      <LiveChatWindow standalone />
    </WindowLayout>
  );
}
