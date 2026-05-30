import { Icon } from "../atoms/Icon";
import { Tooltip } from "../atoms/Tooltip";
import { useLiveChatStore } from "../../stores/liveChatStore";
import { useStyleguideStore } from "../../stores/styleguideStore";

interface OpenLiveChatButtonProps {
  className?: string;
}

export function OpenLiveChatButton({
  className = "",
}: OpenLiveChatButtonProps) {
  const isVisible = useStyleguideStore((s) => s.isLiveChatButtonVisible);
  const panelOpen = useLiveChatStore((s) => s.panelOpen);
  const togglePanel = useLiveChatStore((s) => s.togglePanel);

  if (!isVisible) return null;

  const label = panelOpen ? "Close live chat" : "Open live chat";

  return (
    <Tooltip label={label}>
      <button
        onClick={togglePanel}
        aria-pressed={panelOpen}
        aria-label={label}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-bg-3)] ${
          panelOpen
            ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
            : "text-[var(--color-fg-soft)] hover:text-[var(--color-fg)]"
        } ${className}`}
      >
        <Icon size="sm">
          <path d="M3 10c0-3.866 4.03-7 9-7s9 3.134 9 7-4.03 7-9 7c-1.13 0-2.21-.16-3.21-.46L3 19l1.46-4.79C3.55 12.93 3 11.52 3 10z" />
        </Icon>
      </button>
    </Tooltip>
  );
}
