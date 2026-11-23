import { useState, type ComponentProps } from "react";
import { LocalChatMiniPanel } from "../components/ChatWindow/LocalChatMiniPanel";

type PanelProps = ComponentProps<typeof LocalChatMiniPanel>;

/** The sidebar with the manager-owned "Show completed" preference held locally. */
export function StatefulMiniPanel(
  props: Omit<PanelProps, "showCompleted" | "onShowCompletedChange"> &
    Partial<Pick<PanelProps, "showCompleted" | "onShowCompletedChange">>
) {
  const [showCompleted, setShowCompleted] = useState(false);
  return (
    <LocalChatMiniPanel
      showCompleted={showCompleted}
      onShowCompletedChange={setShowCompleted}
      {...props}
    />
  );
}
