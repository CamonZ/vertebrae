import { useLiveChatStore } from "../../stores/liveChatStore";
import { ResizablePanel } from "../ResizablePanel";
import { LiveChatWindow } from "./LiveChatWindow";

export function LiveChatPanel() {
  const panelOpen = useLiveChatStore((s) => s.panelOpen);
  if (!panelOpen) return null;

  return (
    <ResizablePanel
      storageKey="live-chat-panel-width"
      defaultWidth={420}
      minWidth={320}
      glowColor="from-accent/0 via-accent/30 to-accent/0"
    >
      <LiveChatWindow />
    </ResizablePanel>
  );
}
