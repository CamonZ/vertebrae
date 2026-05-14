import { popOut } from "./popOut";
import { useLiveChatStore } from "../stores/liveChatStore";

/**
 * Detach the embedded live chat into a standalone webview window.
 *
 * Idempotent — repeated calls focus the existing window rather than spawning
 * duplicates. After detaching we close the embedded panel so the user is not
 * looking at the same chat surface in two places.
 */
export async function detachLiveChat(): Promise<void> {
  await popOut("/live-chat", "live-chat", {
    title: "Live Chat",
    width: 480,
    height: 720,
  });
  useLiveChatStore.getState().setPanelOpen(false);
}
