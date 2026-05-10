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
      glowColor="from-primary/0 via-primary/30 to-primary/0"
    >
      <LiveChatWindow />
    </ResizablePanel>
  );
}
